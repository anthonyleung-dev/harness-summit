// Unit tests: record format and the tolerant parser (REVIEW M2: damaged content never throws).
import { describe, expect, it } from 'vitest'

import { formatRecord, parseRecords } from '../../src/core/records.js'
import { sampleRecord as rec } from '../helpers/env.js'

describe('records', () => {
    it('formats the SPEC §5 header plus length and parses it back', () => {
        const text = formatRecord(rec({ replyTo: '33333333-3333-4333-8333-333333333333' }))
        expect(text).toBe(
            '---\nid: 11111111-1111-4111-8111-111111111111\nfrom: alice\nfromId: 22222222-2222-4222-8222-222222222222\nto: bob\nat: 2026-10-10T00:00:00.000Z\nreplyTo: 33333333-3333-4333-8333-333333333333\nlength: 5\n---\nhello\n\n',
        )
        expect(parseRecords(Buffer.from(text)).records[0]).toEqual(
            rec({ replyTo: '33333333-3333-4333-8333-333333333333' }),
        )
    })

    it('reads bodies with fences and multibyte text, and leaves a record still being appended unconsumed', () => {
        const a = formatRecord(rec({ body: '---\nid: fake\n---\n日本語 ✓' }))
        const b = formatRecord(rec({ body: 'second' }))
        for (const cut of [2, 20, b.length - 1]) {
            const parsed = parseRecords(Buffer.from(a + b.slice(0, cut)))
            expect(parsed.records.map((r) => r.body)).toEqual(['---\nid: fake\n---\n日本語 ✓'])
            expect(parsed.consumed).toBe(Buffer.byteLength(a))
            expect(parsed.corrupt).toEqual([])
        }
    })

    it('never throws on garbage: reports it as one corrupt span and consumes it', () => {
        const parsed = parseRecords(Buffer.from('garbage\nnotes a model wrote\n'))
        expect(parsed.records).toEqual([])
        expect(parsed.corrupt).toEqual([{ offset: 0, length: 28, reason: 'no fence' }])
        expect(parsed.consumed).toBe(28)
    })

    it('a torn record followed by a full one: the torn bytes are skipped, the next record is read (body cut)', () => {
        const torn = formatRecord(rec({ body: 'x'.repeat(200) })).slice(0, 260)
        const next = formatRecord(rec({ id: '44444444-4444-4444-8444-444444444444', body: 'after crash' }))
        const parsed = parseRecords(Buffer.from(torn + next))
        expect(parsed.records.map((r) => r.body)).toEqual(['after crash'])
        expect(parsed.corrupt).toEqual([{ offset: 0, length: 260, reason: 'no trailer' }])
        expect(parsed.consumed).toBe(260 + Buffer.byteLength(next))
    })

    it('a torn long record whose declared end is past the file end does not block the records after it', () => {
        const torn = formatRecord(rec({ body: 'y'.repeat(5000) })).slice(0, 300)
        const next = formatRecord(rec({ id: '66666666-6666-4666-8666-666666666666', body: 'not stuck' }))
        const parsed = parseRecords(Buffer.from(torn + next))
        expect(parsed.records.map((r) => r.body)).toEqual(['not stuck'])
        expect(parsed.corrupt).toEqual([{ offset: 0, length: 300, reason: 'torn record' }])
    })

    it('a record cut inside its header is skipped and never merged with the next header', () => {
        const torn = formatRecord(rec({ body: 'lost' })).slice(0, 120)
        const next = formatRecord(rec({ id: '55555555-5555-4555-8555-555555555555', body: 'kept' }))
        const parsed = parseRecords(Buffer.from(torn + next))
        expect(parsed.records).toEqual([rec({ id: '55555555-5555-4555-8555-555555555555', body: 'kept' })])
        expect(parsed.corrupt).toHaveLength(1)
        expect(parsed.corrupt[0]).toMatchObject({ offset: 0, length: 120, reason: 'bad header' })
    })

    it('a record with a wrong length (no trailer where it should end) is corrupt, the rest is read', () => {
        const bad = formatRecord(rec({ body: 'abc' })).replace('length: 3', 'length: 2')
        const good = formatRecord(rec({ body: 'fine' }))
        const parsed = parseRecords(Buffer.from(bad + good))
        expect(parsed.records.map((r) => r.body)).toEqual(['fine'])
        expect(parsed.corrupt[0]).toMatchObject({ offset: 0, reason: 'no trailer' })
    })
})
