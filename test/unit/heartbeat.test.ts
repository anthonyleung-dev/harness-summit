// Unit tests for heartbeats (SPEC §7, XPLAT-AUDIT §H): fresh, stale (past or far future), missing and
// OpenCode "unknown"; the pinned timing constants; cleanup of old heartbeats;
// the second look; beats live outside the agent folders (a group move never touches them); the server
// timer beats the host's CURRENT session (after /clear the old one goes stale) and every Codex thread a
// call registered. No process inspection.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isAlive } from '../../src/core/agents.js'
import {
    BEAT_MS,
    CLEANUP_AGE_MS,
    confirmGone,
    isStaleMtime,
    SECOND_LOOK_MS,
    sleep,
    STALE_MS,
} from '../../src/core/freshness.js'
import { beat, beatTime, cleanupBeats, startHeartbeat } from '../../src/core/heartbeat.js'
import { LEASE_REFRESH_MS, LOCK_MAX_HOLD_MS } from '../../src/core/lease.js'
import { aliveDir, aliveFile } from '../../src/core/paths.js'
import { writeSessionSync } from '../../src/core/sessions.js'
import { group } from '../../src/flows/group.js'
import { join } from '../../src/flows/join.js'
import { startServing } from '../../src/server/server.js'
import { callFor, codexMeta, fakePid, opencodeMeta, tmpRoot, until } from '../helpers/env.js'
import { ageBeat } from '../helpers/state.js'

// Purpose: age in ms of the heartbeat of `hostKey` (Infinity when there is none).
async function ageOf(root: string, hostKey: string): Promise<number> {
    const t = await beatTime(root, hostKey)
    return t === null ? Infinity : Date.now() - t
}

describe('timing constants (pinned: a change must change this test too)', () => {
    it('beat 2 s, stale 10 s, second look 2.5 s, lease 2 s with three refreshes inside one stale period, max hold 60 s, cleanup 24 h', () => {
        expect(BEAT_MS).toBe(2_000)
        expect(STALE_MS).toBe(10_000)
        expect(SECOND_LOOK_MS).toBe(2_500)
        expect(LEASE_REFRESH_MS).toBe(2_000)
        expect(LEASE_REFRESH_MS * 3).toBeLessThan(STALE_MS)
        expect(LOCK_MAX_HOLD_MS).toBe(60_000)
        expect(CLEANUP_AGE_MS).toBe(24 * 60 * 60 * 1000)
    })

    it('a mtime is stale more than 10 s in the past or more than 10 s in the future', () => {
        const now = 1_000_000_000
        expect(isStaleMtime(now - 10_000, now)).toBe(false)
        expect(isStaleMtime(now - 10_001, now)).toBe(true)
        expect(isStaleMtime(now + 10_000, now)).toBe(false)
        expect(isStaleMtime(now + 10_001, now)).toBe(true)
    })
})

