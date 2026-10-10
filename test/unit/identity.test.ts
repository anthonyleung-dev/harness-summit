// Unit tests for identity repair: a stale host record after pid reuse (REVIEW m8) and a host record
// left behind by a group move that stopped after the folder moved (REVIEW M1).
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { readHost } from '../../src/core/identity.js'
import { readMembers } from '../../src/core/members.js'
import { noticeForHostKey } from '../../src/core/notice.js'
import { join } from '../../src/flows/join.js'
import { members, whoami } from '../../src/flows/query.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { callFor, errorCode, livePid, tmpRoot } from '../helpers/env.js'
import { moveFolder } from '../helpers/state.js'

describe('stale host record (pid reuse)', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })

    it('a record whose host start time differs is deleted and reads as not joined', async () => {
        const call = callFor(root, 'claude', { ppid: livePid() })
        const sender = callFor(root, 'claude', { ppid: livePid() })
        const old = await join(call)
        await join(sender)
        await send(sender, { to: old.uuid, message: 'for the dead session' })
        const file = path.join(root, '.hosts', `${old.hostKey}.json`)
        // The pid now names another process: same pid, other start time.
        const rec = JSON.parse(fs.readFileSync(file, 'utf8'))
        fs.writeFileSync(file, JSON.stringify({ ...rec, hostStart: rec.hostStart + 1 }))
        expect(await whoami(call)).toEqual({ joined: false, hostKey: old.hostKey })
        expect(fs.existsSync(file)).toBe(false)
        expect(await noticeForHostKey(root, old.hostKey)).toBeNull()
        expect(await errorCode(read(call))).toBe('SUMMIT_NOT_JOINED')
        const fresh = await join(call)
        expect(fresh.uuid).not.toBe(old.uuid)
        expect((await read(call)).count).toBe(0)
    })

    it('a live record (same start time) and a legacy record without a start time stay joined', async () => {
        const call = callFor(root, 'pi', { ppid: livePid() })
        const j = await join(call)
        expect((await whoami(call)).joined).toBe(true)
        const file = path.join(root, '.hosts', `${j.hostKey}.json`)
        const { hostStart: _drop, ...legacy } = JSON.parse(fs.readFileSync(file, 'utf8'))
        fs.writeFileSync(file, JSON.stringify(legacy))
        expect(await readHost(root, j.hostKey)).toMatchObject({ uuid: j.uuid })
    })

    it('members marks an agent whose pid was reused as not alive', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const b = callFor(root, 'claude', { ppid: livePid() })
        await join(a)
        const jb = await join(b)
        const file = path.join(jb.folder, 'agent.json')
        const agent = JSON.parse(fs.readFileSync(file, 'utf8'))
        fs.writeFileSync(file, JSON.stringify({ ...agent, pidStart: agent.pidStart + 1 }))
        const m = await members(a)
        expect(m.members.find((x) => x.uuid === jb.uuid)?.alive).toBe(false)
    })
})

describe('host record left behind by an unfinished group move', () => {
    it('every flow finds the folder in its new group, repairs the record and never makes a ghost', async () => {
        const root = tmpRoot()
        const call = callFor(root, 'claude', { ppid: livePid() })
        const sender = callFor(root, 'claude', { ppid: livePid() })
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
        const call = callFor(root, 'claude', { ppid: livePid() })
        const j = await join(call)
        fs.rmSync(j.folder, { recursive: true })
        expect(await errorCode(read(call))).toBe('SUMMIT_NOT_JOINED')
        expect(fs.existsSync(j.folder)).toBe(false)
        expect((await join(call)).alreadyJoined).toBe(false)
    })
})
