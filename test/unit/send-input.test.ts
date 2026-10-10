// summit_send input: `body` is an alias of `message`, exactly one of the two, normalized to `message`
// at the boundary (OMP mirrored summit_read's `body`, 2026-10-10).
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { SummitError } from '../../src/core/errors.js'
import { JOIN_INSTRUCTION, REPLY_TO_RULE, SUMMIT_GUIDANCE } from '../../src/core/notice.js'
import { HARNESSES } from '../../src/core/schemas.js'
import { replyHint } from '../../src/flows/read.js'
import { renderCommands } from '../../src/install/render.js'
import { SendInput, toSendInput } from '../../src/server/tools.js'

const TO = '11111111-1111-4111-8111-111111111111'
const ID = '22222222-2222-4222-8222-222222222222'

// Purpose: the structured error toSendInput throws for an input, or null when it passes.
function errorOf(input: z.infer<typeof SendInput>): SummitError | null {
    try {
        toSendInput(input)
        return null
    } catch (err) {
        return err as SummitError
    }
}

describe('summit_send input', () => {
    it('publishes a JSON schema that does not require message, so `{ to, body }` passes a client check', () => {
        const schema = z.toJSONSchema(SendInput) as { required?: string[]; properties: Record<string, unknown> }
        expect(schema.required).toEqual(['to'])
        expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['message', 'body']))
        expect(SendInput.safeParse({ to: TO, body: 'hi' }).success).toBe(true)
    })

    it('normalizes body and message to message', () => {
        expect(toSendInput({ to: TO, body: 'hi' })).toEqual({ to: TO, message: 'hi' })
        expect(toSendInput({ to: TO, message: 'hi', replyTo: ID })).toEqual({ to: TO, message: 'hi', replyTo: ID })
        expect(toSendInput({ to: TO, body: 'hi', replyTo: ID })).not.toHaveProperty('body')
    })

    it('refuses both, neither or an empty text with SUMMIT_BAD_INPUT naming both fields', () => {
        const bad = [{ message: 'a', body: 'b' }, {}, { message: '' }, { body: '' }, { message: '', body: 'b' }]
        for (const extra of bad) {
            const err = errorOf({ to: TO, ...extra })
            expect(err?.code, JSON.stringify(extra)).toBe('SUMMIT_BAD_INPUT')
            expect(err?.fn).toBe('toSendInput')
            expect(err?.message).toMatch(/message.*body/)
        }
    })

    it('names the `message` argument in every reply instruction', () => {
        expect(replyHint(TO, 'alice', ID)).toContain(`summit_send({ to: "${TO}", replyTo: "${ID}", message: "`)
        expect(JOIN_INSTRUCTION).toContain('message: "<your answer>"')
        expect(SUMMIT_GUIDANCE).toContain('message: "<your answer>"')
    })

    it('says replyTo is only for answers, in both voices and in every rendered join command', () => {
        // Literal on purpose: a change of the sentence must fail here, not follow the constant.
        const rule = 'Use replyTo only to answer a message; send a new request or a forwarded message without replyTo.'
        expect(REPLY_TO_RULE).toBe(rule)
        expect(JOIN_INSTRUCTION).toContain(rule)
        expect(SUMMIT_GUIDANCE).toContain(rule)
        for (const h of HARNESSES) {
            const joins = renderCommands(h).filter((f) => /(^|\/)(sj|summit-join)(\/|\.)/.test(f.rel))
            expect(joins.length, h).toBe(2)
            for (const f of joins) expect(f.content, `${h} ${f.rel}`).toContain(rule)
        }
    })
})
