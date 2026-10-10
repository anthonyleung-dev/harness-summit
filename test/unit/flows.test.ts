// Unit tests for the tool flows (in-process): every error code and the identity rules of SPEC §3.
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { SUMMIT_GUIDANCE } from '../../src/core/notice.js'
import { aliveFile } from '../../src/core/paths.js'
import { bye } from '../../src/flows/bye.js'
import { group } from '../../src/flows/group.js'
import { join } from '../../src/flows/join.js'
import { members, whoami } from '../../src/flows/query.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { runTool } from '../../src/server/server.js'
import { ReadOutput, TOOLS } from '../../src/server/tools.js'
import { callFor, codexMeta, errorCode as code, fakePid, opencodeMeta, recordingExec, tmpRoot } from '../helpers/env.js'
import { agentJson, hostJson } from '../helpers/state.js'

describe('flows', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })

    it('join is idempotent per host key, records the SPEC §4 agent.json and returns the guidance', async () => {
        const pid = fakePid()
        const call = callFor(root, 'pi', { hostPid: pid, session: 'S-pi' })
        const first = await join(call)
        const again = await join(call)
        expect(again).toMatchObject({ uuid: first.uuid, alreadyJoined: true, hostKey: 'pi-S-pi' })
        expect(first).toMatchObject({ alreadyJoined: false, guidance: SUMMIT_GUIDANCE })
        expect(again.guidance).toBe(SUMMIT_GUIDANCE)
        const agent = agentJson(first.folder)
        expect(agent).toMatchObject({
            harness: 'pi',
            pid,
            cwdSource: 'process.cwd',
            // The one literal pin of the signal layout (SPEC §4); every other test uses signalPathFor.
            wake: { type: 'signal', path: path.join(root, '.wake', 'pi-S-pi.signal') },
        })
        const host = hostJson(root, 'pi-S-pi')!
        expect(Object.keys(host).sort()).toEqual(['groupKey', 'harness', 'hostKey', 'joinedAt', 'uuid'])
        expect(agent).not.toHaveProperty('pidStart')
        // The first heartbeat lands with the join (SPEC §7).
        expect(fs.existsSync(aliveFile(root, first.hostKey))).toBe(true)
    })

    it('reads identity from disk on every call: deleting the host file un-joins', async () => {
        const call = callFor(root, 'claude', { session: 'S-c' })
        await join(call)
        fs.rmSync(path.join(root, '.hosts', 'claude-S-c.json'))
        expect(await whoami(call)).toEqual({ joined: false, hostKey: 'claude-S-c' })
        expect(await code(read(call))).toBe('SUMMIT_NOT_JOINED')
    })

    it('send errors: unknown target, gone target, self send, not joined', async () => {
        const a = callFor(root, 'claude')
        const b = callFor(root, 'claude')
        const ja = await join(a)
        const jb = await join(b)
        await rename(b, 'bob')
        expect(await code(send(callFor(root, 'claude'), { to: 'bob', message: 'x' }))).toBe('SUMMIT_NOT_JOINED')
        expect(await code(send(a, { to: '@nobody', message: 'x' }))).toBe('SUMMIT_UNKNOWN_TARGET')
        expect(await code(send(a, { to: '99999999-9999-4999-8999-999999999999', message: 'x' }))).toBe(
            'SUMMIT_UNKNOWN_TARGET',
        )
        expect(await code(send(a, { to: ja.uuid, message: 'x' }))).toBe('SUMMIT_SELF_SEND')
        expect((await send(a, { to: jb.uuid.toUpperCase(), message: 'upper-case uuid' })).to.uuid).toBe(jb.uuid)
        fs.rmSync(jb.folder, { recursive: true })
        expect(await code(send(a, { to: '@bob', message: 'x' }))).toBe('SUMMIT_TARGET_GONE')
        expect(await code(send(a, { to: jb.uuid, message: 'x' }))).toBe('SUMMIT_TARGET_GONE')
    })

    it('rename: a live holder keeps its name; a holder whose folder is gone frees it; bad names fail', async () => {
        const a = callFor(root, 'claude')
        const b = callFor(root, 'claude')
        await join(a)
        const jb = await join(b)
        await rename(b, 'bob')
        expect(await code(rename(a, 'bob'))).toBe('SUMMIT_NAME_TAKEN')
        expect(await code(rename(a, 'bad name'))).toBe('SUMMIT_BAD_NAME')
        expect(await code(rename(a, '11111111-1111-4111-8111-111111111111'))).toBe('SUMMIT_BAD_NAME')
        fs.rmSync(jb.folder, { recursive: true })
        expect(await rename(a, 'bob')).toMatchObject({ name: 'bob', previousName: null, takeover: null })
        expect((await rename(a, 'bobby')).previousName).toBe('bob')
    })

    it('sender label is the name, else the uuid; replies are addressed by uuid; messages survive the sender leaving', async () => {
        const a = callFor(root, 'opencode', { meta: opencodeMeta('ses_a') })
        const b = callFor(root, 'codex', { meta: codexMeta('th_b') })
        const ja = await join(a)
        const jb = await join(b)
        const sent = await send(a, { to: jb.uuid, message: 'from uuid' })
        expect(fs.existsSync(path.join(jb.folder, `${ja.uuid}.md`))).toBe(true)
        await bye(a)
        const r = await read(b)
        expect(r.guidance).toBe(SUMMIT_GUIDANCE)
        expect(r.messages[0]).toMatchObject({ from: ja.uuid, body: 'from uuid' })
        expect(r.messages[0]?.replyHint).toBe(
            `When the task is done, reply to ${ja.uuid} with summit_send({ to: "${ja.uuid}", replyTo: "${sent.id}", message: "<your answer>" }).`,
        )
        expect(fs.existsSync(ja.folder)).toBe(false)
    })

    it('a reply carries no reply hint, and the read output schema refuses one (D1)', async () => {
        const a = callFor(root, 'claude')
        const b = callFor(root, 'claude')
        const ja = await join(a)
        const jb = await join(b)
        const ask = await send(a, { to: jb.uuid, message: 'please do X' })
        const asked = (await read(b)).messages[0]
        expect(asked?.replyHint).toContain(`replyTo: "${ask.id}"`)
        await send(b, { to: ja.uuid, message: 'did X', replyTo: ask.id })
        const r = await read(a)
        expect(r.messages[0]).toMatchObject({ replyTo: ask.id, body: 'did X' })
        expect(r.messages[0]).not.toHaveProperty('replyHint')
        const withHint = { ...r, messages: [{ ...r.messages[0], replyHint: 'answer it' }] }
        expect(ReadOutput.safeParse(withHint).success).toBe(false)
        expect(ReadOutput.safeParse(r).success).toBe(true)
    })

    it('group move keeps the inbox and refuses a name held by a live agent before moving', async () => {
        const a = callFor(root, 'claude')
        const b = callFor(root, 'claude')
        const c = callFor(root, 'claude')
        const ja = await join(a)
        const jb = await join(b)
        await join(c)
        await rename(a, 'same')
        await send(c, { to: jb.uuid, message: 'kept' })
        await group(b, 'g2')
        expect((await read(b)).messages[0]?.body).toBe('kept')
        await rename(b, 'same')
        expect(await code(group(a, 'g2'))).toBe('SUMMIT_NAME_TAKEN')
        expect((await whoami(a)).joined && (await members(a)).groupKey).toBe(ja.groupKey)
        expect(fs.existsSync(ja.folder)).toBe(true)
        expect(fs.existsSync(path.join(root, 'g2', ja.uuid))).toBe(false)
        expect(await group(b, 'g2')).toMatchObject({ moved: false })
        expect(await code(group(b, 'Not_Valid'))).toBe('SUMMIT_BAD_GROUP')
    })

    it('members reports alive=unknown for opencode, true for a fresh heartbeat, and self for the caller only', async () => {
        const a = callFor(root, 'claude')
        const o = callFor(root, 'opencode', { meta: opencodeMeta('ses_z') })
        await join(a)
        await join(o)
        const m = await members(a)
        expect(m.members.map((x) => x.alive).sort()).toEqual([true, 'unknown'].sort())
        // `/summit-list` marks the caller from `self`: exactly the caller's own entry is true.
        expect(m.members.filter((x) => x.self).map((x) => x.harness)).toEqual(['claude'])
        expect((await members(o)).members.filter((x) => x.self).map((x) => x.harness)).toEqual(['opencode'])
    })

    it('runTool turns errors into isError results with the structured error and validates input', async () => {
        const sendTool = TOOLS.find((t) => t.name === 'summit_send')!
        const call = callFor(root, 'claude', { exec: recordingExec() })
        const res = await runTool(sendTool as never, call, { to: 'x', message: 'y' })
        expect(res.isError).toBe(true)
        expect(JSON.parse((res.content[0] as { text: string }).text).error).toMatchObject({
            code: 'SUMMIT_NOT_JOINED',
            fn: 'requireHost',
        })
        const bad = await runTool(sendTool as never, call, { to: '', message: 'y' })
        expect(JSON.parse((bad.content[0] as { text: string }).text).error.code).toBe('SUMMIT_BAD_INPUT')
        const upper = await runTool(sendTool as never, call, {
            to: 'x',
            message: 'y',
            replyTo: '33333333-3333-4333-8333-33333333333A',
        })
        expect(JSON.parse((upper.content[0] as { text: string }).text).error.code).toBe('SUMMIT_BAD_INPUT')
    })
})
