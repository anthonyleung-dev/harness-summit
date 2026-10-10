// Unit tests for name takeover (REVIEW M5, owner decision): a gone holder loses its name, an unknown
// holder (OpenCode) loses it only with force, a live holder keeps it; the result says why (O1). A
// rename whose own folder left the group during the call fails and gives a taken-over name back
// (DELTA-REVIEW-3 E6, DELTA-REVIEW-4 G2).
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readMembers } from '../../src/core/members.js'
import { group } from '../../src/flows/group.js'
import { join } from '../../src/flows/join.js'
import { members, whoami } from '../../src/flows/query.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { runTool } from '../../src/server/server.js'
import { TOOLS } from '../../src/server/tools.js'
import { resumedCodex } from '../helpers/agents.js'
import { callFor, deadPid, errorCode, killLivePid, livePid, opencodeMeta, tmpRoot } from '../helpers/env.js'
import { agentJson, mapOf, moveFolder, onMapRead, patchAgentJson } from '../helpers/state.js'

describe('name takeover', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('a rename whose folder left the group during the call fails and leaves no map entry (E6)', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        const moved = path.join(root, 'gx', ja.uuid)
        // A parallel summit_group moves the folder while the rename reads the name map under its lock.
        onMapRead(root, ja.groupKey, () => moveFolder(ja.folder, moved))
        expect(await errorCode(rename(a, 'x'))).toBe('SUMMIT_TARGET_GONE')
        expect(mapOf(root, ja.groupKey)).toEqual({})
        expect(agentJson(moved).name).toBeNull()
    })

    it('a forced takeover by a rename whose folder left the group gives the name back (G2)', async () => {
        const oc = callFor(root, 'opencode', { meta: opencodeMeta('ses_g2') })
        const joc = await join(oc)
        await rename(oc, 'x')
        const a = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        onMapRead(root, ja.groupKey, () => moveFolder(ja.folder, path.join(root, 'gx', ja.uuid)))
        expect(await errorCode(rename(a, 'x', true))).toBe('SUMMIT_TARGET_GONE')
        expect(mapOf(root, ja.groupKey)).toEqual({ x: joc.uuid })
        expect(agentJson(joc.folder).name).toBe('x')
        expect(await whoami(oc)).toMatchObject({ name: 'x' })
    })

    it('summit_rename states why it took a name over (O1)', async () => {
        const oc = callFor(root, 'opencode', { meta: opencodeMeta('ses_o1') })
        const joc = await join(oc)
        await rename(oc, 'olive')
        const a = callFor(root, 'claude', { ppid: livePid() })
        await join(a)
        const renameTool = TOOLS.find((t) => t.name === 'summit_rename')!
        const res = await runTool(renameTool as never, a, { name: 'olive', force: true })
        expect(res.structuredContent).toMatchObject({ takeover: { from: joc.uuid, reason: 'forced-unknown' } })
    })

    it('a restarted session takes its name back from the dead agent; the old folder stays, nameless', async () => {
        const oldPid = livePid()
        const old = callFor(root, 'claude', { ppid: oldPid })
        const jo = await join(old)
        await rename(old, 'alice')
        await killLivePid(oldPid)
        const fresh = callFor(root, 'claude', { ppid: livePid() })
        const jf = await join(fresh)
        expect(await rename(fresh, 'alice')).toMatchObject({
            name: 'alice',
            takeover: { from: jo.uuid, reason: 'holder-gone' },
        })
        expect((await readMembers(root, jf.groupKey)).members).toEqual({ alice: jf.uuid })
        expect(fs.existsSync(jo.folder)).toBe(true)
        expect(agentJson(jo.folder).name).toBeNull()
        expect(agentJson(jf.folder).name).toBe('alice')
    })

    it('a holder whose pid was reused counts as gone', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        await rename(a, 'bob')
        patchAgentJson(ja.folder, { pidStart: 1 })
        const b = callFor(root, 'claude', { ppid: livePid() })
        await join(b)
        expect((await rename(b, 'bob')).takeover).toEqual({ from: ja.uuid, reason: 'holder-gone' })
    })

    it('a live holder keeps its name', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const b = callFor(root, 'claude', { ppid: livePid() })
        await join(a)
        await join(b)
        await rename(a, 'carol')
        expect(await errorCode(rename(b, 'carol', true))).toBe('SUMMIT_NAME_TAKEN')
    })

    it('an OpenCode holder (alive unknown) loses its name only with force, then sends under its uuid', async () => {
        const oc = callFor(root, 'opencode', { meta: opencodeMeta('ses_old') })
        const joc = await join(oc)
        await rename(oc, 'dave')
        const b = callFor(root, 'claude', { ppid: livePid() })
        const jb = await join(b)
        expect(await errorCode(rename(b, 'dave'))).toBe('SUMMIT_NAME_TAKEN')
        expect((await rename(b, 'dave', true)).takeover).toEqual({ from: joc.uuid, reason: 'forced-unknown' })
        await send(oc, { to: jb.uuid, message: 'still here' })
        expect(fs.readdirSync(jb.folder).filter((f) => f.endsWith('.md'))).toEqual([`${joc.uuid}.md`])
    })

    it('a holder that died before its first rename can be replaced in the same call as join <name>', async () => {
        const dead = await deadPid()
        const ghost = callFor(root, 'pi', { ppid: dead })
        await join(ghost)
        await rename(ghost, 'erin')
        const b = callFor(root, 'pi', { ppid: livePid() })
        await join(b)
        expect(await rename(b, 'erin')).toMatchObject({ name: 'erin' })
    })

    it('a resumed Codex thread keeps its name before its first call (D5) and refreshes its pid on any call (F1)', async () => {
        const { joined: jcx, oldServer, resumed } = await resumedCodex(root, 'cx')
        const other = callFor(root, 'claude', { ppid: livePid() })
        await join(other)
        const aliveOf = async () => (await members(other)).members.find((m) => m.uuid === jcx.uuid)?.alive
        // The old server pid is gone, but a resume may still serve the thread: unknown, never false.
        expect(await aliveOf()).toBe('unknown')
        expect(await errorCode(rename(other, 'cx'))).toBe('SUMMIT_NAME_TAKEN')
        expect(agentJson(jcx.folder).name).toBe('cx')
        await read(resumed)
        expect(agentJson(jcx.folder)).toMatchObject({ pid: resumed.pid, name: 'cx' })
        expect(await aliveOf()).toBe(true)
        expect(await errorCode(rename(other, 'cx'))).toBe('SUMMIT_NAME_TAKEN')
        // whoami refreshes too (it reads the identity without requireHost).
        patchAgentJson(jcx.folder, { pid: oldServer })
        await whoami(resumed)
        expect(agentJson(jcx.folder).pid).toBe(resumed.pid)
    })

    it('a Codex holder whose server pid is gone loses its name only with force (D5)', async () => {
        const { joined: jcx } = await resumedCodex(root, 'cy', 'T-cy')
        const other = callFor(root, 'pi', { ppid: livePid() })
        await join(other)
        expect(await errorCode(rename(other, 'cy'))).toBe('SUMMIT_NAME_TAKEN')
        expect((await rename(other, 'cy', true)).takeover).toEqual({ from: jcx.uuid, reason: 'forced-unknown' })
        expect(agentJson(jcx.folder).name).toBeNull()
    })

    it('summit_group takes a name from an OpenCode holder only with force, and says how (F8)', async () => {
        const oc = callFor(root, 'opencode', { meta: opencodeMeta('ses_x') })
        const joc = await join(oc)
        await group(oc, 'g9')
        await rename(oc, 'bob')
        const a = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        await rename(a, 'bob')
        const refused = await group(a, 'g9').catch((e: { code: string; message: string }) => e)
        expect(refused).toMatchObject({ code: 'SUMMIT_NAME_TAKEN', message: expect.stringContaining('--force') })
        const groupTool = TOOLS.find((t) => t.name === 'summit_group')!
        const res = await runTool(groupTool as never, a, { name: 'g9', force: true })
        expect(res.structuredContent).toMatchObject({
            moved: true,
            groupKey: 'g9',
            name: 'bob',
            takeover: { from: joc.uuid, reason: 'forced-unknown' },
        })
        expect(mapOf(root, 'g9')).toEqual({ bob: ja.uuid })
        expect(agentJson(path.join(root, 'g9', joc.uuid)).name).toBeNull()
    })
})
