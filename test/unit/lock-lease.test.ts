// Unit tests for lock leases (SPEC §5): a holder keeps its lock fresh while it holds it, however long
// (a group move waiting for a `.cursor.lock`), and loses it once it stops refreshing. Also: break files
// that a folder move carries (DELTA-REVIEW-3 E5). No process inspection anywhere: only file mtimes.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LEASE_REFRESH_MS, refreshLease } from '../../src/core/lease.js'
import { breakStaleLock, LOCK_STALE_MS, sleep, withLock } from '../../src/core/lock.js'
import { tmpDir, until } from '../helpers/env.js'
import { ageFile, writeLockFile } from '../helpers/state.js'

// Purpose: age in ms of the file at `file`.
const ageOf = (file: string) => Date.now() - fs.statSync(file).mtimeMs

describe('lock lease', () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('a holder refreshes its lock during a long hold, so a waiter never breaks it', async () => {
        const lock = path.join(tmpDir('lease'), 'x.lock')
        await withLock(lock, async () => {
            const content = fs.readFileSync(lock, 'utf8')
            // As if the hold had lasted a minute: only the refresh can make the lock fresh again.
            ageFile(lock, LOCK_STALE_MS * 6)
            await until(() => ageOf(lock) < LOCK_STALE_MS, LEASE_REFRESH_MS * 3)
            expect(await breakStaleLock(lock, content)).toBe(false)
            expect(fs.readFileSync(lock, 'utf8')).toBe(content)
        })
        expect(fs.existsSync(lock)).toBe(false)
    })

    it('a holder that stops refreshing loses its lock once it is older than LOCK_STALE_MS', async () => {
        const lock = path.join(tmpDir('stopped'), 'x.lock')
        await withLock(lock, async () => {
            const content = fs.readFileSync(lock, 'utf8')
            // The holder hangs: its refresh never lands any more.
            vi.spyOn(fsp, 'utimes').mockResolvedValue(undefined)
            ageFile(lock, LOCK_STALE_MS + 1_000)
            await sleep(LEASE_REFRESH_MS + 500)
            expect(await breakStaleLock(lock, content)).toBe(true)
        })
        // The holder's release finds another state and removes nothing it does not own.
        expect(fs.existsSync(lock)).toBe(false)
    })

    it('a refresh touches only a lock that still holds its token', async () => {
        const lock = path.join(tmpDir('token'), 'x.lock')
        writeLockFile(lock, 'theirs', { ageMs: LOCK_STALE_MS * 2 })
        expect(await refreshLease(lock, 'mine')).toBe('lost')
        expect(ageOf(lock)).toBeGreaterThan(LOCK_STALE_MS)
        expect(await refreshLease(lock, 'theirs')).toBe('refreshed')
        expect(ageOf(lock)).toBeLessThan(LOCK_STALE_MS)
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
        const stale = writeLockFile(lockIn(to), 'S', { ageMs: LOCK_STALE_MS + 1_000 })
        expect(await breakStaleLock(lockIn(to), stale)).toBe(true)
    })
})
