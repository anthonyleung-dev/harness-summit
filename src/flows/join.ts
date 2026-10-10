// summit_join (SPEC §2, §3): mint a uuid, create the agent folder in the project group, record the
// wake action. Idempotent per host key. The result carries the neutral mail guidance (F2, F3).
import { randomUUID } from 'node:crypto'

import { readAgent, updateAgent, writeAgent } from '../core/agents.js'
import { summitError } from '../core/errors.js'
import { codexThreadId, isSignalHarness, opencodeSessionId } from '../core/hostKey.js'
import { loadHost, writeHost } from '../core/identity.js'
import { log } from '../core/log.js'
import { SUMMIT_GUIDANCE } from '../core/notice.js'
import { mailboxOf, signalPathFor } from '../core/paths.js'
import { pipe, step } from '../core/pipe.js'
import { defaultGroupKey, projectRootOf, resolveCwd } from '../core/project.js'
import type { AgentRecord, HostRecord, Wake } from '../core/schemas.js'
import { agentPidFor, beatCaller, hostKeyStep, need, type CallContext, type WithHost } from './context.js'

export interface JoinResult {
    uuid: string
    name: string | null
    groupKey: string
    hostKey: string
    harness: string
    folder: string
    alreadyJoined: boolean
    guidance: string
}

interface JoinCtx extends WithHost {
    existing?: AgentRecord | null
    agent?: AgentRecord
}

// Purpose: the wake record for this host (SPEC §6 table).
export function wakeRecordFor(call: CallContext, hostKey: string): Wake {
    if (isSignalHarness(call.harness)) return { type: 'signal', path: signalPathFor(call.root, hostKey) }
    if (call.harness === 'codex') return { type: 'codex-queue', threadId: need(codexThreadId(call.meta), 'threadId') }
    return { type: 'opencode-prompt', sessionID: need(opencodeSessionId(call.meta), 'sessionID') }
}

// Step: load the existing identity (a moved folder is located).
const loadExisting = step<JoinCtx>('loadExisting', async (ctx) => {
    const host = await loadHost(ctx.call.root, need(ctx.hostKey, 'hostKey'))
    if (host === null) return ctx
    return { ...ctx, host, existing: await readAgent(ctx.call.root, host.groupKey, host.uuid) }
})

// Step: build agent.json and the host record: refresh an existing agent, else mint a new one.
const buildAgent = step<JoinCtx>('buildAgent', async (ctx) => {
    const { call } = ctx
    const hostKey = need(ctx.hostKey, 'hostKey')
    const base = { harness: call.harness, hostKey, pid: agentPidFor(call), wake: wakeRecordFor(call, hostKey) }
    if (ctx.existing) return { ...ctx, agent: { ...ctx.existing, ...base } }
    const { cwd, cwdSource } = await resolveCwd(call.harness, call.meta, call.exec)
    const projectRoot = projectRootOf(cwd)
    const joinedAt = new Date().toISOString()
    const agent: AgentRecord = {
        uuid: ctx.host?.uuid ?? randomUUID(),
        name: null,
        cwd,
        cwdSource,
        projectRoot,
        joinedAt,
        ...base,
    }
    const host: HostRecord = ctx.host ?? {
        uuid: agent.uuid,
        groupKey: defaultGroupKey(projectRoot),
        harness: call.harness,
        hostKey,
        joinedAt,
    }
    log('debug', 'join.buildAgent', 'new agent', { hostKey, uuid: agent.uuid, cwdSource })
    return { ...ctx, agent, host }
})

// Purpose: refresh an existing agent.json under the group lock (updateAgent, N3). Every field but the
// name is set from `agent`; the name stays what the file holds NOW, so a name takeover (which writes
// this agent's name as null under the same lock) between the load and this write is never undone.
async function refreshExisting(root: string, groupKey: string, agent: AgentRecord): Promise<AgentRecord> {
    const { name: _name, ...fields } = agent
    const now = await updateAgent(root, groupKey, agent.uuid, fields)
    if (now !== null) return now
    throw summitError('SUMMIT_TARGET_GONE', `agent ${agent.uuid} left ${groupKey} during join`, 'refreshExisting', {
        groupKey,
        uuid: agent.uuid,
    })
}

// Step: write agent.json first, then the host record (a host record never points at no folder), then
// the first heartbeat, so a fresh agent reads alive at once (SPEC §7).
const persist = step<JoinCtx>('persist', async (ctx) => {
    const host = need(ctx.host, 'host')
    const { root } = ctx.call
    let agent = need(ctx.agent, 'agent')
    if (ctx.existing) agent = await refreshExisting(root, host.groupKey, agent)
    else await writeAgent(root, host.groupKey, agent)
    await writeHost(root, host)
    await beatCaller(ctx.call, host.hostKey)
    return { ...ctx, agent }
})

// Purpose: run the join flow for one tool call.
export async function join(call: CallContext): Promise<JoinResult> {
    const ctx = await pipe<JoinCtx>('join', { call }, [hostKeyStep(), loadExisting, buildAgent, persist])
    const host = need(ctx.host, 'host')
    const agent = need(ctx.agent, 'agent')
    const alreadyJoined = ctx.existing !== undefined && ctx.existing !== null
    log('info', 'join', 'joined', { hostKey: host.hostKey, uuid: host.uuid, groupKey: host.groupKey, alreadyJoined })
    return {
        uuid: host.uuid,
        name: agent.name,
        groupKey: host.groupKey,
        hostKey: host.hostKey,
        harness: host.harness,
        folder: mailboxOf(call.root, host),
        alreadyJoined,
        guidance: SUMMIT_GUIDANCE,
    }
}
