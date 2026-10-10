// Unit tests for identity (SPEC §3): the host key follows the harness session, so a session resumed in a
// new process (any time later) gets its agent back, `/clear` and `/new` start a new agent, and a host
// whose session was never recorded fails with SUMMIT_NO_HOST_KEY. Also: a host record left behind by a
// group move that stopped after the folder moved (REVIEW M1).
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { STALE_MS } from '../../src/core/heartbeat.js'
import { readHost } from '../../src/core/identity.js'
import { readMembers } from '../../src/core/members.js'
import { noticeForHostKey } from '../../src/core/notice.js'
import { join } from '../../src/flows/join.js'
import { members, whoami } from '../../src/flows/query.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { callFor, errorCode, fakePid, tmpRoot } from '../helpers/env.js'
import { ageBeat, moveFolder, writeSessionFile } from '../helpers/state.js'

describe('identity follows the harness session', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })

    for (const harness of ['claude', 'pi', 'omp'] as const) {
        it(`${harness}: a session resumed in a new process (much later) gets its agent, name and mail back`, async () => {
            const first = callFor(root, harness, { session: `S-${harness}` })
            const sender = callFor(root, 'claude')
            const j = await join(first)
            await rename(first, `n-${harness}`)
            await join(sender)
            await send(sender, { to: j.uuid, message: 'while you were away' })
            // The session ended an hour ago; a new process (another pid) resumes it.
            ageBeat(root, j.hostKey, 60 * 60 * 1000)
            const resumed = callFor(root, harness, { session: `S-${harness}` })
            expect(resumed.hostPid).not.toBe(first.hostPid)
            expect(await whoami(resumed)).toMatchObject({ joined: true, uuid: j.uuid, name: `n-${harness}` })
            expect((await read(resumed)).messages.map((m) => m.body)).toEqual(['while you were away'])
        })
    }

    it('claude /clear and omp /new (same process, new session id) start a new agent; the old one stays', async () => {
        for (const harness of ['claude', 'omp'] as const) {
            const hostPid = fakePid()
            const before = callFor(root, harness, { hostPid, session: `old-${harness}` })
            const old = await join(before)
            // The SessionStart hook (or the OMP extension) records the new session for the same process.
            writeSessionFile(root, harness, hostPid, `new-${harness}`)
            expect(await whoami(before)).toEqual({ joined: false, hostKey: `${harness}-new-${harness}` })
            const fresh = await join(before)
            expect(fresh.uuid).not.toBe(old.uuid)
            expect(await readHost(root, old.hostKey)).toMatchObject({ uuid: old.uuid })
            expect(fs.existsSync(old.folder)).toBe(true)
        }
    })

    it('a host whose session was never recorded fails with SUMMIT_NO_HOST_KEY and says why', async () => {
        const claude = { ...callFor(root, 'claude'), hostPid: fakePid() }
        const err = await join(claude).catch((e: { code: string; message: string }) => e)
        expect(err).toMatchObject({ code: 'SUMMIT_NO_HOST_KEY', message: expect.stringContaining('plugin hooks') })
        const pi = { ...callFor(root, 'pi'), sessionEnv: undefined }
        expect(await errorCode(whoami(pi))).toBe('SUMMIT_NO_HOST_KEY')
        const omp = { ...callFor(root, 'omp'), hostPid: fakePid() }
        expect(await errorCode(read(omp))).toBe('SUMMIT_NO_HOST_KEY')
    })

    it('a reused pid finds only the session its own host recorded, never the dead session before it', async () => {
        const hostPid = fakePid()
        const dead = callFor(root, 'claude', { hostPid, session: 'S-dead' })
        const old = await join(dead)
        const sender = callFor(root, 'claude')
        await join(sender)
        await send(sender, { to: old.uuid, message: 'for the dead session only' })
        // A new claude got the same pid; its SessionStart hook rewrote the session file at startup.
        const reborn = callFor(root, 'claude', { hostPid, session: 'S-reborn' })
        expect(await whoami(reborn)).toEqual({ joined: false, hostKey: 'claude-S-reborn' })
        expect(await errorCode(read(reborn))).toBe('SUMMIT_NOT_JOINED')
        expect(await noticeForHostKey(root, 'claude-S-reborn')).toBeNull()
        expect(await noticeForHostKey(root, old.hostKey)).not.toBeNull()
    })

    it('members reports alive from the heartbeat of the session key: true, false after 10 s, unknown never beaten', async () => {
        const a = callFor(root, 'claude')
        const b = callFor(root, 'claude')
        await join(a)
        const jb = await join(b)
        const aliveOfB = async () => (await members(a)).members.find((x) => x.uuid === jb.uuid)?.alive
        expect(await aliveOfB()).toBe(true)
        ageBeat(root, jb.hostKey, STALE_MS + 1_000)
        expect(await aliveOfB()).toBe(false)
        fs.rmSync(path.join(root, '.alive', `${jb.hostKey}.json`))
        expect(await aliveOfB()).toBe('unknown')
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
