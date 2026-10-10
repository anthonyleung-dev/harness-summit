// Unit tests for name takeover (REVIEW M5; owner decision 2026-10-10): a live holder keeps its name; any
// other holder (gone: no heartbeat for 10 s; unknown: OpenCode) loses it only with force, because its
// session may resume; a forced takeover of a gone holder takes the second look first; the result says why (O1). A
// rename whose own folder left the group during the call fails and gives a taken-over name back
// (DELTA-REVIEW-3 E6, DELTA-REVIEW-4 G2).
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { STALE_MS } from '../../src/core/heartbeat.js'
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
import { callFor, errorCode, opencodeMeta, tmpRoot } from '../helpers/env.js'
import { ageBeat, agentJson, mapOf, moveFolder, onMapRead } from '../helpers/state.js'

describe('name takeover', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('a rename whose folder left the group during the call fails and leaves no map entry (E6)', async () => {
        const a = callFor(root, 'claude')
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
        const a = callFor(root, 'claude')
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
        const a = callFor(root, 'claude')
        await join(a)
        const renameTool = TOOLS.find((t) => t.name === 'summit_rename')!
        const res = await runTool(renameTool as never, a, { name: 'olive', force: true })
        expect(res.structuredContent).toMatchObject({ takeover: { from: joc.uuid, reason: 'forced-unknown' } })
    })

    it('a new session takes the name of a gone agent only with force; the old folder stays, nameless', async () => {
        const old = callFor(root, 'claude')
        const jo = await join(old)
        await rename(old, 'alice')
        // The old session exited: its server stopped beating 15 s ago. It may still be resumed.
        ageBeat(root, jo.hostKey, STALE_MS + 5_000)
        const fresh = callFor(root, 'claude')
        const jf = await join(fresh)
        const refused = await rename(fresh, 'alice').catch((e: { code: string; message: string }) => e)
        expect(refused).toMatchObject({ code: 'SUMMIT_NAME_TAKEN', message: expect.stringContaining('may resume') })
        expect(await rename(fresh, 'alice', true)).toMatchObject({
            name: 'alice',
            takeover: { from: jo.uuid, reason: 'holder-gone' },
        })
        expect((await readMembers(root, jf.groupKey)).members).toEqual({ alice: jf.uuid })
        expect(fs.existsSync(jo.folder)).toBe(true)
        expect(agentJson(jo.folder).name).toBeNull()
        expect(agentJson(jf.folder).name).toBe('alice')
    })

    it('a live holder keeps its name', async () => {
        const a = callFor(root, 'claude')
        const b = callFor(root, 'claude')
        await join(a)
        await join(b)
        await rename(a, 'carol')
        expect(await errorCode(rename(b, 'carol', true))).toBe('SUMMIT_NAME_TAKEN')
    })

    it('an OpenCode holder (alive unknown) loses its name only with force, then sends under its uuid', async () => {
        const oc = callFor(root, 'opencode', { meta: opencodeMeta('ses_old') })
        const joc = await join(oc)
        await rename(oc, 'dave')
        const b = callFor(root, 'claude')
        const jb = await join(b)
        expect(await errorCode(rename(b, 'dave'))).toBe('SUMMIT_NAME_TAKEN')
        expect((await rename(b, 'dave', true)).takeover).toEqual({ from: joc.uuid, reason: 'forced-unknown' })
        await send(oc, { to: jb.uuid, message: 'still here' })
        expect(fs.readdirSync(jb.folder).filter((f) => f.endsWith('.md'))).toEqual([`${joc.uuid}.md`])
    })

    it('a forced takeover takes the second look: a holder that beats during it keeps its name', async () => {
        const holder = callFor(root, 'pi')
        const jh = await join(holder)
        await rename(holder, 'erin')
        ageBeat(root, jh.hostKey, STALE_MS + 5_000)
        const b = callFor(root, 'pi')
        await join(b)
        // The holder's laptop was asleep: its server beats again while the claimer takes its second look.
        setTimeout(() => void whoami(holder), 500)
        expect(await errorCode(rename(b, 'erin', true))).toBe('SUMMIT_NAME_TAKEN')
        expect(agentJson(jh.folder).name).toBe('erin')
    })

    it('a closed Codex thread reads gone; its first call after a resume beats and protects its name again', async () => {
        const { joined: jcx, resumed } = await resumedCodex(root, 'cx')
        const other = callFor(root, 'claude')
        await join(other)
        const aliveOf = async () => (await members(other)).members.find((m) => m.uuid === jcx.uuid)?.alive
        // No server beat the thread for longer than 10 s: gone, never "unknown" (only OpenCode is).
        expect(await aliveOf()).toBe(false)
        await read(resumed)
        expect(await aliveOf()).toBe(true)
        expect(await errorCode(rename(other, 'cx'))).toBe('SUMMIT_NAME_TAKEN')
        expect(agentJson(jcx.folder).name).toBe('cx')
        // whoami beats too (it reads the identity without requireHost).
        ageBeat(root, jcx.hostKey, STALE_MS + 5_000)
        await whoami(resumed)
        expect(await aliveOf()).toBe(true)
    })

    it('a Codex holder whose thread nobody serves loses its name only with force (holder-gone)', async () => {
        const { joined: jcx } = await resumedCodex(root, 'cy', 'T-cy')
        const other = callFor(root, 'pi')
        await join(other)
        expect(await errorCode(rename(other, 'cy'))).toBe('SUMMIT_NAME_TAKEN')
        expect((await rename(other, 'cy', true)).takeover).toEqual({ from: jcx.uuid, reason: 'holder-gone' })
        expect(agentJson(jcx.folder).name).toBeNull()
    })

    it('summit_group takes a name from an OpenCode holder only with force, and says how (F8)', async () => {
        const oc = callFor(root, 'opencode', { meta: opencodeMeta('ses_x') })
        const joc = await join(oc)
        await group(oc, 'g9')
        await rename(oc, 'bob')
        const a = callFor(root, 'claude')
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
