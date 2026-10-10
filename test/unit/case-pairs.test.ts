// Unit tests for case pairs an older version wrote ({Bob: X, bob: Y}) (team review R3): a lookup that
// matches only by case is ambiguous, never a pick by map order; a forced claim takes the pair over only
// when EVERY holder is gone, and its undo gives every holder its name back. Also the inbox file name of
// a Windows device-named sender.
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { inboxLabel } from '../../src/core/agents.js'
import { STALE_MS } from '../../src/core/freshness.js'
import { agentDir } from '../../src/core/paths.js'
import { group } from '../../src/flows/group.js'
import { join } from '../../src/flows/join.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { callFor, errorCode, opencodeMeta, tmpRoot } from '../helpers/env.js'
import { ageBeat, agentJson, mapOf, patchAgentJson, writeMap } from '../helpers/state.js'

describe('case pairs written by older versions', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })

    // Purpose: agents X and Y in one group holding Bob and bob, a third agent Z, and the group key.
    async function pair(g = '') {
        const [x, y, z] = [callFor(root, 'claude'), callFor(root, 'claude'), callFor(root, 'claude')]
        const [jx, jy, jz] = [await join(x), await join(y), await join(z)]
        const key = g === '' ? jx.groupKey : g
        if (g !== '') for (const c of [x, y]) await group(c, g)
        patchAgentJson(agentDir(root, key, jx.uuid), { name: 'Bob' })
        patchAgentJson(agentDir(root, key, jy.uuid), { name: 'bob' })
        writeMap(root, key, { Bob: jx.uuid, bob: jy.uuid })
        return { x, y, z, jx, jy, jz, key }
    }

    it('a lookup without the exact key and with several case matches is ambiguous and names them', async () => {
        const { z } = await pair()
        const err = await send(z, { to: '@BOB', message: 'who?' }).catch((e: { code: string; message: string }) => e)
        expect(err).toMatchObject({
            code: 'SUMMIT_AMBIGUOUS_TARGET',
            message:
                'BOB matches 2 agents (Bob, bob). Send to one exact name, or to its uuid (see /sl). An agent can rename itself with /sr to clear the clash.',
        })
    })

    it('a forced claim takes the pair over when every holder is gone, and only then', async () => {
        const { z, jx, jy, key } = await pair()
        ageBeat(root, jx.hostKey, STALE_MS * 3)
        // One holder still beats: the pair stays, even with force.
        expect(await errorCode(rename(z, 'BOB', true))).toBe('SUMMIT_NAME_TAKEN')
        ageBeat(root, jy.hostKey, STALE_MS * 3)
        expect(await errorCode(rename(z, 'BOB'))).toBe('SUMMIT_NAME_TAKEN')
        const res = await rename(z, 'BOB', true)
        expect(res.takeover?.reason).toBe('holder-gone')
        expect(mapOf(root, key)).toEqual({ BOB: res.uuid })
        expect([agentJson(agentDir(root, key, jx.uuid)).name, agentJson(agentDir(root, key, jy.uuid)).name]).toEqual([
            null,
            null,
        ])
    })

    it('a pair with an unknown holder (OpenCode) is never taken over, even with force', async () => {
        const { z, jx, key } = await pair()
        const oc = callFor(root, 'opencode', { meta: opencodeMeta('ses_pair') })
        const joc = await join(oc)
        ageBeat(root, jx.hostKey, STALE_MS * 3)
        writeMap(root, key, { Bob: jx.uuid, bob: joc.uuid })
        expect(await errorCode(rename(z, 'bob', true))).toBe('SUMMIT_NAME_TAKEN')
    })

    it('a forced group move into a group whose pair is all gone takes both entries over', async () => {
        const { z, jx, jy } = await pair('g-move')
        ageBeat(root, jx.hostKey, STALE_MS * 3)
        ageBeat(root, jy.hostKey, STALE_MS * 3)
        await rename(z, 'BOB')
        expect(await errorCode(group(z, 'g-move'))).toBe('SUMMIT_NAME_TAKEN')
        const moved = await group(z, 'g-move', true)
        expect(moved).toMatchObject({ moved: true, name: 'BOB', takeover: { reason: 'holder-gone' } })
        expect(mapOf(root, 'g-move')).toEqual({ BOB: moved.uuid })
        expect(agentJson(agentDir(root, 'g-move', jx.uuid)).name).toBeNull()
        expect(agentJson(agentDir(root, 'g-move', jy.uuid)).name).toBeNull()
    })

    it('a failed group move into a pair gives BOTH holders their names back', async () => {
        const { z, jx, jy, jz } = await pair('g-pair')
        ageBeat(root, jx.hostKey, STALE_MS * 3)
        ageBeat(root, jy.hostKey, STALE_MS * 3)
        await rename(z, 'BOB')
        // moveFolder refuses: the new group already has a folder for Z.
        fs.mkdirSync(path.join(agentDir(root, 'g-pair', jz.uuid), 'x'), { recursive: true })
        expect(await errorCode(group(z, 'g-pair', true))).toBe('SUMMIT_IO')
        expect(mapOf(root, 'g-pair')).toEqual({ Bob: jx.uuid, bob: jy.uuid })
        expect(agentJson(agentDir(root, 'g-pair', jx.uuid)).name).toBe('Bob')
        expect(agentJson(agentDir(root, 'g-pair', jy.uuid)).name).toBe('bob')
    })
})

// The send path picks the inbox name with the process platform (src/flows/send.ts), so its win32 branch
// runs for real only on the Windows CI legs; here inboxLabel is checked for both platforms.
describe('inbox file name of a device-named sender', () => {
    it('on Windows a sender named aux (written by an older version) gets its uuid as the inbox name', () => {
        const uuid = '11111111-1111-4111-8111-111111111111'
        expect(inboxLabel({ name: 'aux', uuid }, 'win32')).toBe(uuid)
        expect(inboxLabel({ name: 'aux', uuid }, 'linux')).toBe('aux')
        expect(inboxLabel({ name: 'bob', uuid }, 'win32')).toBe('bob')
        expect(inboxLabel({ name: null, uuid }, 'win32')).toBe(uuid)
    })
})
