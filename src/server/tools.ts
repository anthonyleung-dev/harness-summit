// The eight MCP tools (SPEC §2): Zod input and output schemas plus the flow each one runs.
import { z } from 'zod'

import { summitError } from '../core/errors.js'
import { log } from '../core/log.js'
import { CorruptSpanSchema, NameSchema, TakeoverSchema, UuidSchema } from '../core/schemas.js'
import { bye } from '../flows/bye.js'
import type { CallContext } from '../flows/context.js'
import { group } from '../flows/group.js'
import { join } from '../flows/join.js'
import { members, whoami } from '../flows/query.js'
import { read } from '../flows/read.js'
import { rename } from '../flows/rename.js'
import { send, type SendInput as FlowSendInput } from '../flows/send.js'

export interface ToolDef<I extends z.ZodObject, O extends z.ZodObject> {
    name: string
    description: string
    input: I
    output: O
    run: (call: CallContext, input: z.infer<I>) => Promise<z.infer<O>>
}

// Purpose: keep the generic types of one tool definition intact.
function defineTool<I extends z.ZodObject, O extends z.ZodObject>(def: ToolDef<I, O>): ToolDef<I, O> {
    return def
}

const Empty = z.object({})
const Alive = z.union([z.boolean(), z.literal('unknown')])
// The `force` input of summit_rename and summit_group (one rule, F8): take a name over from a holder
// whose liveness is unknown.
const FORCE_RULE =
    'force takes over a name whose holder has unknown liveness (OpenCode, or Codex with its server gone).'
const Force = z.boolean().optional().describe('Take over the name even when its holder may be alive')
// A takeover in a summit_rename or summit_group result, with its reason (O1).
const TakeoverOutput = TakeoverSchema.nullable().describe(
    'The name was taken over: from = the old holder, reason = holder-gone (its process is gone) or ' +
        'forced-unknown (liveness unknown, force given). null when the name was free',
)

export const JoinOutput = z.object({
    uuid: UuidSchema,
    name: z.string().nullable(),
    groupKey: z.string(),
    hostKey: z.string(),
    harness: z.string(),
    folder: z.string(),
    alreadyJoined: z.boolean(),
    guidance: z.string(),
})

// The published input of summit_send. `body` is an alias of `message`, because a model that just read
// `body` in summit_read mirrors it. Neither is `required` in the JSON schema: harnesses (OMP) check
// that schema on the client, so a required `message` would reject `{ to, body }` before the server
// sees it. toSendInput enforces "exactly one, non-empty" instead.
export const SendInput = z.object({
    to: z.string().min(1).describe('Receiver: @name, name, or uuid'),
    message: z.string().optional().describe('Message text. Give exactly one of message or body'),
    body: z.string().optional().describe('Alias of message. Give exactly one of message or body'),
    replyTo: UuidSchema.optional().describe('Id of the message this answers'),
})

// Purpose: normalize the summit_send input to the flow DTO (`message` only), so the flow never sees
// `body`. Exactly one of message and body, non-empty, else SUMMIT_BAD_INPUT naming both fields.
export function toSendInput(input: z.infer<typeof SendInput>): FlowSendInput {
    const given = [input.message, input.body].filter((v) => v !== undefined)
    const text = given[0]
    if (given.length !== 1 || text === undefined || text.length === 0) {
        log('info', 'toSendInput', 'bad message/body', {
            message: input.message !== undefined,
            body: input.body !== undefined,
        })
        throw summitError(
            'SUMMIT_BAD_INPUT',
            'summit_send needs exactly one of message or body, and it must not be empty',
            'toSendInput',
            { to: input.to, message: input.message, body: input.body },
        )
    }
    return { to: input.to, message: text, ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}) }
}

export const SendOutput = z.object({
    id: UuidSchema,
    delivered: z.literal(true),
    to: z.object({ uuid: UuidSchema, name: z.string().nullable() }),
    wake: z.enum(['sent', 'skipped', 'failed']),
    wakeError: z.string().optional(),
})

// One record of summit_read. `replyHint` is there exactly when the record is not a reply (D1).
const ReadMessage = z
    .object({
        id: UuidSchema,
        from: z.string(),
        fromId: UuidSchema,
        at: z.string(),
        replyTo: UuidSchema.nullable(),
        body: z.string(),
        replyHint: z.string().optional().describe('How to answer; absent on a message that is itself a reply'),
    })
    .refine((m) => (m.replyHint === undefined) === (m.replyTo !== null), {
        message: 'replyHint only on a message that is not a reply',
        path: ['replyHint'],
    })

