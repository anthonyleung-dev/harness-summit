// Read-only tools: summit_whoami and summit_members (SPEC §2, §3, §7).
import { isAlive, listAgents, readAgent, type Alive } from '../core/agents.js'
import { loadHost } from '../core/identity.js'
import { log } from '../core/log.js'
import { mailboxOf } from '../core/paths.js'
import { pipe, step } from '../core/pipe.js'
import type { AgentRecord } from '../core/schemas.js'
import { hostKeyStep, need, refreshCallerPid, requireHostStep, type CallContext, type WithHost } from './context.js'

export type WhoamiResult =
    | { joined: false; hostKey: string }
    | {
          joined: true
          hostKey: string
          uuid: string
          name: string | null
          groupKey: string
          folder: string
          harness: string
      }

export interface Member {
    name: string | null
    uuid: string
    harness: string
    alive: Alive
    self: boolean
}

export interface MembersResult {
    groupKey: string
    members: Member[]
}

interface WhoamiCtx extends WithHost {
    agent?: AgentRecord | null
}

// Step: load the identity without failing when there is none (stale records read as none); a joined
// caller's liveness pid is refreshed like in every other tool (F1).
const loadIdentity = step<WhoamiCtx>('loadIdentity', async (ctx) => {
    const host = await loadHost(ctx.call.root, need(ctx.hostKey, 'hostKey'))
    if (host === null) return ctx
    await refreshCallerPid(ctx.call, host)
    return { ...ctx, host }
})

// Step: load agent.json for the name.
const loadAgent = step<WhoamiCtx>('loadAgent', async (ctx) => {
    if (ctx.host === undefined) return ctx
    return { ...ctx, agent: await readAgent(ctx.call.root, ctx.host.groupKey, ctx.host.uuid) }
})

// Purpose: identity of the caller, or `{ joined: false, hostKey }`.
export async function whoami(call: CallContext): Promise<WhoamiResult> {
    const ctx = await pipe<WhoamiCtx>('whoami', { call }, [hostKeyStep(), loadIdentity, loadAgent])
    const hostKey = need(ctx.hostKey, 'hostKey')
    const host = ctx.host
    log('debug', 'whoami', 'resolved', { hostKey, uuid: host?.uuid ?? null })
    if (host === undefined) return { joined: false, hostKey }
    return {
        joined: true,
        hostKey,
        uuid: host.uuid,
        name: ctx.agent?.name ?? null,
        groupKey: host.groupKey,
        folder: mailboxOf(call.root, host),
        harness: host.harness,
    }
}

interface MembersCtx extends WithHost {
    members?: Member[]
}

// Step: list the group's agents with liveness (pid plus start time).
const collect = step<MembersCtx>('listAgents', async (ctx) => {
    const host = need(ctx.host, 'host')
    const agents = await listAgents(ctx.call.root, host.groupKey)
    const members = agents.map((a) => ({
        name: a.name,
        uuid: a.uuid,
        harness: a.harness,
        alive: isAlive(a),
        self: a.uuid === host.uuid,
    }))
    return { ...ctx, members }
})

// Purpose: list the members of the caller's group.
export async function members(call: CallContext): Promise<MembersResult> {
    const ctx = await pipe<MembersCtx>('members', { call }, [hostKeyStep(), requireHostStep(), collect])
    log('debug', 'members', 'listed', { count: need(ctx.members, 'members').length })
    return { groupKey: need(ctx.host, 'host').groupKey, members: need(ctx.members, 'members') }
}
