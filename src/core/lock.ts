// Lock files (SPEC §5): O_EXCL create, retry with backoff. Used by members.json (`members.lock`) and
// the per-agent read lock (`.cursor.lock`).
//
// Each holder writes one owner line into its lock: a random token, its pid and the pid's start time
// (`<token> <pid> <start|-> <ISO time>`). A holder releases only its own token, so a holder never
// deletes another holder's lock (REVIEW m7).
//
// A lock is stale when its owner process is gone (D3, D4): the pid is dead, a zombie or now names
// another process (the one liveness probe, src/core/proc.ts isProcessAlive), or the owner is this
// process and no longer holds that token (a release that failed). A live owner keeps its lock however
// old it is, so a live holder can wait as long as it needs (a group move holds `members.lock` while it
// waits for a `.cursor.lock`). Age (LOCK_STALE_MS) decides only when the owner cannot be identified:
// a lock file without a readable owner line (a holder died between the create and the write), an
// owner whose liveness is unknown (DELTA-REVIEW-3 E2), an owner line without a start time whose pid
// runs (the pid may be reused, E3), and the break lock below.
//
// Breakers are serialized by a second lock, `<lock>.break`, so a breaker never moves a lock that
// another waiter took after an earlier break (D3). Under the break lock the waiter re-reads the lock,
// checks that it is still the stale file it saw, and renames it to a unique tomb (F10); the tomb is
// removed when it holds that content, else it is linked back. The break lock is held only for these
// few file operations, so it may go stale by age as well as by owner death. Breaking a stale break
// lock is not serialized itself: that is a known limit (SPEC §5, E4).
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { hasErrno, summitError } from './errors.js'
import { readTextFile } from './fsx.js'
import { log } from './log.js'
import { isProcessAlive, processStartTime } from './proc.js'

export const LOCK_STALE_MS = 10_000
const LOCK_TIMEOUT_MS = 15_000

export interface LockOptions<T = unknown> {
    // Create the parent dir when missing (false for locks inside an agent folder that may have moved).
    mkdir?: boolean
    // Where the lock file is after `fn` succeeded, when `fn` moved the directory that holds it (a group
    // move renames an agent folder with its `.cursor.lock` inside). Default: where it was taken.
    releaseAt?: (result: T) => string
}

// The owner line of a lock file. `start` is null when /proc could not tell, or in the round-2 format
// (`<token> <pid> <ISO time>`), which is still read so a lock left by an older server breaks too. A
// lock without a start time breaks at once when its pid is gone, else by age (E3).
const LockOwnerSchema = z.object({
    token: z.string().min(1),
    pid: z.number().int().positive(),
    start: z.number().int().nonnegative().nullable(),
})
export type LockOwner = z.infer<typeof LockOwnerSchema>

// A lock file as read from disk: its content and its last write time.
interface LockFile {
    content: string
    mtimeMs: number
}

// The start time of this process once read (it never changes). A failed read is not kept: the next lock
// reads again, so one transient /proc error never turns every later lock into an age-only lock (G1).
let ownStart: number | null = null
// The tokens of the locks this process holds now. A lock file that names this process as its owner but
// holds a token that is not here was left behind by this process (its release failed): it is stale.
const heldTokens = new Set<string>()

// Purpose: wait `ms` milliseconds (the one sleep helper; tests import it too).
export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

// Purpose: the one owner line format (`<token> <pid> <start|-> <ISO time>`, parsed by parseLockOwner).
export function formatLockOwner(token: string, pid: number, start: number | null, at = new Date()): string {
    return `${token} ${pid} ${start ?? '-'} ${at.toISOString()}\n`
}

// Purpose: the owner line this process writes into a lock it takes.
function ownerLine(token: string): string {
    if (ownStart === null) ownStart = processStartTime(process.pid)
    return formatLockOwner(token, process.pid, ownStart)
}

// Purpose: read the owner of a lock file's content, or null when it has no valid owner line.
export function parseLockOwner(content: string): LockOwner | null {
    const f = content.trim().split(' ')
    if (f.length !== 3 && f.length !== 4) return null
    const start = f.length === 3 || f[2] === '-' ? null : Number(f[2])
    const parsed = LockOwnerSchema.safeParse({ token: f[0], pid: Number(f[1]), start })
    return parsed.success ? parsed.data : null
}

