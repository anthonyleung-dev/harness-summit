// Lock files (SPEC §5): O_EXCL create, retry with backoff. Used by members.json (`members.lock`) and
// the per-agent read lock (`.cursor.lock`).
//
// Each holder writes one owner line into its lock: a random token and the time it took the lock
// (`<token> <ISO time>`). A holder releases only its own token, so a holder never deletes another
// holder's lock (REVIEW m7).
//
// A lock is a lease (src/core/lease.ts): right after the create and then every LEASE_REFRESH_MS while it
// holds the lock (for at most LOCK_MAX_HOLD_MS), the holder sets the lock file's mtime to now. A lock is
// stale when its mtime is older than LOCK_STALE_MS (its holder stopped refreshing: it died, or it hangs)
// and a second look confirms it (no refresh while the waiter waits SECOND_LOOK_MS, so a clock jump or a
// suspend never breaks a live holder), or when it holds a token that this process abandoned (its release
// failed). No OS process inspection is involved: the same rule runs on Linux, macOS and Windows.
//
// Breakers are serialized by a second lock, `<lock>.break`, so a breaker never moves a lock that
// another waiter took after an earlier break (D3). Under the break lock the waiter re-reads the lock,
// checks that it is still the stale file it saw, and renames it to a unique tomb (F10); the tomb is
// removed when it holds that content, else it is linked back. The break lock is held only for these
// few file operations and is not refreshed; it goes stale by age like any lock. Breaking a stale break
// lock is not serialized itself: that is a known limit (SPEC §5, E4).
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { hasErrno, summitError } from './errors.js'
import { readTextFile, renameRetry } from './fsx.js'
import { confirmGone } from './heartbeat.js'
import { startLease } from './lease.js'
import { log } from './log.js'

export const LOCK_STALE_MS = 10_000
const LOCK_TIMEOUT_MS = 15_000

export interface LockOptions<T = unknown> {
    // Create the parent dir when missing (false for locks inside an agent folder that may have moved).
    mkdir?: boolean
    // Where the lock file is after `fn` succeeded, when `fn` moved the directory that holds it (a group
    // move renames an agent folder with its `.cursor.lock` inside). Default: where it was taken.
    releaseAt?: (result: T) => string
}

// The owner of a lock file: its token. Older servers wrote `<token> <pid> <ISO time>` (round 2) and
// `<token> <pid> <start|-> <ISO time>` (round 3); both still parse, so their locks release and break
// by the same rules (their holders never refresh, so they break by age).
const LockOwnerSchema = z.object({ token: z.string().min(1) })
export type LockOwner = z.infer<typeof LockOwnerSchema>

// A lock file as read from disk: its content and its last write (or refresh) time.
interface LockFile {
    content: string
    mtimeMs: number
}

// Tokens of locks this process failed to remove on release. A lock file that holds one of them is
// stale at once for every later caller in this process: nobody refreshes or releases it any more.
const abandonedTokens = new Set<string>()

// Purpose: wait `ms` milliseconds (the one sleep helper; tests import it too).
export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

// Purpose: the one owner line format (`<token> <ISO time>`, parsed by parseLockOwner).
export function formatLockOwner(token: string, at = new Date()): string {
    return `${token} ${at.toISOString()}\n`
}

// Purpose: read the owner of a lock file's content, or null when it has no valid owner line. Accepts
// the current line and the two older ones (their pid field must be a positive integer).
export function parseLockOwner(content: string): LockOwner | null {
    const f = content.trim().split(' ')
    if (f.length < 2 || f.length > 4) return null
    if (f.length > 2 && !/^[1-9]\d*$/.test(f[1] ?? '')) return null
    const parsed = LockOwnerSchema.safeParse({ token: f[0] })
    return parsed.success ? parsed.data : null
}

// Purpose: tell whether a lock file is stale: not refreshed for LOCK_STALE_MS, or holding a token this
// process abandoned. A lock without a valid owner line (a holder died between the create and the
// write) is stale by the same age rule.
function isStale(lock: LockFile): boolean {
    if (isAbandoned(lock)) return true
    const age = Date.now() - lock.mtimeMs
    if (age > LOCK_STALE_MS) log('debug', 'isStale', 'lock not refreshed in time', { age })
    return age > LOCK_STALE_MS
}

// Purpose: read a lock file, or null when it does not exist (also when its folder moved away).
async function readLock(lockPath: string): Promise<LockFile | null> {
    const content = await readTextFile(lockPath)
    const stat = await fs.stat(lockPath).catch(() => null)
    return content === null || stat === null ? null : { content, mtimeMs: stat.mtimeMs }
}

