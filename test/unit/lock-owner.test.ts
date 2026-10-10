// Unit tests for lock staleness (DELTA-REVIEW-2 D3, D4, N4; SPEC §5 leases): a lock is stale only when
// nobody refreshed it for LOCK_STALE_MS (or this process abandoned it), breakers are serialized so a fresh
// lock is never moved, and a lock that moves with its folder is released where it is now.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SECOND_LOOK_MS } from '../../src/core/heartbeat.js'
import { breakStaleLock, LOCK_STALE_MS, parseLockOwner, sleep, withLock } from '../../src/core/lock.js'
import { errno, tmpDir, until } from '../helpers/env.js'
import { ageFile, writeLockFile } from '../helpers/state.js'

// Purpose: tell whether `lock` exists and holds something other than `stale` (a new holder took it).
function heldByOther(lock: string, stale: string): boolean {
    return fs.existsSync(lock) && fs.readFileSync(lock, 'utf8') !== stale
}

// Purpose: run `fn` as one holder of `lock` and record the most holders seen at once in `count`.
function holder(lock: string, count: { now: number; most: number }, ms: number) {
    return withLock(lock, async () => {
        count.most = Math.max(count.most, ++count.now)
        await sleep(ms)
        count.now--
    })
}

describe('lock owner', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('reads the current owner line and the two older ones, and nothing else', () => {
        expect(parseLockOwner('t 2026-10-10T00:00:00.000Z\n')).toEqual({ token: 't' })
        expect(parseLockOwner('t 42 9001 2026-10-10T00:00:00.000Z\n')).toEqual({ token: 't' })
        expect(parseLockOwner('t 42 - 2026\n')).toEqual({ token: 't' })
        expect(parseLockOwner('t 42 2026-10-10T00:00:00.000Z\n')).toEqual({ token: 't' })
        expect(parseLockOwner('')).toBeNull()
        expect(parseLockOwner('old')).toBeNull()
        expect(parseLockOwner('t x - 2026')).toBeNull()
        expect(parseLockOwner('a b c d e')).toBeNull()
    })

    it('a lock refreshed within LOCK_STALE_MS is never broken; one not refreshed for longer is (D4)', async () => {
        const lock = path.join(tmpDir('age'), 'x.lock')
        const fresh = writeLockFile(lock, 'held', { ageMs: LOCK_STALE_MS - 2_000 })
        expect(await breakStaleLock(lock, fresh)).toBe(false)
        expect(fs.readFileSync(lock, 'utf8')).toBe(fresh)
        ageFile(lock, LOCK_STALE_MS + 1_000)
        expect(await breakStaleLock(lock, fresh)).toBe(true)
        expect(fs.readdirSync(path.dirname(lock))).toEqual([])
    })

    it('a waiter takes a lock its holder stopped refreshing, without waiting for its own timeout', async () => {
        const lock = path.join(tmpDir('dead'), 'x.lock')
        writeLockFile(lock, 'crashed', { ageMs: LOCK_STALE_MS + 1_000 })
        const started = Date.now()
        await withLock(lock, async () => {})
        // Only the second look (SECOND_LOOK_MS) and the backoff, never the 15 s lock timeout.
        expect(Date.now() - started).toBeLessThan(SECOND_LOOK_MS + 2_000)
        expect(fs.readdirSync(path.dirname(lock))).toEqual([])
    })

    it('a lock left by an older server (pid in its owner line) breaks by the same age rule', async () => {
        for (const legacy of ['round2', 'round3'] as const) {
            const lock = path.join(tmpDir('legacy'), 'x.lock')
            const content = writeLockFile(lock, 'old', { legacy })
            expect(await breakStaleLock(lock, content)).toBe(false)
            ageFile(lock, LOCK_STALE_MS + 1_000)
            expect(await breakStaleLock(lock, content)).toBe(true)
        }
    })

    it('a lock this process failed to remove on release breaks at once for its next caller', async () => {
        const lock = path.join(tmpDir('rmfail'), 'x.lock')
        vi.spyOn(fsp, 'rm').mockRejectedValueOnce(errno('EIO'))
        await expect(withLock(lock, async () => {})).rejects.toThrow('EIO')
        expect(fs.existsSync(lock)).toBe(true)
        vi.restoreAllMocks()
        const started = Date.now()
        await withLock(lock, async () => {})
        expect(Date.now() - started).toBeLessThan(2_000)
        expect(fs.readdirSync(path.dirname(lock))).toEqual([])
    })

    it('a lock file whose owner line could not be written is removed at once, never left empty', async () => {
        const lock = path.join(tmpDir('torn'), 'x.lock')
        const realOpen = fsp.open
        vi.spyOn(fsp, 'open').mockImplementationOnce(async (...args: Parameters<typeof fsp.open>) => {
            const fh = await realOpen(...args)
            fh.writeFile = async () => {
                throw errno('ENOSPC')
            }
            return fh
        })
        await expect(withLock(lock, async () => {})).rejects.toMatchObject({ code: 'SUMMIT_IO' })
        expect(fs.existsSync(lock)).toBe(false)
    })

    it('a waiter late to a break never moves the fresh lock, so a third waiter never joins its holder (D3)', async () => {
        const lock = path.join(tmpDir('two'), 'x.lock')
        const stale = writeLockFile(lock, 'S', { ageMs: LOCK_STALE_MS * 6 })
        const count = { now: 0, most: 0 }
        const w2 = holder(lock, count, 300)
        // w2 broke the stale lock (after its second look) and holds a fresh one.
        await until(() => heldByOther(lock, stale))
        // A third waiter arrives exactly in the gap a break would open between its rename and link back.
        const realLink = fsp.link
        let w3: Promise<void> | undefined
        vi.spyOn(fsp, 'link').mockImplementation(async (a, b) => {
            w3 = holder(lock, count, 100)
            await sleep(30)
            return await realLink(a, b)
        })
        expect(await breakStaleLock(lock, stale)).toBe(false)
        await Promise.all([w2, w3])
        expect(count.most).toBe(1)
        expect(fs.readdirSync(path.dirname(lock))).toEqual([])
    })

    it('a waiter late to a break never puts back a lock its holder already released (no orphan, D3)', async () => {
        const lock = path.join(tmpDir('orphan'), 'x.lock')
        const stale = writeLockFile(lock, 'S', { ageMs: LOCK_STALE_MS * 6 })
        let release = () => {}
        const w2 = withLock(lock, () => new Promise<void>((r) => (release = r)))
        await until(() => heldByOther(lock, stale))
        const realLink = fsp.link
        vi.spyOn(fsp, 'link').mockImplementation(async (a, b) => {
            release()
            await w2
            return await realLink(a, b)
        })
        await breakStaleLock(lock, stale)
        release()
        await w2
        expect(fs.existsSync(lock)).toBe(false)
        const started = Date.now()
        await withLock(lock, async () => {})
        expect(Date.now() - started).toBeLessThan(2_000)
    })

    it('two waiters that both saw one stale lock break it one after the other: nothing is ever put back (D3)', async () => {
        const lock = path.join(tmpDir('pair'), 'x.lock')
        writeLockFile(lock, 'S', { ageMs: LOCK_STALE_MS * 6 })
        const realRename = fsp.rename
        let paused = false
        // The first break pauses between its checks and its rename, the widest gap a breaker has.
        vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
            if (a === lock && !paused) {
                paused = true
                await sleep(200)
            }
            return await realRename(a, b)
        })
        const link = vi.spyOn(fsp, 'link')
        const count = { now: 0, most: 0 }
        await Promise.all([holder(lock, count, 300), holder(lock, count, 300)])
        expect(paused).toBe(true)
        expect(link).not.toHaveBeenCalled()
        expect(count.most).toBe(1)
        expect(fs.readdirSync(path.dirname(lock))).toEqual([])
    })

    it('breakers wait for the break lock; a break lock older than LOCK_STALE_MS is removed (D3)', async () => {
        const lock = path.join(tmpDir('brk'), 'x.lock')
        const stale = writeLockFile(lock, 'S', { ageMs: LOCK_STALE_MS * 6 })
        // A breaker is inside its break: its break lock is fresh, so nobody else breaks now.
        writeLockFile(`${lock}.break`, 'B')
        expect(await breakStaleLock(lock, stale)).toBe(false)
        expect(fs.readFileSync(lock, 'utf8')).toBe(stale)
        // The same break lock after LOCK_STALE_MS (a break takes a few file operations): removed.
        ageFile(`${lock}.break`, LOCK_STALE_MS + 1000)
        expect(await breakStaleLock(lock, stale)).toBe(false)
        expect(await breakStaleLock(lock, stale)).toBe(true)
        expect(fs.readdirSync(path.dirname(lock))).toEqual([])
    })

    it('a lock that moved with its folder is released at its new path, and where it was on failure (N4)', async () => {
        const dir = tmpDir('move')
        const [from, to] = [path.join(dir, 'a'), path.join(dir, 'b')]
        fs.mkdirSync(from)
        const lockIn = (d: string) => path.join(d, '.cursor.lock')
        const moved = await withLock(lockIn(from), async () => (await fsp.rename(from, to), 'moved'), {
            mkdir: false,
            releaseAt: () => lockIn(to),
        })
        expect(moved).toBe('moved')
        expect(fs.readdirSync(to)).toEqual([])
        const failed = withLock(
            lockIn(to),
            async () => {
                throw new Error('move failed')
            },
            { mkdir: false, releaseAt: () => lockIn(from) },
        )
        await expect(failed).rejects.toThrow('move failed')
        expect(fs.readdirSync(to)).toEqual([])
    })
})
