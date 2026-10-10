// Unit tests for lock staleness when the owner process cannot be identified for sure (DELTA-REVIEW-3
// E1, E2, E3), for break files that a folder move carries (E5), and for this process's own start time
// in the owner line (DELTA-REVIEW-4 G1).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { breakStaleLock, LOCK_STALE_MS, withLock } from '../../src/core/lock.js'
import { parseStat, processStartTime } from '../../src/core/proc.js'
import { deadPid, failProcReads, livePid, tmpDir, zombiePid } from '../helpers/env.js'
import { writeLockFile, type LockLineOptions } from '../helpers/state.js'

// Purpose: write a lock owned by `pid` in a fresh dir and tell whether a waiter breaks it, first while
// it is fresh and then once it is older than LOCK_STALE_MS.
async function breaksFreshAndOld(pid: number, opts: LockLineOptions): Promise<[boolean, boolean]> {
    const lock = path.join(tmpDir('ident'), 'x.lock')
    const content = writeLockFile(lock, 'T', pid, opts)
    const fresh = await breakStaleLock(lock, content)
    writeLockFile(lock, 'T', pid, { ...opts, ageMs: LOCK_STALE_MS + 1000 })
    return [fresh, await breakStaleLock(lock, content)]
}

describe('lock owner that cannot be identified', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('a lock whose owner is a zombie (killed, not reaped) breaks at once (E1)', async () => {
        const zombie = await zombiePid()
        const start = parseStat(fs.readFileSync(`/proc/${zombie}/stat`, 'utf8'))?.start ?? null
        expect(start).toEqual(expect.any(Number))
        for (const opts of [{ start }, { start: null }]) {
            const lock = path.join(tmpDir('zombie'), 'x.lock')
            writeLockFile(lock, 'Z', zombie, opts)
            const started = Date.now()
            expect(await withLock(lock, async () => 'got')).toBe('got')
            expect(Date.now() - started).toBeLessThan(2_000)
        }
    })

    it('a waiter without /proc never breaks a live lock by death, only by age (E2)', async () => {
        const pid = livePid()
        const start = processStartTime(pid)
        expect(start).toEqual(expect.any(Number))
        failProcReads('ENOENT')
        expect(await breaksFreshAndOld(pid, { start })).toEqual([false, true])
    })

    it('a lock without a start time whose pid runs breaks by age, never by the pid alone (E3)', async () => {
        // The pid may now name another process (reuse): a live `sleep` stands in for it.
        const pid = livePid()
        expect(await breaksFreshAndOld(pid, { start: null })).toEqual([false, true])
        expect(await breaksFreshAndOld(pid, { round2: true })).toEqual([false, true])
        // With a start time, a live owner keeps its lock however old (D4).
        expect(await breaksFreshAndOld(pid, { start: processStartTime(pid) })).toEqual([false, false])
    })

    it('a failed read of its own start time is read again at the next lock, never kept (G1)', async () => {
        // A fresh module: no earlier lock of this file has read the start time yet.
        vi.resetModules()
        const fresh = await import('../../src/core/lock.js')
        const lock = path.join(tmpDir('own'), 'x.lock')
        const ownerStart = () =>
            fresh.withLock(lock, async () => fresh.parseLockOwner(fs.readFileSync(lock, 'utf8'))?.start)
        failProcReads('EMFILE', `/proc/${process.pid}/stat`)
        expect(await ownerStart()).toBeNull()
        vi.restoreAllMocks()
        expect(await ownerStart()).toBe(processStartTime(process.pid))
    })

    it('a moved lock leaves no break lock or tomb of its old path in the new folder (E5)', async () => {
        const dir = tmpDir('carry')
        const [from, to] = [path.join(dir, 'a'), path.join(dir, 'b')]
        const lockIn = (d: string) => path.join(d, '.cursor.lock')
        // A live breaker at the old path holds the break lock, and a tomb of its break is still there.
        writeLockFile(`${lockIn(from)}.break`, 'B', livePid())
        fs.writeFileSync(`${lockIn(from)}.0d1f.tomb`, 'old')
        fs.writeFileSync(path.join(from, 'agent.json'), '{}')
        await withLock(lockIn(from), async () => await fsp.rename(from, to), {
            mkdir: false,
            releaseAt: () => lockIn(to),
        })
        expect(fs.readdirSync(to)).toEqual(['agent.json'])
        // The next breaker in the new folder never waits for a carried break lock.
        const stale = writeLockFile(lockIn(to), 'S', await deadPid())
        expect(await breakStaleLock(lockIn(to), stale)).toBe(true)
    })
})