// Purpose: tell whether a lock file is stale: its owner process is gone, or it names this process with
// a token this process does not hold. When the owner cannot be identified (no owner line, liveness
// unknown (E2), or a running pid without a start time (E3)), it is stale once written more than
// LOCK_STALE_MS ago. With `byAge` (the break lock), age alone also makes it stale.
function isStale(lock: LockFile, byAge = false): boolean {
    const old = Date.now() - lock.mtimeMs > LOCK_STALE_MS
    const owner = parseLockOwner(lock.content)
    if (owner === null || (byAge && old)) return old
    if (owner.pid === process.pid) return !heldTokens.has(owner.token)
    const alive = isProcessAlive(owner.pid, owner.start)
    if (alive === false) return true
    if (alive === true && owner.start !== null) return false
    log('debug', 'isStale', 'owner cannot be identified; age rule', { pid: owner.pid, alive, old })
    return old
}

// Purpose: read a lock file, or null when it does not exist (also when its folder moved away).
async function readLock(lockPath: string): Promise<LockFile | null> {
    const content = await readTextFile(lockPath)
    const stat = await fs.stat(lockPath).catch(() => null)
    return content === null || stat === null ? null : { content, mtimeMs: stat.mtimeMs }
}

// Purpose: try once to create the lock with our owner line; true when we hold it. With `missingOk`, a
// missing parent folder reads as "not taken" instead of SUMMIT_IO.
// The token counts as held from before the create, so no other caller in this process ever reads the
// new file as an orphan of this process.
async function tryCreate(lockPath: string, token: string, missingOk = false): Promise<boolean> {
    heldTokens.add(token)
    let created = false
    try {
        const fh = await fs.open(lockPath, 'wx')
        created = true
        try {
            await fh.writeFile(ownerLine(token))
        } finally {
            await fh.close()
        }
        return true
    } catch (err) {
        heldTokens.delete(token)
        // A file without our owner line would block every waiter for LOCK_STALE_MS.
        if (created) await fs.rm(lockPath, { force: true }).catch(() => undefined)
        if (hasErrno(err, 'EEXIST') || (missingOk && hasErrno(err, 'ENOENT'))) return false
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
        await fs.rename(file, tomb)
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
    if (held !== null && isStale(held, true) && (await removeByTomb(breakPath, held.content))) {
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

// Purpose: break the lock when it is stale. True when this call removed it.
async function breakIfStale(lockPath: string): Promise<boolean> {
    const seen = await readLock(lockPath)
    return seen === null || !isStale(seen) ? false : await breakStaleLock(lockPath, seen.content)
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

// Purpose: release the lock only when it still holds our token. The token stops counting as held even
// when the release fails, so a lock file left behind is stale for every later caller in this process.
async function releaseLock(lockPath: string, token: string): Promise<void> {
    try {
        const content = await readTextFile(lockPath).catch((err) => {
            log('error', 'releaseLock', 'cannot read the lock; left in place', { lockPath, error: String(err) })
            return null
        })
        if (content !== null && content.startsWith(token + ' ')) {
            await fs.rm(lockPath, { force: true })
            return
        }
        log('warn', 'releaseLock', 'lock no longer ours; left in place', { lockPath })
    } finally {
        heldTokens.delete(token)
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

// Purpose: run `fn` while holding the lock file `lockPath` (N4: the one acquire-run-release). The lock
// is released at `opts.releaseAt(result)` when `fn` succeeded and moved the lock, else where it was
// taken. A moved lock leaves no break file of its old path behind in its new folder (E5).
export async function withLock<T>(lockPath: string, fn: () => Promise<T>, opts: LockOptions<T> = {}): Promise<T> {
    const token = await acquireLock(lockPath, opts.mkdir !== false)
    let releaseAt = lockPath
    try {
        const result = await fn()
        if (opts.releaseAt) releaseAt = opts.releaseAt(result)
        return result
    } finally {
        if (releaseAt !== lockPath) await dropCarriedBreakFiles(releaseAt)
        await releaseLock(releaseAt, token)
    }
}
