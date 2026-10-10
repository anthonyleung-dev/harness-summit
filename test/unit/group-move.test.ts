// Unit tests for the recoverable group move (REVIEW M1): concurrent moves never strand an inbox, and a
// failed step undoes the steps before it.
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { readHost } from '../../src/core/identity.js'
import { readMembers } from '../../src/core/members.js'
import { group } from '../../src/flows/group.js'
import { join } from '../../src/flows/join.js'
import { whoami } from '../../src/flows/query.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { callFor, errorCode, livePid, tmpRoot } from '../helpers/env.js'
import { foldersOf } from '../helpers/state.js'

describe('group move', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })

    it('two agents with the same name move into one group at once: one wins, the loser stays whole', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const b = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        const jb = await join(b)
        await rename(a, 'same')
        await group(b, 'g1')
        await rename(b, 'same')
        const out = await Promise.all([errorCode(group(a, 'g3')), errorCode(group(b, 'g3'))])
        expect([...out].sort()).toEqual(['NO ERROR', 'SUMMIT_NAME_TAKEN'])
        const [winner, loser, loserCall, loserGroup] =
            out[0] === 'NO ERROR' ? [ja, jb, b, 'g1'] : [jb, ja, a, ja.groupKey]
        expect((await readMembers(root, 'g3')).members).toEqual({ same: winner.uuid })
        expect(foldersOf(root, loser.uuid)).toEqual([loserGroup])
        expect(await readHost(root, loser.hostKey)).toMatchObject({ groupKey: loserGroup })
        expect((await readMembers(root, loserGroup)).members.same).toBe(loser.uuid)
        expect(await whoami(loserCall)).toMatchObject({ joined: true, groupKey: loserGroup, name: 'same' })
        expect(await join(loserCall)).toMatchObject({ alreadyJoined: true, groupKey: loserGroup })
        expect(foldersOf(root, loser.uuid)).toEqual([loserGroup])
    })

    it('a failed folder move undoes the name claim; the inbox and the old map stay as they were', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const s = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        await join(s)
        await rename(a, 'mover')
        await send(s, { to: '@mover', message: 'kept' })
        fs.mkdirSync(path.join(root, 'g5', ja.uuid), { recursive: true })
        expect(await errorCode(group(a, 'g5'))).toBe('SUMMIT_IO')
        expect((await readMembers(root, 'g5')).members).toEqual({})
        expect((await readMembers(root, ja.groupKey)).members).toEqual({ mover: ja.uuid })
        expect(await readHost(root, ja.hostKey)).toMatchObject({ groupKey: ja.groupKey })
        expect((await read(a)).messages.map((m) => m.body)).toEqual(['kept'])
    })

    it('a move completes in order: new map, folder, host record, then the old map is released', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        await rename(a, 'walker')
        expect(await group(a, 'g7')).toMatchObject({ moved: true, groupKey: 'g7', name: 'walker' })
        expect((await readMembers(root, 'g7')).members).toEqual({ walker: ja.uuid })
        expect((await readMembers(root, ja.groupKey)).members).toEqual({})
        expect(foldersOf(root, ja.uuid)).toEqual(['g7'])
        expect(await readHost(root, ja.hostKey)).toMatchObject({ groupKey: 'g7' })
    })
})