export const ReadOutput = z.object({
    count: z.number().int(),
    messages: z.array(ReadMessage),
    corrupt: z.array(CorruptSpanSchema),
    guidance: z.string(),
})

// MCP needs an object at the top of an output schema, so the two shapes of the result (joined or
// not) are one object whose identity fields are required exactly when `joined` is true.
const WHOAMI_IDENTITY = ['uuid', 'name', 'groupKey', 'folder', 'harness'] as const
export const WhoamiOutput = z
    .object({
        joined: z.boolean(),
        hostKey: z.string(),
        uuid: UuidSchema.optional(),
        name: z.string().nullable().optional(),
        groupKey: z.string().optional(),
        folder: z.string().optional(),
        harness: z.string().optional(),
    })
    .superRefine((v, c) => {
        for (const k of WHOAMI_IDENTITY) {
            if (v.joined === (v[k] === undefined)) {
                c.addIssue({
                    code: 'custom',
                    path: [k],
                    message: v.joined ? 'required when joined' : 'only when joined',
                })
            }
        }
    })

export const TOOLS = [
    defineTool({
        name: 'summit_join',
        description:
            'Join the harness-summit group of this project. Safe to call again: returns the existing identity. ' +
            'The result carries guidance for summit mail.',
        input: Empty,
        output: JoinOutput,
        run: (call) => join(call),
    }),
    defineTool({
        name: 'summit_group',
        description:
            'Leave the current group and move into the named group (lowercase letters, digits, dashes). ' +
            `The agent's name moves with it; ${FORCE_RULE}`,
        input: z.object({
            name: z.string().min(1).describe('Group name'),
            force: Force,
        }),
        output: z.object({
            uuid: UuidSchema,
            groupKey: z.string(),
            previousGroupKey: z.string(),
            name: z.string().nullable(),
            folder: z.string(),
            moved: z.boolean(),
            takeover: TakeoverOutput,
        }),
        run: (call, input) => group(call, input.name, input.force === true),
    }),
    defineTool({
        name: 'summit_rename',
        description:
            "Set this agent's display name in its group. A name held by an agent that is gone is taken over; " +
            FORCE_RULE,
        input: z.object({
            name: NameSchema.describe('Display name: letters, digits, _ and -, max 32'),
            force: Force,
        }),
        output: z.object({
            uuid: UuidSchema,
            name: z.string(),
            previousName: z.string().nullable(),
            groupKey: z.string(),
            takeover: TakeoverOutput,
        }),
        run: (call, input) => rename(call, input.name, input.force === true),
    }),
    defineTool({
        name: 'summit_send',
        description: 'Send a message to another agent of this group. The receiver is woken to read it.',
        input: SendInput,
        output: SendOutput,
        run: (call, input) => send(call, toSendInput(input)),
    }),
    defineTool({
        name: 'summit_read',
        description: 'Return unread messages (oldest first) and mark them read, with guidance for summit mail.',
        input: Empty,
        output: ReadOutput,
        run: (call) => read(call),
    }),
    defineTool({
        name: 'summit_members',
        description: 'List the members of the current group: name, uuid, harness, alive.',
        input: Empty,
        output: z.object({
            groupKey: z.string(),
            members: z.array(
                z.object({
                    name: z.string().nullable(),
                    uuid: UuidSchema,
                    harness: z.string(),
                    alive: Alive,
                    self: z.boolean(),
                }),
            ),
        }),
        run: (call) => members(call),
    }),
    defineTool({
        name: 'summit_whoami',
        description: "Return this agent's uuid, name, group and folder, or joined=false.",
        input: Empty,
        output: WhoamiOutput,
        run: (call) => whoami(call),
    }),
    defineTool({
        name: 'summit_bye',
        description: "Leave the summit: remove this agent's folder and name.",
        input: Empty,
        output: z.object({ uuid: UuidSchema, groupKey: z.string(), removed: z.literal(true) }),
        run: (call) => bye(call),
    }),
]

export const TOOL_NAMES = TOOLS.map((t) => t.name)
