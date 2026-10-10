// Unit tests: host keys, group keys, the lock (owner token, REVIEW m7), process start times (m8).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { sleep, STALE_MS } from '../../src/core/freshness.js'
import {
    codexThreadId,
    hostKeyForSession,
    isSignalHarness,
    resolveHostKey,
    SESSION_FILE_HARNESSES,
    SIGNAL_HARNESSES,
} from '../../src/core/hostKey.js'
import { breakStaleLock, withLock } from '../../src/core/lock.js'
import { readMembers, updateMembers } from '../../src/core/members.js'
import { membersLock } from '../../src/core/paths.js'
import { defaultGroupKey, namedGroupKey } from '../../src/core/project.js'
import { HARNESSES } from '../../src/core/schemas.js'
import { codexMeta, opencodeMeta, tmpDir } from '../helpers/env.js'
import { ageFile, lockLine, writeLockFile } from '../helpers/state.js'

describe('host keys', () => {
    it('uses the host-provided session id for claude, pi and omp, never _meta or a pid', () => {
        expect(resolveHostKey({ harness: 'claude', meta: opencodeMeta('ignored'), sessionId: 'S1' })).toBe('claude-S1')
        expect(resolveHostKey({ harness: 'pi', meta: undefined, sessionId: 'S2' })).toBe('pi-S2')
        expect(hostKeyForSession('omp', 'S3')).toBe('omp-S3')
        for (const harness of ['claude', 'pi', 'omp'] as const) {
            expect(() => resolveHostKey({ harness, meta: undefined })).toThrow(
                expect.objectContaining({ code: 'SUMMIT_NO_HOST_KEY' }),
            )
            expect(() => hostKeyForSession(harness, '../etc')).toThrow(
                expect.objectContaining({ code: 'SUMMIT_NO_HOST_KEY' }),
            )
        }
    })

    it('uses _meta for codex and opencode and fails without it', () => {
        expect(resolveHostKey({ harness: 'codex', meta: codexMeta('t1'), sessionId: 'x' })).toBe('codex-t1')
        expect(resolveHostKey({ harness: 'opencode', meta: opencodeMeta('ses_a') })).toBe('opencode-ses_a')
        expect(() =>
            resolveHostKey({ harness: 'codex', meta: { 'x-codex-turn-metadata': { thread_id: 't' } } }),
        ).toThrow(expect.objectContaining({ code: 'SUMMIT_NO_HOST_KEY' }))
        expect(() => resolveHostKey({ harness: 'opencode', meta: { sessionID: 'x' } })).toThrow(
            expect.objectContaining({ code: 'SUMMIT_NO_HOST_KEY' }),
        )
        expect(() => resolveHostKey({ harness: 'opencode', meta: opencodeMeta('../etc') })).toThrow(
            expect.objectContaining({ code: 'SUMMIT_NO_HOST_KEY' }),
        )
    })

    it('derives the signal and session-file sets from one list each (N2)', () => {
        expect([...SIGNAL_HARNESSES].sort()).toEqual(['claude', 'omp', 'pi'])
        expect([...SESSION_FILE_HARNESSES].sort()).toEqual(['claude', 'omp'])
        for (const h of HARNESSES) expect(isSignalHarness(h)).toBe(SIGNAL_HARNESSES.includes(h))
    })

    it('prefers threadId when the turn metadata disagrees', () => {
        expect(codexThreadId({ threadId: 'a', 'x-codex-turn-metadata': { thread_id: 'b' } })).toBe('a')
    })
})

describe('groups', () => {
    it('hashes the project root and validates named groups', () => {
        expect(defaultGroupKey('/p')).toMatch(/^[0-9a-f]{32}$/)
        expect(namedGroupKey('team-x')).toBe('team-x')
        for (const bad of ['Team', '-x', 'a'.repeat(33), '0123456789abcdef0123456789abcdef', 'a/b']) {
            expect(() => namedGroupKey(bad)).toThrow(expect.objectContaining({ code: 'SUMMIT_BAD_GROUP' }))
        }
    })
})

describe('locks', () => {
    it('serialises concurrent members writers without losing an update', async () => {
        const root = tmpDir('lock')
        const uuids = Array.from({ length: 20 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`)
        await Promise.all(
            uuids.map((u, i) =>
                updateMembers(root, 'g', (m) => ({ version: 1, members: { ...m.members, [`n${i}`]: u } })),
            ),
        )
        expect(Object.keys((await readMembers(root, 'g')).members)).toHaveLength(20)
        expect(fs.existsSync(membersLock(root, 'g'))).toBe(false)
    })

    it('breaks an old lock file that has no owner line (a holder died before writing it)', async () => {
        const root = tmpDir('stale')
        const lock = membersLock(root, 'g')
        fs.mkdirSync(path.dirname(lock), { recursive: true })
        fs.writeFileSync(lock, 'old')
        ageFile(lock, STALE_MS + 1000)
        await updateMembers(root, 'g', (m) => m)
        expect(fs.existsSync(lock)).toBe(false)
    })

    it('a waiter that saw a stale lock never moves the fresh lock that replaced it (F10, D3)', async () => {
        const lock = path.join(tmpDir('tomb'), 'x.lock')
        const stale = lockLine('stale-token')
        // The waiter read "stale-token" earlier; another waiter broke that lock and took a new one, which
        // its holder has since stopped refreshing too.
        const fresh = writeLockFile(lock, 'fresh-token', { ageMs: STALE_MS + 1_000 })
        expect(await breakStaleLock(lock, stale)).toBe(false)
        expect(fs.readFileSync(lock, 'utf8')).toBe(fresh)
        expect(fs.readdirSync(path.dirname(lock))).toEqual(['x.lock'])
        expect(await breakStaleLock(lock, fresh)).toBe(true)
        expect(fs.readdirSync(path.dirname(lock))).toEqual([])
        expect(await breakStaleLock(lock, fresh)).toBe(false)
    })

    it('many waiters on one stale lock: exactly one holder at a time (F10)', async () => {
        const lock = path.join(tmpDir('herd'), 'x.lock')
        writeLockFile(lock, 'dead-token', { ageMs: STALE_MS + 1_000 })
        let holders = 0
        let most = 0
        await Promise.all(
            Array.from({ length: 12 }, () =>
                withLock(lock, async () => {
                    most = Math.max(most, ++holders)
                    await sleep(5)
                    holders--
                }),
            ),
        )
        expect(most).toBe(1)
        expect(fs.readdirSync(path.dirname(lock))).toEqual([])
    })

    it('a holder whose lock was broken never deletes the new holder lock on release', async () => {
        const lock = path.join(tmpDir('token'), 'x.lock')
        await withLock(lock, async () => {
            // Someone broke our lock and took it: the file now holds their token.
            writeLockFile(lock, 'their-token')
        })
        expect(fs.readFileSync(lock, 'utf8')).toBe(lockLine('their-token'))
    })

    it('a lock inside a missing folder is an error, never a new folder (mkdir: false)', async () => {
        const dir = path.join(tmpDir('nofolder'), 'gone')
        await expect(withLock(path.join(dir, '.cursor.lock'), async () => 1, { mkdir: false })).rejects.toMatchObject({
            code: 'SUMMIT_IO',
        })
        expect(fs.existsSync(dir)).toBe(false)
    })
})