describe('heartbeat liveness', () => {
    let root: string
    let stop: (() => void) | undefined
    beforeEach(() => {
        root = tmpRoot()
    })
    afterEach(() => {
        stop?.()
        stop = undefined
    })

    it('alive: true when fresh, false when stale, far in the future or missing, unknown for OpenCode', async () => {
        const cl = await join(callFor(root, 'claude'))
        const cx = await join(callFor(root, 'codex', { meta: codexMeta('T-hb') }))
        const oc = await join(callFor(root, 'opencode', { meta: opencodeMeta('ses_hb') }))
        const alive = (j: { hostKey: string; harness: string }) =>
            isAlive(root, { hostKey: j.hostKey, harness: j.harness as 'claude' })
        expect([await alive(cl), await alive(cx), await alive(oc)]).toEqual([true, true, 'unknown'])
        expect(fs.existsSync(aliveFile(root, oc.hostKey))).toBe(false)
        // Even a fresh beat file for an OpenCode key proves nothing: one shared server outlives its sessions.
        ageBeat(root, oc.hostKey, 0)
        expect(await alive(oc)).toBe('unknown')
        ageBeat(root, cl.hostKey, STALE_MS - 1_000)
        expect(await alive(cl)).toBe(true)
        ageBeat(root, cl.hostKey, STALE_MS + 1_000)
        ageBeat(root, cx.hostKey, STALE_MS + 1_000)
        expect([await alive(cl), await alive(cx)]).toEqual([false, false])
        // A heartbeat set far into the future (`touch -d 2099`, a clock set back) never keeps it alive.
        ageBeat(root, cl.hostKey, -60_000)
        expect(await alive(cl)).toBe(false)
        // Missing: cleaned up after its session ended (or never beaten): gone, the same as stale.
        fs.rmSync(aliveFile(root, cl.hostKey))
        expect(await alive(cl)).toBe(false)
    })

    it('the second look: gone only when nothing beat meanwhile', async () => {
        await beat(root, 'claude-S-look', 'claude')
        const file = aliveFile(root, 'claude-S-look')
        ageBeat(root, 'claude-S-look', STALE_MS * 2)
        const seen = fs.statSync(file).mtimeMs
        expect(await confirmGone(file, seen, 50)).toBe(true)
        setTimeout(() => void beat(root, 'claude-S-look', 'claude'), 50)
        expect(await confirmGone(file, seen, 1_000)).toBe(false)
    })

    it('heartbeats live in <root>/.alive, so a group move renames an agent folder that holds no open file', async () => {
        const call = callFor(root, 'pi')
        const j = await join(call)
        expect(path.dirname(aliveFile(root, j.hostKey))).toBe(aliveDir(root))
        expect(path.relative(root, aliveDir(root))).toBe('.alive')
        expect(fs.readdirSync(j.folder).sort()).toEqual(['agent.json'])
        const moved = await group(call, 'g-hb')
        expect(fs.readdirSync(moved.folder).sort()).toEqual(['agent.json'])
        expect(fs.existsSync(aliveFile(root, j.hostKey))).toBe(true)
    })

    it('a starting server deletes heartbeats older than 24 h and keeps younger ones', async () => {
        await beat(root, 'claude-S-old', 'claude')
        await beat(root, 'claude-S-day', 'claude')
        ageBeat(root, 'claude-S-old', CLEANUP_AGE_MS + 60_000)
        ageBeat(root, 'claude-S-day', CLEANUP_AGE_MS - 60_000)
        // A stamp far in the future (a clock set back, `touch -d 2099`) is cleaned up too.
        await beat(root, 'claude-S-future', 'claude')
        ageBeat(root, 'claude-S-future', -(CLEANUP_AGE_MS + 60_000))
        await cleanupBeats(root)
        expect(fs.readdirSync(aliveDir(root)).sort()).toEqual(['claude-S-day.json'])
    })

    it('a Codex call registers its thread, so the timer of that server keeps beating it', async () => {
        const j = await join(callFor(root, 'codex', { meta: codexMeta('T-registered') }))
        ageBeat(root, j.hostKey, STALE_MS * 2)
        stop = startHeartbeat(root, 'codex', async () => [], 100)
        await until(async () => (await ageOf(root, j.hostKey)) < 1_000, 3_000)
        stop()
        ageBeat(root, j.hostKey, STALE_MS * 2)
        await sleep(300)
        expect(await ageOf(root, j.hostKey)).toBeGreaterThan(STALE_MS)
    })
})

describe('server timer follows the host session', () => {
    let root: string
    let stop: (() => void) | undefined
    beforeEach(() => {
        root = tmpRoot()
    })
    afterEach(() => {
        stop?.()
        stop = undefined
    })

    it('claude: beats the current session; after /clear the old session goes stale and the new one beats', async () => {
        const hostPid = fakePid()
        const call = callFor(root, 'claude', { hostPid, session: 'S-before' })
        const old = await join(call)
        stop = await startServing(root, call)
        writeSessionSync(root, 'claude', hostPid, 'S-after')
        await beat(root, 'claude-S-after', 'claude')
        ageBeat(root, old.hostKey, STALE_MS * 2)
        ageBeat(root, 'claude-S-after', STALE_MS * 2)
        await until(async () => (await ageOf(root, 'claude-S-after')) < 3_000, 6_000)
        expect(await ageOf(root, old.hostKey)).toBeGreaterThan(STALE_MS)
    })

    it('pi: beats the session of its env; a host with no recorded session beats nothing', async () => {
        const pi = callFor(root, 'pi', { session: 'S-pi' })
        stop = await startServing(root, pi)
        await until(async () => (await ageOf(root, 'pi-S-pi')) < 3_000, 6_000)
        stop()
        const omp = { ...callFor(root, 'omp'), hostPid: fakePid() }
        stop = await startServing(root, omp)
        await sleep(300)
        expect(fs.readdirSync(aliveDir(root)).filter((f) => f.startsWith('omp-'))).toEqual([])
    })
})