// Errno codes that mean "the name is still taken" on Windows: after a release, a file system without
// POSIX delete semantics (FAT, exFAT, older NTFS drivers) keeps the name "delete pending" for a moment,
// and a create then fails with EPERM, not EEXIST (XPLAT-AUDIT D4). On Linux and macOS these codes are a
// real refusal and stay SUMMIT_IO.
const WIN_TAKEN = process.platform === 'win32' ? ['EPERM', 'EACCES', 'EBUSY'] : []

// Purpose: tell whether a create error means "another holder has the name" (retry later).
function isTaken(err: unknown): boolean {
    return hasErrno(err, 'EEXIST') || WIN_TAKEN.some((c) => hasErrno(err, c))
}

// Purpose: try once to create the lock with our owner line; true when we hold it. With `missingOk`, a
// missing parent folder reads as "not taken" instead of SUMMIT_IO.
async function tryCreate(lockPath: string, token: string, missingOk = false): Promise<boolean> {
    let created = false
    try {
        const fh = await fs.open(lockPath, 'wx')
        created = true
        try {
            await fh.writeFile(formatLockOwner(token))
            // The lease clock is ours from the start (also on a file system whose server sets the mtime).
            const now = new Date()
            await fh.utimes(now, now)
        } finally {
            await fh.close()
        }
        return true
    } catch (err) {
        // A file without our owner line would block every waiter for LOCK_STALE_MS.
        if (created) await fs.rm(lockPath, { force: true }).catch(() => undefined)
        if (isTaken(err) || (missingOk && hasErrno(err, 'ENOENT'))) return false
        throw summitError('SUMMIT_IO', `cannot create ${lockPath}`, 'tryCreate', { lockPath }, err)
    }
}

// Purpose: remove the file at `file` when it still holds `seen` (F10): rename it to a unique tomb
// (rename is atomic, so of several callers only one moves a given file), then check the tomb. When the
// tomb holds anything else, the caller moved a newer file: link it back (link fails instead of
// overwriting) and report false.
async function removeByTomb(file: string, seen: string): Promise<boolean> {
    const tomb = `${file}.${randomUUID()}.tomb`
    try {
        await renameRetry(file, tomb)
    } catch (err) {
        if (hasErrno(err, 'ENOENT')) return false
        throw summitError('SUMMIT_IO', `cannot break ${file}`, 'removeByTomb', { file }, err)
    }
    const moved = await readTextFile(tomb)
    if (moved !== seen) {
        await fs
            .link(tomb, file)
            .catch((err) =>
                log('error', 'removeByTomb', 'moved a newer lock and cannot put it back', { file, error: String(err) }),
            )
        await fs.rm(tomb, { force: true })
        log('warn', 'removeByTomb', 'lock changed before the break; put back', { file })
        return false
    }
    await fs.rm(tomb, { force: true })
    return true
}

// Purpose: take the break lock of `lockPath` and return its token, or null when another waiter holds
// it (a stale break lock is removed first, and the caller retries later).
async function takeBreakLock(lockPath: string): Promise<string | null> {
    const breakPath = `${lockPath}.break`
    const token = randomUUID()
    if (await tryCreate(breakPath, token, true)) return token
    const held = await readLock(breakPath)
    if (held !== null && isStale(held) && (await removeByTomb(breakPath, held.content))) {
        log('warn', 'takeBreakLock', 'broke a stale break lock', { breakPath, owner: held.content.trim() })
    }
    return null
}

// Purpose: break the stale lock whose content was `seen`. Runs under the break lock: the lock is
// removed only when it still holds `seen` and is still stale, so a fresh lock is never moved. True
// only when this call removed the stale lock.
export async function breakStaleLock(lockPath: string, seen: string): Promise<boolean> {
    const token = await takeBreakLock(lockPath)
    if (token === null) return false
    try {
        const now = await readLock(lockPath)
        if (now === null || now.content !== seen || !isStale(now)) return false
        const broke = await removeByTomb(lockPath, seen)
        if (broke) log('warn', 'breakStaleLock', 'broke stale lock', { lockPath, owner: seen.trim() })
        return broke
    } finally {
        await releaseLock(`${lockPath}.break`, token)
    }
}

// Purpose: tell whether a lock this process abandoned (no second look needed: nobody refreshes it).
function isAbandoned(lock: LockFile): boolean {
    const owner = parseLockOwner(lock.content)
    return owner !== null && abandonedTokens.has(owner.token)
}

