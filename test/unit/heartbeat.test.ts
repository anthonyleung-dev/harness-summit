// Unit tests for heartbeat liveness (SPEC §3, §7): fresh, stale and OpenCode "unknown"; a beat never
// creates a folder and follows a group move; the server timer beats what it serves; a new pid-keyed
// server drops the record of a dead session before it serves its host key. No process inspection.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { isAlive } from '../../src/core/agents.js'
import {
    beat,
    beatHostKey,
    heartbeatAge,
    HEARTBEAT_STALE_MS,
    serveHostKey,
    startHeartbeat,
} from '../../src/core/heartbeat.js'
import { readHost } from '../../src/core/identity.js'
import { heartbeatFile } from '../../src/core/paths.js'
import { group } from '../../src/flows/group.js'
import { join } from '../../src/flows/join.js'
import { startServing } from '../../src/server/server.js'
import { callFor, codexMeta, opencodeMeta, tmpDir, tmpRoot, until } from '../helpers/env.js'
import { ageHeartbeat } from '../helpers/state.js'

// Purpose: age in ms of the heartbeat of `folder` (null when there is none).
const ageOf = (folder: string) => heartbeatAge(folder)

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

    it('alive is true for a fresh beat, false once older than 15 s or missing, unknown for OpenCode', async () => {
        const cl = await join(callFor(root, 'claude'))
        const cx = await join(callFor(root, 'codex', { meta: codexMeta('T-hb') }))
        const oc = await join(callFor(root, 'opencode', { meta: opencodeMeta('ses_hb') }))
        const alive = (j: { groupKey: string; uuid: string; harness: string }) =>
            isAlive(root, j.groupKey, { uuid: j.uuid, harness: j.harness as 'claude' })
        expect([await alive(cl), await alive(cx), await alive(oc)]).toEqual([true, true, 'unknown'])
        ageHeartbeat(cl.folder, HEARTBEAT_STALE_MS - 1_000)
        expect(await alive(cl)).toBe(true)
        ageHeartbeat(cl.folder, HEARTBEAT_STALE_MS + 1_000)
        ageHeartbeat(cx.folder, HEARTBEAT_STALE_MS + 1_000)
        ageHeartbeat(oc.folder, HEARTBEAT_STALE_MS * 10)
        expect([await alive(cl), await alive(cx), await alive(oc)]).toEqual([false, false, 'unknown'])
        fs.rmSync(heartbeatFile(cl.folder))
        expect(await alive(cl)).toBe(false)
    })

    it('a beat creates the heartbeat file but never a missing folder', async () => {
        const folder = tmpDir('beat')
        expect(await beat(folder)).toBe(true)
        expect((await ageOf(folder))!).toBeLessThan(1_000)
        const gone = path.join(folder, 'moved-away')
        expect(await beat(gone)).toBe(false)
        expect(fs.existsSync(gone)).toBe(false)
    })

    it('beatHostKey finds the agent through its host record, also after a group move', async () => {
        const call = callFor(root, 'pi')
        const j = await join(call)
        const moved = await group(call, 'g-hb')
        ageHeartbeat(moved.folder, HEARTBEAT_STALE_MS * 2)
        expect(await beatHostKey(root, j.hostKey)).toBe(true)
        expect((await ageOf(moved.folder))!).toBeLessThan(1_000)
        expect(fs.existsSync(j.folder)).toBe(false)
        expect(await beatHostKey(root, 'pi-1')).toBe(false)
    })

    it('a Codex call registers its thread, so the timer of that server keeps beating it', async () => {
        const j = await join(callFor(root, 'codex', { meta: codexMeta('T-registered') }))
        ageHeartbeat(j.folder, HEARTBEAT_STALE_MS * 2)
        stop = startHeartbeat(root, 100)
        await until(async () => ((await ageOf(j.folder)) ?? Infinity) < 1_000, 3_000)
    })

    it('the server timer beats every served host key until it stops', async () => {
        const j = await join(callFor(root, 'codex', { meta: codexMeta('T-timer') }))
        ageHeartbeat(j.folder, HEARTBEAT_STALE_MS * 2)
        serveHostKey(j.hostKey)
        stop = startHeartbeat(root, 100)
        await until(async () => ((await ageOf(j.folder)) ?? Infinity) < 1_000)
        stop()
        ageHeartbeat(j.folder, HEARTBEAT_STALE_MS * 2)
        await new Promise((r) => setTimeout(r, 300))
        expect((await ageOf(j.folder))!).toBeGreaterThan(HEARTBEAT_STALE_MS)
    })
})

describe('server start (pid-keyed host key = <harness>-<process.ppid>)', () => {
    let root: string
    let stop: (() => void) | undefined
    beforeEach(() => {
        root = tmpRoot()
    })
    afterEach(() => {
        stop?.()
        stop = undefined
    })

    it('drops the record of a dead session that had this pid, and never beats it back to life', async () => {
        const j = await join(callFor(root, 'claude', { ppid: process.ppid }))
        ageHeartbeat(j.folder, HEARTBEAT_STALE_MS + 5_000)
        stop = await startServing(root, 'claude')
        expect(await readHost(root, j.hostKey)).toBeNull()
        expect((await ageOf(j.folder))!).toBeGreaterThan(HEARTBEAT_STALE_MS)
    })

    it('keeps a record beaten within 15 s (pi restarted its server) and serves it from then on', async () => {
        const j = await join(callFor(root, 'pi', { ppid: process.ppid }))
        ageHeartbeat(j.folder, HEARTBEAT_STALE_MS - 5_000)
        stop = await startServing(root, 'pi')
        expect(await readHost(root, j.hostKey)).toMatchObject({ uuid: j.uuid })
        await until(async () => ((await ageOf(j.folder)) ?? Infinity) < 1_000)
    })
})
