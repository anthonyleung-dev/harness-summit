// summit_send (SPEC §5, §6): append one record to the receiver's folder, then wake the receiver.
import { randomUUID } from 'node:crypto'

import { agentExists, agentLabel, readAgent, requireAgent } from '../core/agents.js'
import { summitError } from '../core/errors.js'
import { log } from '../core/log.js'
import { appendRecord } from '../core/mailbox.js'
import { nameKey, readMembers } from '../core/members.js'
import { agentDir } from '../core/paths.js'
import { pipe, step } from '../core/pipe.js'
import { NAME_PATTERN, UUID_PATTERN, type AgentRecord, type MessageRecord } from '../core/schemas.js'
import { wakeReceiver, type WakeOutcome } from '../core/wake.js'
import { hostKeyStep, need, requireHostStep, type CallContext, type WithHost } from './context.js'

export interface SendInput {
    to: string
    message: string
    replyTo?: string
}

export type SendResult = { id: string; delivered: true; to: { uuid: string; name: string | null } } & WakeOutcome

interface SendCtx extends WithHost {
    input: SendInput
    self?: AgentRecord
    target?: AgentRecord
    record?: MessageRecord
    outcome?: WakeOutcome
}

// Purpose: turn `@name`, `name` or a uuid into the target uuid of the caller's group.
export async function resolveTarget(root: string, groupKey: string, to: string): Promise<string> {
    const raw = to.trim().replace(/^@/, '')
    // A uuid in upper case still names the same agent (the one uuid schema is lower case).
    const ref = UUID_PATTERN.test(raw.toLowerCase()) ? raw.toLowerCase() : raw
    const members = await readMembers(root, groupKey)
    if (UUID_PATTERN.test(ref)) {
        if (await agentExists(root, groupKey, ref)) return ref
        const known = Object.values(members.members).includes(ref)
        throw summitError(
            known ? 'SUMMIT_TARGET_GONE' : 'SUMMIT_UNKNOWN_TARGET',
            `no agent ${ref} in this group`,
            'resolveTarget',
            { to, groupKey },
        )
    }
    const key = NAME_PATTERN.test(ref) ? nameKey(members, ref) : undefined
    const uuid = key === undefined ? undefined : members.members[key]
    if (uuid === undefined) {
        log('info', 'resolveTarget', 'unknown name', { to, groupKey })
        throw summitError('SUMMIT_UNKNOWN_TARGET', `no agent named ${ref} in this group`, 'resolveTarget', {
            to,
            groupKey,
        })
    }
    if (!(await agentExists(root, groupKey, uuid))) {
        throw summitError('SUMMIT_TARGET_GONE', `agent ${ref} has left (folder missing)`, 'resolveTarget', {
            to,
            groupKey,
            uuid,
        })
    }
    return uuid
}

// Step: load the sender's agent.json (its label and uuid go into the record).
const loadSelf = step<SendCtx>('loadSelf', async (ctx) => {
    const host = need(ctx.host, 'host')
    return { ...ctx, self: await requireAgent(ctx.call.root, host.groupKey, host.uuid) }
})

// Step: resolve and load the receiver; refuse a self send.
const loadTarget = step<SendCtx>('loadTarget', async (ctx) => {
    const host = need(ctx.host, 'host')
    const uuid = await resolveTarget(ctx.call.root, host.groupKey, ctx.input.to)
    if (uuid === host.uuid)
        throw summitError('SUMMIT_SELF_SEND', 'cannot send to yourself', 'loadTarget', { to: ctx.input.to })
    const target = await readAgent(ctx.call.root, host.groupKey, uuid)
    if (target === null)
        throw summitError('SUMMIT_TARGET_GONE', `agent ${uuid} has left`, 'loadTarget', { to: ctx.input.to })
    return { ...ctx, target }
})

// Step: append one record to the receiver's `<sender>.md` (a single appendFile; no parsing needed).
const append = step<SendCtx>('append', async (ctx) => {
    const self = need(ctx.self, 'self')
    const target = need(ctx.target, 'target')
    const record: MessageRecord = {
        id: randomUUID(),
        from: agentLabel(self),
        fromId: self.uuid,
        to: agentLabel(target),
        at: new Date().toISOString(),
        ...(ctx.input.replyTo !== undefined ? { replyTo: ctx.input.replyTo } : {}),
        body: ctx.input.message,
    }
    await appendRecord(agentDir(ctx.call.root, need(ctx.host, 'host').groupKey, target.uuid), agentLabel(self), record)
    return { ...ctx, record }
})

// Step: wake the receiver. The notice and the debounce are computed from the receiver's state after
// the append (src/core/wake.ts); a failed wake never fails the send.
const wake = step<SendCtx>('wake', async (ctx) => {
    const target = need(ctx.target, 'target')
    const folder = agentDir(ctx.call.root, need(ctx.host, 'host').groupKey, target.uuid)
    const outcome = await wakeReceiver({ folder, wake: target.wake, exec: ctx.call.exec })
    return { ...ctx, outcome }
})

// Purpose: run the send flow.
export async function send(call: CallContext, input: SendInput): Promise<SendResult> {
    const ctx = await pipe<SendCtx>('send', { call, input }, [
        hostKeyStep(),
        requireHostStep(),
        loadSelf,
        loadTarget,
        append,
        wake,
    ])
    const record = need(ctx.record, 'record')
    const target = need(ctx.target, 'target')
    const outcome = need(ctx.outcome, 'outcome')
    log('info', 'send', 'sent', { id: record.id, to: target.uuid, wake: outcome.wake })
    return { id: record.id, delivered: true, to: { uuid: target.uuid, name: target.name }, ...outcome }
}