// Purpose: break the lock when it is stale. A lock stale by age gets the second look first (a refresh
// meanwhile means its holder lives). True when this call removed it.
async function breakIfStale(lockPath: string): Promise<boolean> {
    const seen = await readLock(lockPath)
    if (seen === null || !isStale(seen)) return false
    if (!isAbandoned(seen) && !(await confirmGone(lockPath, seen.mtimeMs))) return false
    return await breakStaleLock(lockPath, seen.content)
}

// Purpose: take the lock and return our token, or fail with SUMMIT_LOCK_TIMEOUT.
async function acquireLock(lockPath: string, mkdir: boolean): Promise<string> {
    const token = randomUUID()
    const started = Date.now()
    let delay = 10
    if (mkdir) await fs.mkdir(path.dirname(lockPath), { recursive: true })
    for (;;) {
        if (await tryCreate(lockPath, token)) return token
        if (await breakIfStale(lockPath)) continue
        if (Date.now() - started > LOCK_TIMEOUT_MS) {
            log('error', 'acquireLock', 'lock timeout', { lockPath })
            throw summitError('SUMMIT_LOCK_TIMEOUT', `lock ${lockPath} is held`, 'acquireLock', { lockPath })
        }
        await sleep(delay + Math.floor(Math.random() * delay))
        delay = Math.min(delay * 2, 500)
    }
}

// Purpose: release the lock only when it still holds our token. When the remove fails, the token is
// abandoned: the file left behind is stale at once for every later caller in this process, and stale by
// age (no refresh) for every other process.
async function releaseLock(lockPath: string, token: string): Promise<void> {
    const content = await readTextFile(lockPath).catch((err) => {
        log('error', 'releaseLock', 'cannot read the lock; left in place', { lockPath, error: String(err) })
        abandonedTokens.add(token)
        return null
    })
    if (content === null) return
    if (!content.startsWith(token + ' ')) {
        log('warn', 'releaseLock', 'lock no longer ours; left in place', { lockPath })
        return
    }
    try {
        await fs.rm(lockPath, { force: true })
    } catch (err) {
        abandonedTokens.add(token)
        log('error', 'releaseLock', 'cannot remove the lock; abandoned', { lockPath, error: String(err) })
        throw err
    }
}

// Purpose: remove the break lock and the tombs that a folder move carried next to `lockPath` (E5). The
// caller holds `lockPath` at its new path, so no breaker there can hold its break lock: such a file
// belongs to a breaker at the old path, whose release there finds nothing, and it would make the next
// breaker here wait for its age.
async function dropCarriedBreakFiles(lockPath: string): Promise<void> {
    const dir = path.dirname(lockPath)
    const base = path.basename(lockPath)
    const names = await fs.readdir(dir).catch((err) => {
        log('warn', 'dropCarriedBreakFiles', 'cannot list the moved folder', { dir, error: String(err) })
        return [] as string[]
    })
    for (const name of names) {
        if (name !== `${base}.break` && !(name.startsWith(`${base}.`) && name.endsWith('.tomb'))) continue
        // Never throws: the release that follows must still run.
        await fs.rm(path.join(dir, name), { force: true }).then(
            () => log('warn', 'dropCarriedBreakFiles', 'removed a break file the move carried', { dir, name }),
            (err) =>
                log('error', 'dropCarriedBreakFiles', 'cannot remove a carried break file', {
                    dir,
                    name,
                    error: String(err),
                }),
        )
    }
}

// Purpose: run `fn` while holding the lock file `lockPath` (N4: the one acquire-run-release), and keep
// the lease fresh while `fn` runs (src/core/lease.ts). The lock is released at `opts.releaseAt(result)`
// when `fn` succeeded and moved the lock, else where it was taken. A moved lock is not refreshed after
// the move (its old path is gone), which is fine: the release follows at once. A moved lock leaves no break file of its old path behind in its new folder (E5).
export async function withLock<T>(lockPath: string, fn: () => Promise<T>, opts: LockOptions<T> = {}): Promise<T> {
    const token = await acquireLock(lockPath, opts.mkdir !== false)
    const stopLease = startLease(lockPath, token)
    let releaseAt = lockPath
    try {
        const result = await fn()
        if (opts.releaseAt) releaseAt = opts.releaseAt(result)
        return result
    } finally {
        stopLease()
        if (releaseAt !== lockPath) await dropCarriedBreakFiles(releaseAt)
        await releaseLock(releaseAt, token)
    }
}
