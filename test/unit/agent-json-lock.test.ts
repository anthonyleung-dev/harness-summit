// Unit tests: every writer of an agent.json goes through updateAgent (N3: join, the rename claim, the
// takeover, the restore on undo); a tool call's heartbeat never writes agent.json. It holds the group lock and keeps a field that
// another writer changed under that lock while it waited, instead of writing back what it loaded before.
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { updateAgent } from '../../src/core/agents.js'
import { sleep } from '../../src/core/lock.js'
import { lockGroup } from '../../src/core/members.js'
import { join } from '../../src/flows/join.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { resumedCodex } from '../helpers/agents.js'
import { callFor, tmpRoot } from '../helpers/env.js'
import { agentJson, patchAgentJson } from '../helpers/state.js'

describe('agent.json writes under the group lock', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })

    // Purpose: hold the group lock while `call` starts and another writer changes agent.json (by
    // default a takeover clears the name), then release.
    async function takeoverWhileWaiting(
        groupKey: string,
        folder: string,
        call: () => Promise<unknown>,
        patch: Record<string, unknown> = { name: null },
    ) {
        let running: Promise<unknown> | undefined
        await lockGroup(root, groupKey, async () => {
            running = call()
            await sleep(100)
            patchAgentJson(folder, patch)
        })
        await running
    }

    it('a tool call beats without writing agent.json, so a name cleared meanwhile stays cleared', async () => {
        const { joined: j, resumed } = await resumedCodex(root, 'cx')
        const before = agentJson(j.folder)
        await takeoverWhileWaiting(j.groupKey, j.folder, () => read(resumed))
        expect(agentJson(j.folder)).toEqual({ ...before, name: null })
    })

    it('a repeated join keeps a name cleared while it waited for the lock', async () => {
        const { joined: j, resumed } = await resumedCodex(root, 'cx')
        await takeoverWhileWaiting(j.groupKey, j.folder, () => join(resumed))
        expect(agentJson(j.folder)).toMatchObject({ pid: resumed.pid, name: null })
    })

    it('a rename keeps a field another writer changed while it waited for the lock (N3)', async () => {
        const b = callFor(root, 'claude')
        const jb = await join(b)
        await takeoverWhileWaiting(jb.groupKey, jb.folder, () => rename(b, 'nb'), { cwd: '/elsewhere' })
        expect(agentJson(jb.folder)).toMatchObject({ name: 'nb', cwd: '/elsewhere' })
    })

    it('updateAgent writes nothing for a null patch and never creates a missing folder (N3)', async () => {
        const b = callFor(root, 'claude')
        const jb = await join(b)
        const before = fs.readFileSync(path.join(jb.folder, 'agent.json'), 'utf8')
        expect(await updateAgent(root, jb.groupKey, jb.uuid, () => null)).toMatchObject({ uuid: jb.uuid })
        expect(fs.readFileSync(path.join(jb.folder, 'agent.json'), 'utf8')).toBe(before)
        const ghost = '00000000-0000-4000-8000-000000000001'
        expect(await updateAgent(root, jb.groupKey, ghost, { name: 'x' })).toBeNull()
        expect(fs.existsSync(path.join(root, jb.groupKey, ghost))).toBe(false)
        const held = lockGroup(root, jb.groupKey, () =>
            updateAgent(root, jb.groupKey, jb.uuid, { name: 'h' }, { lockHeld: true }),
        )
        expect(await held).toMatchObject({ name: 'h' })
    })
})
