// Unit tests for names on every OS (team review R1, D): Windows device names are refused for display
// names and group names, and names are unique ignoring letter case (each name is an inbox file name, and
// macOS and Windows file systems ignore case by default).
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { STALE_MS } from '../../src/core/freshness.js'
import { namedGroupKey } from '../../src/core/project.js'
import { formatRecord } from '../../src/core/records.js'
import { isReservedName, NameSchema } from '../../src/core/schemas.js'
import { group } from '../../src/flows/group.js'
import { join } from '../../src/flows/join.js'
import { members } from '../../src/flows/query.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { callFor, errorCode, sampleRecord, tmpRoot } from '../helpers/env.js'
import { ageBeat, mapOf, patchAgentJson, writeMap } from '../helpers/state.js'

describe('Windows device names', () => {
    it('are refused as new names and group names, in any letter case', () => {
        for (const n of ['con', 'CON', 'Prn', 'aux', 'NUL', 'com0', 'COM9', 'lpt1', 'LPT9']) {
            expect(isReservedName(n)).toBe(true)
        }
        for (const n of ['con', 'Nul', 'com1', 'LPT2']) expect(NameSchema.safeParse(n).success).toBe(false)
        for (const g of ['con', 'nul', 'com1', 'lpt9']) {
            expect(() => namedGroupKey(g)).toThrow(expect.objectContaining({ code: 'SUMMIT_BAD_GROUP' }))
        }
        for (const ok of ['console', 'com10', 'nully', 'auxiliary']) expect(isReservedName(ok)).toBe(false)
    })
})

describe('names are unique ignoring case', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })

    it('a live holder of Alice keeps alice too; mail to @ALICE reaches Alice', async () => {
        const a = callFor(root, 'claude')
        const b = callFor(root, 'claude')
        const ja = await join(a)
        const jb = await join(b)
        await rename(a, 'Alice')
        expect(await errorCode(rename(b, 'alice'))).toBe('SUMMIT_NAME_TAKEN')
        expect((await send(b, { to: '@ALICE', message: 'hi' })).to.uuid).toBe(ja.uuid)
        // The holder may change the case of its own name: one entry stays.
        await rename(a, 'alice')
        expect(mapOf(root, ja.groupKey)).toEqual({ alice: ja.uuid })
        expect(jb.groupKey).toBe(ja.groupKey)
    })

    it('a forced takeover with another case leaves one map entry, for the new holder', async () => {
        const oc = callFor(root, 'opencode', { meta: { 'ai.opencode/sessionID': 'ses_case' } })
        const joc = await join(oc)
        await rename(oc, 'Bob')
        const b = callFor(root, 'claude')
        const jb = await join(b)
        expect((await rename(b, 'bob', true)).takeover).toEqual({ from: joc.uuid, reason: 'forced-unknown' })
        expect(mapOf(root, jb.groupKey)).toEqual({ bob: jb.uuid })
    })
})

