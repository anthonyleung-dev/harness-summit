// Unit tests for the inbox through the flows: a damaged inbox never blocks a send or a read (REVIEW
// M2), foreign files are ignored, and two parallel reads never return a record twice (REVIEW m13).
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import { writeCursor } from '../../src/core/mailbox.js'
import { formatRecord } from '../../src/core/records.js'
import { join } from '../../src/flows/join.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { callFor, recordingExec, sampleRecord, tmpRoot } from '../helpers/env.js'

describe('damaged inbox', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })

    it('a torn append in one sender file: every send still works, the read returns the rest and reports the damage', async () => {
        const exec = recordingExec()
        const r = callFor(root, 'claude', { exec })
        const a = callFor(root, 'claude', { exec })
        const b = callFor(root, 'claude', { exec })
        const jr = await join(r)
        await join(a)
        await join(b)
        await rename(a, 'alice')
        const torn = formatRecord(sampleRecord({ body: 'x'.repeat(200) })).slice(0, 260)
        fs.appendFileSync(path.join(jr.folder, 'alice.md'), torn)
        expect((await send(a, { to: jr.uuid, message: 'after crash' })).wake).toBe('sent')
        expect((await send(b, { to: jr.uuid, message: 'from bob' })).delivered).toBe(true)
        const got = await read(r)
        expect(got.messages.map((m) => m.body).sort()).toEqual(['after crash', 'from bob'])
        expect(got.corrupt).toEqual([
            { file: path.join(jr.folder, 'alice.md'), offset: 0, length: 260, reason: 'no trailer' },
        ])
        expect((await read(r)).corrupt).toEqual([])
    })

    it('a foreign file in the folder is never parsed; a stray name-shaped .md file is skipped as corrupt', async () => {
        const r = callFor(root, 'claude')
        const a = callFor(root, 'claude')
        const jr = await join(r)
        await join(a)
        fs.writeFileSync(path.join(jr.folder, 'notes on the task.md'), 'not a record\n')
        fs.writeFileSync(path.join(jr.folder, 'NOTES.md'), '# my notes\n')
        await send(a, { to: jr.uuid, message: 'hello' })
        const got = await read(r)
        expect(got.messages.map((m) => m.body)).toEqual(['hello'])
        expect(got.corrupt.map((c) => path.basename(c.file))).toEqual(['NOTES.md'])
    })
})

describe('cursor', () => {
    it('a cursor write into a folder that moved away fails and never recreates the folder', async () => {
        const gone = path.join(tmpRoot(), 'g', '11111111-1111-4111-8111-111111111111')
        await expect(writeCursor(gone, { 'a.md': 1 })).rejects.toMatchObject({ code: 'SUMMIT_IO' })
        expect(fs.existsSync(gone)).toBe(false)
    })
})

describe('parallel reads', () => {
    it('two summit_read calls of one agent at once never return a record twice', async () => {
        const root = tmpRoot()
        const r = callFor(root, 'claude')
        const a = callFor(root, 'claude')
        const jr = await join(r)
        await join(a)
        for (let round = 0; round < 10; round++) {
            await send(a, { to: jr.uuid, message: `m${round}` })
            const [x, y] = await Promise.all([read(r), read(r)])
            expect(x.count + y.count).toBe(1)
        }
        expect(fs.existsSync(path.join(jr.folder, '.cursor.lock'))).toBe(false)
    })
})
