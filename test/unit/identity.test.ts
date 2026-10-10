// Unit tests for identity repair: a stale host record after pid reuse, found by heartbeat age when a new
// server starts (REVIEW m8, SPEC §3), and a host record left behind by a group move that stopped after
// the folder moved (REVIEW M1).
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { HEARTBEAT_STALE_MS } from '../../src/core/heartbeat.js'
import { dropStaleHost, readHost } from '../../src/core/identity.js'
import { readMembers } from '../../src/core/members.js'
import { noticeForHostKey } from '../../src/core/notice.js'
import { heartbeatFile } from '../../src/core/paths.js'
import { join } from '../../src/flows/join.js'
import { members, whoami } from '../../src/flows/query.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { callFor, codexMeta, errorCode, tmpRoot } from '../helpers/env.js'
import { ageHeartbeat, moveFolder } from '../helpers/state.js'

describe('stale host record (pid reuse), checked when a new server starts', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })

    it('a record whose agent nobody beat for 15 s is dropped; the new host is not joined', async () => {
        const call = callFor(root, 'claude')
        const sender = callFor(root, 'claude')
        const old = await join(call)
        await join(sender)
        await send(sender, { to: old.uuid, message: 'for the dead session' })
        // The old session's server exited 20 s ago; a new claude got the same pid and starts its server.
        ageHeartbeat(old.folder, HEARTBEAT_STALE_MS + 5_000)
        expect(await dropStaleHost(root, old.hostKey)).toBe(true)
        expect(await whoami(call)).toEqual({ joined: false, hostKey: old.hostKey })
        expect(await noticeForHostKey(root, old.hostKey)).toBeNull()
        expect(await errorCode(read(call))).toBe('SUMMIT_NOT_JOINED')
        const fresh = await join(call)
        expect(fresh.uuid).not.toBe(old.uuid)
        expect((await read(call)).count).toBe(0)
    })

    it('a record without any heartbeat (joined by a server before heartbeats) is dropped too', async () => {
        const call = callFor(root, 'pi')
        const j = await join(call)
        fs.rmSync(heartbeatFile(j.folder))
        expect(await dropStaleHost(root, j.hostKey)).toBe(true)
        expect(await readHost(root, j.hostKey)).toBeNull()
    })

    it('a record beaten within 15 s stays (pi restarts its server on /new; known limit: a pid reused that fast)', async () => {
        const call = callFor(root, 'omp')
        const j = await join(call)
        ageHeartbeat(j.folder, HEARTBEAT_STALE_MS - 5_000)
        expect(await dropStaleHost(root, j.hostKey)).toBe(false)
        expect(await whoami(call)).toMatchObject({ joined: true, uuid: j.uuid })
    })

    it('Codex and OpenCode keys hold no pid and are never dropped by the start check', async () => {
        const cx = callFor(root, 'codex', { meta: codexMeta('T-keep') })
        const j = await join(cx)
        ageHeartbeat(j.folder, HEARTBEAT_STALE_MS * 4)
        expect(await dropStaleHost(root, j.hostKey)).toBe(false)
        expect(await readHost(root, j.hostKey)).toMatchObject({ uuid: j.uuid })
    })

    it('members marks an agent whose heartbeat is older than 15 s as not alive', async () => {
        const a = callFor(root, 'claude')
        const b = callFor(root, 'claude')
        await join(a)
        const jb = await join(b)
        expect((await members(a)).members.find((x) => x.uuid === jb.uuid)?.alive).toBe(true)
        ageHeartbeat(jb.folder, HEARTBEAT_STALE_MS + 1_000)
        expect((await members(a)).members.find((x) => x.uuid === jb.uuid)?.alive).toBe(false)
    })
})

describe('host record left behind by an unfinished group move', () => {
    it('every flow finds the folder in its new group, repairs the record and never makes a ghost', async () => {
        const root = tmpRoot()
        const call = callFor(root, 'claude')
        const sender = callFor(root, 'claude')
        const j = await join(call)
        await rename(call, 'mover')
        await join(sender)
        await send(sender, { to: j.uuid, message: 'before the crash' })
        // Crash after moveFolder, before updateHost: the folder is in g9, the record still says the old group.
        moveFolder(j.folder, path.join(root, 'g9', j.uuid))
        expect((await read(call)).messages.map((m) => m.body)).toEqual(['before the crash'])
        expect(await readHost(root, j.hostKey)).toMatchObject({ groupKey: 'g9' })
        expect(fs.existsSync(j.folder)).toBe(false)
        expect((await readMembers(root, j.groupKey)).members).toEqual({})
        expect(await join(call)).toMatchObject({ uuid: j.uuid, groupKey: 'g9', alreadyJoined: true })
        expect(fs.existsSync(j.folder)).toBe(false)
    })

    it('a folder gone from every group reads as not joined; join starts a fresh identity', async () => {
        const root = tmpRoot()
        const call = callFor(root, 'claude')
        const j = await join(call)
        fs.rmSync(j.folder, { recursive: true })
        expect(await errorCode(read(call))).toBe('SUMMIT_NOT_JOINED')
        expect(fs.existsSync(j.folder)).toBe(false)
        expect((await join(call)).alreadyJoined).toBe(false)
    })
})
