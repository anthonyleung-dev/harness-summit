// Unit tests for heartbeats (SPEC §7, XPLAT-AUDIT §H): fresh, stale, never beaten and OpenCode "unknown";
// the second look; beats live outside the agent folders (a group move never touches them); the server
// timer beats the host's CURRENT session (after /clear the old one goes stale) and every Codex thread a
// call registered. No process inspection.
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isAlive } from '../../src/core/agents.js'
import {
    beat,
    beatTime,
    confirmGone,
    isFresh,
    SECOND_LOOK_MS,
    STALE_MS,
    startHeartbeat,
} from '../../src/core/heartbeat.js'
import { aliveDir, aliveFile } from '../../src/core/paths.js'
import { group } from '../../src/flows/group.js'
import { join } from '../../src/flows/join.js'
import { startServing } from '../../src/server/server.js'
import { callFor, codexMeta, fakePid, opencodeMeta, tmpRoot, until } from '../helpers/env.js'
import { ageBeat, writeSessionFile } from '../helpers/state.js'

// Purpose: age in ms of the heartbeat of `hostKey` (Infinity when there is none).
async function ageOf(root: string, hostKey: string): Promise<number> {
    const t = await beatTime(root, hostKey)
    return t === null ? Infinity : Date.now() - t
}

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

    it('alive: true when fresh, false after 10 s, unknown when never beaten and for OpenCode', async () => {
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
        fs.rmSync(aliveFile(root, cl.hostKey))
        expect(await alive(cl)).toBe('unknown')
        // A future mtime (the clock went back) is fresh.
        expect(isFresh(Date.now() + 60_000)).toBe(true)
    })

    it('the second look: gone only when nothing beat meanwhile', async () => {
        await beat(root, 'claude-S-look', 'claude')
        const file = aliveFile(root, 'claude-S-look')
        ageBeat(root, 'claude-S-look', STALE_MS * 2)
        const seen = fs.statSync(file).mtimeMs
        expect(await confirmGone(file, seen, 50)).toBe(true)
        setTimeout(() => void beat(root, 'claude-S-look', 'claude'), 20)
        expect(await confirmGone(file, seen, 200)).toBe(false)
        expect(SECOND_LOOK_MS).toBeGreaterThan(2_000)
    })

    it('a group move renames the agent folder and leaves the heartbeat where it is', async () => {
        const call = callFor(root, 'pi')
        const j = await join(call)
        const before = fs.statSync(aliveFile(root, j.hostKey)).mtimeMs
        const moved = await group(call, 'g-hb')
        expect(fs.existsSync(moved.folder)).toBe(true)
        expect(fs.readdirSync(moved.folder)).not.toContain('.heartbeat')
        expect(fs.statSync(aliveFile(root, j.hostKey)).mtimeMs).toBeGreaterThanOrEqual(before)
    })

    it('a Codex call registers its thread, so the timer of that server keeps beating it', async () => {
        const j = await join(callFor(root, 'codex', { meta: codexMeta('T-registered') }))
        ageBeat(root, j.hostKey, STALE_MS * 2)
        stop = startHeartbeat(root, 'codex', async () => [], 100)
        await until(async () => (await ageOf(root, j.hostKey)) < 1_000, 3_000)
        stop()
        ageBeat(root, j.hostKey, STALE_MS * 2)
        await new Promise((r) => setTimeout(r, 300))
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
        writeSessionFile(root, 'claude', hostPid, 'S-after')
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
        await new Promise((r) => setTimeout(r, 300))
        expect(fs.readdirSync(aliveDir(root)).filter((f) => f.startsWith('omp-'))).toEqual([])
    })
})