describe('maps and data written by older versions', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })

    // Purpose: two live agents A and B in one group, and the group key.
    async function twoAgents() {
        const a = callFor(root, 'claude')
        const b = callFor(root, 'claude')
        const ja = await join(a)
        const jb = await join(b)
        return { a, b, ja, jb, g: ja.groupKey }
    }

    it('a case pair {Bob: X, bob: Y}: @bob reaches Y, Y cannot re-claim bob while X lives, a third agent is refused', async () => {
        const { a, b, ja, jb, g } = await twoAgents()
        writeMap(root, g, { Bob: ja.uuid, bob: jb.uuid })
        expect((await send(a, { to: '@bob', message: 'to Y' })).to.uuid).toBe(jb.uuid)
        expect((await send(b, { to: '@Bob', message: 'to X' })).to.uuid).toBe(ja.uuid)
        // Y's own exact entry does not end the judging: X (alive) holds the name too.
        expect(await errorCode(rename(b, 'bob'))).toBe('SUMMIT_NAME_TAKEN')
        expect(mapOf(root, g)).toEqual({ Bob: ja.uuid, bob: jb.uuid })
        const z = callFor(root, 'claude')
        await join(z)
        const err = await rename(z, 'BOB', true).catch((e: { code: string; message: string }) => e)
        expect(err).toMatchObject({ code: 'SUMMIT_NAME_TAKEN', message: expect.stringContaining('letter case') })
        expect(mapOf(root, g)).toEqual({ Bob: ja.uuid, bob: jb.uuid })
    })

    it('{Bob: me, bob: gone X}: re-claiming Bob is refused without force; with force bob is taken over', async () => {
        const { a, ja, jb, g } = await twoAgents()
        writeMap(root, g, { Bob: ja.uuid, bob: jb.uuid })
        ageBeat(root, jb.hostKey, STALE_MS * 3)
        expect(await errorCode(rename(a, 'Bob'))).toBe('SUMMIT_NAME_TAKEN')
        expect(await rename(a, 'Bob', true)).toMatchObject({ takeover: { from: jb.uuid, reason: 'holder-gone' } })
        expect(mapOf(root, g)).toEqual({ Bob: ja.uuid })
    })

    it('@bob that names exactly a gone holder while Bob lives: queued, with a note', async () => {
        const { a, jb, g } = await twoAgents()
        const c = callFor(root, 'claude')
        const jc = await join(c)
        writeMap(root, g, { Bob: jb.uuid, bob: jc.uuid })
        ageBeat(root, jc.hostKey, STALE_MS * 3)
        const res = await send(a, { to: '@bob', message: 'for the gone one' })
        expect(res).toMatchObject({
            to: { uuid: jc.uuid },
            wake: 'queued',
            note: expect.stringContaining('not active'),
        })
    })

    it('a claim of bob over {bob: leftover, Bob: X live} never deletes the entry of X', async () => {
        const { b, ja, g } = await twoAgents()
        writeMap(root, g, { bob: '99999999-9999-4999-8999-999999999999', Bob: ja.uuid })
        expect(await errorCode(rename(b, 'bob'))).toBe('SUMMIT_NAME_TAKEN')
        expect(mapOf(root, g).Bob).toBe(ja.uuid)
    })

    it('an agent alone with its name changes its letter case: one entry stays', async () => {
        const { b, jb, g } = await twoAgents()
        await rename(b, 'bob')
        expect(await rename(b, 'Bob')).toMatchObject({ name: 'Bob', previousName: 'bob' })
        expect(mapOf(root, g)).toEqual({ Bob: jb.uuid })
    })

    it('an agent named aux by an older version stays readable, gets mail, and renames away; aux cannot be claimed', async () => {
        const { a, b, ja, jb, g } = await twoAgents()
        patchAgentJson(jb.folder, { name: 'aux' })
        writeMap(root, g, { aux: jb.uuid })
        expect((await members(a)).members.find((m) => m.uuid === jb.uuid)?.name).toBe('aux')
        expect((await send(a, { to: '@aux', message: 'still reachable' })).to.uuid).toBe(jb.uuid)
        // Mail it sent as `aux` before the upgrade is still mail, not a corrupt span.
        const old = formatRecord(sampleRecord({ from: 'bob', fromId: jb.uuid })).replace('from: bob', 'from: aux')
        fs.appendFileSync(path.join(ja.folder, `${jb.uuid}.md`), old)
        expect((await read(a)).messages.map((m) => m.from)).toEqual(['aux'])
        expect(await errorCode(group(b, 'g-aux'))).toBe('SUMMIT_BAD_NAME')
        expect(await rename(b, 'auxiliary')).toMatchObject({ name: 'auxiliary', previousName: 'aux' })
        expect(await errorCode(rename(a, 'aux'))).toBe('SUMMIT_BAD_NAME')
    })
})
