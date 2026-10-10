// Unit tests for names on every OS (team review R1, D): Windows device names are refused for display
// names and group names, and names are unique ignoring letter case (each name is an inbox file name, and
// macOS and Windows file systems ignore case by default).
import { beforeEach, describe, expect, it } from 'vitest'

import { namedGroupKey } from '../../src/core/project.js'
import { isReservedName, NameSchema } from '../../src/core/schemas.js'
import { join } from '../../src/flows/join.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { callFor, errorCode, tmpRoot } from '../helpers/env.js'
import { mapOf } from '../helpers/state.js'

describe('Windows device names', () => {
    it('are refused as names and group names, in any letter case, also with superscript digits', () => {
        for (const n of ['con', 'CON', 'Prn', 'aux', 'NUL', 'com0', 'COM9', 'lpt1', 'LPT9', 'com¹', 'lpt³']) {
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
