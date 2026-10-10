// Unit tests for lock leases (SPEC §5): a holder keeps its lock fresh while it holds it, however long
// (a group move waiting for a `.cursor.lock`), and loses it once it stops refreshing. Also: break files
// that a folder move carries (DELTA-REVIEW-3 E5). No process inspection anywhere: only file mtimes.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { SECOND_LOOK_MS, sleep, STALE_MS } from '../../src/core/freshness.js'
import { LEASE_REFRESH_MS, LOCK_MAX_HOLD_MS, refreshLease, startLease } from '../../src/core/lease.js'
import { breakStaleLock, isTaken, withLock } from '../../src/core/lock.js'
import { errno, tmpDir, until } from '../helpers/env.js'
import { ageFile, fileAge, writeLockFile } from '../helpers/state.js'

describe('lock lease', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('a holder refreshes its lock during a long hold, so a waiter never breaks it', async () => {
        const lock = path.join(tmpDir('lease'), 'x.lock')
        await withLock(lock, async () => {
            const content = fs.readFileSync(lock, 'utf8')
            // As if the hold had lasted a minute: only the refresh can make the lock fresh again.
            ageFile(lock, STALE_MS * 6)
            await until(() => fileAge(lock) < STALE_MS, LEASE_REFRESH_MS * 3)
            expect(await breakStaleLock(lock, content)).toBe(false)
            expect(fs.readFileSync(lock, 'utf8')).toBe(content)
        })
        expect(fs.existsSync(lock)).toBe(false)
    })

    it('a holder that stops refreshing loses its lock once it is older than STALE_MS', async () => {
        const lock = path.join(tmpDir('stopped'), 'x.lock')
        await withLock(lock, async () => {
            const content = fs.readFileSync(lock, 'utf8')
            // The holder hangs: its refresh never lands any more.
            vi.spyOn(fsp, 'utimes').mockResolvedValue(undefined)
            ageFile(lock, STALE_MS + 1_000)
            await sleep(LEASE_REFRESH_MS + 500)
            expect(await breakStaleLock(lock, content)).toBe(true)
        })
        // The holder's release finds another state and removes nothing it does not own.
        expect(fs.existsSync(lock)).toBe(false)
    })

    it('a waiter takes a second look before a break: a refresh during it keeps the lock of its holder', async () => {
        const lock = path.join(tmpDir('look'), 'x.lock')
        // The holder's laptop slept: its lock looks a minute old when the waiter first reads it.
        const content = writeLockFile(lock, 'sleeper', { ageMs: STALE_MS * 6 })
        let got = false
        // Know when the waiter has read the stale lock (its first look).
        const realReadFile = fsp.readFile
        let looked = false
        vi.spyOn(fsp, 'readFile').mockImplementation(async (file, opts) => {
            if (String(file) === lock) looked = true
            return await realReadFile(file, opts)
        })
        const waiter = withLock(lock, async () => {
            got = true
        })
        await until(() => looked)
        // The holder wakes up and refreshes while the waiter takes its second look.
        await sleep(300)
        const now = new Date()
        fs.utimesSync(lock, now, now)
        await sleep(SECOND_LOOK_MS + 500)
        expect(got).toBe(false)
        expect(fs.readFileSync(lock, 'utf8')).toBe(content)
        // The holder releases; the waiter takes the lock.
        fs.rmSync(lock)
        await waiter
        expect(got).toBe(true)
    })

    it('a holder stops refreshing after LOCK_MAX_HOLD_MS, so a hung holder cannot block forever', async () => {
        expect(LOCK_MAX_HOLD_MS).toBe(60_000)
        const lock = path.join(tmpDir('maxhold'), 'x.lock')
        writeLockFile(lock, 'hung', { ageMs: STALE_MS * 2 })
        const stop = startLease(lock, 'hung', 50, 300)
        await until(() => fileAge(lock) < 1_000, 1_000)
        await sleep(400)
        ageFile(lock, STALE_MS * 2)
        await sleep(200)
        stop()
        expect(fileAge(lock)).toBeGreaterThan(STALE_MS)
    })

    it('a lock whose mtime is far in the future (clock set back, touch -d) breaks after the second look', async () => {
        const lock = path.join(tmpDir('future'), 'x.lock')
        writeLockFile(lock, 'future', { ageMs: -60_000 })
        const started = Date.now()
        await withLock(lock, async () => {})
        expect(Date.now() - started).toBeLessThan(SECOND_LOOK_MS + 3_000)
    })

    it('a tomb rename that Windows keeps blocking is retried on the next round, never a failure', async () => {
        const lock = path.join(tmpDir('busy'), 'x.lock')
        writeLockFile(lock, 'S', { ageMs: STALE_MS * 6 })
        const realRename = fsp.rename
        let blocked = 0
        vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
            // The first break attempt stays blocked through all its retries (renameRetry: 7 tries).
            if (String(b).endsWith('.tomb') && String(a) === lock && blocked < 7) {
                blocked++
                throw errno('EBUSY')
            }
            return await realRename(a, b)
        })
        await withLock(lock, async () => {})
        expect(blocked).toBe(7)
    })

    it('a create refused with a busy code means "taken" on Windows only (a name still delete pending)', () => {
        expect(isTaken(errno('EEXIST'), 'linux')).toBe(true)
        expect(isTaken(errno('EPERM'), 'win32')).toBe(true)
        expect(isTaken(errno('EBUSY'), 'win32')).toBe(true)
        expect(isTaken(errno('EPERM'), 'linux')).toBe(false)
        expect(isTaken(errno('ENOSPC'), 'win32')).toBe(false)
    })

    it('a refresh touches only a lock that still holds its token', async () => {
        const lock = path.join(tmpDir('token'), 'x.lock')
        writeLockFile(lock, 'theirs', { ageMs: STALE_MS * 2 })
        expect(await refreshLease(lock, 'mine')).toBe('lost')
        expect(fileAge(lock)).toBeGreaterThan(STALE_MS)
        expect(await refreshLease(lock, 'theirs')).toBe('refreshed')
        expect(fileAge(lock)).toBeLessThan(STALE_MS)
        expect(await refreshLease(path.join(tmpDir('none'), 'x.lock'), 'mine')).toBe('gone')
    })

    it('a moved lock leaves no break lock or tomb of its old path in the new folder (E5)', async () => {
        const dir = tmpDir('carry')
        const [from, to] = [path.join(dir, 'a'), path.join(dir, 'b')]
        const lockIn = (d: string) => path.join(d, '.cursor.lock')
        // A breaker at the old path holds a fresh break lock, and a tomb of its break is still there.
        writeLockFile(`${lockIn(from)}.break`, 'B')
        fs.writeFileSync(`${lockIn(from)}.0d1f.tomb`, 'old')
        fs.writeFileSync(path.join(from, 'agent.json'), '{}')
        await withLock(lockIn(from), async () => await fsp.rename(from, to), {
            mkdir: false,
            releaseAt: () => lockIn(to),
        })
        expect(fs.readdirSync(to)).toEqual(['agent.json'])
        // The next breaker in the new folder never waits for a carried break lock.
        const stale = writeLockFile(lockIn(to), 'S', { ageMs: STALE_MS + 1_000 })
        expect(await breakStaleLock(lockIn(to), stale)).toBe(true)
    })
})
