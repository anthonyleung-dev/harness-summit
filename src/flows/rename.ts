// summit_rename (SPEC §2, §5): set the display name in the group's name map. The claim rules (takeover,
// case pairs, leftovers) live in src/flows/claim.ts.
import { requireAgent, updateAgent } from '../core/agents.js'
import { summitError } from '../core/errors.js'
import { log } from '../core/log.js'
import { updateMembers } from '../core/members.js'
import { pipe, step } from '../core/pipe.js'
import { NameSchema, type AgentRecord, type Takeover } from '../core/schemas.js'
import { claimName, restoreHolder, takeoverOf, type TakenOver } from './claim.js'
import { hostKeyStep, need, requireHostStep, type CallContext, type WithHost } from './context.js'

export interface RenameResult {
    uuid: string
    name: string
    previousName: string | null
    groupKey: string
    takeover: Takeover | null
}

interface RenameCtx extends WithHost {
    name: string
    force: boolean
    agent?: AgentRecord
    takenOver?: TakenOver[]
}

// Purpose: refuse names that cannot be file names or that look like a uuid (the one NameSchema).
export function validateName(name: string): string {
    const parsed = NameSchema.safeParse(name)
    if (!parsed.success) {
        throw summitError('SUMMIT_BAD_NAME', parsed.error.issues[0]?.message ?? 'bad name', 'validateName', { name })
    }
    return parsed.data
}

// Step: validate the requested name.
const validate = step<RenameCtx>('validateName', (ctx) => ({ ...ctx, name: validateName(ctx.name) }))

// Step: load the caller's agent.json.
const loadAgent = step<RenameCtx>('loadAgent', async (ctx) => {
    const host = need(ctx.host, 'host')
    return { ...ctx, agent: await requireAgent(ctx.call.root, host.groupKey, host.uuid) }
})

// Purpose: set the claimed name in the caller's agent.json. Caller holds the members lock, and the map
// already names the caller. When the folder left the group during the call (a parallel summit_group,
// DELTA-REVIEW-3 E6), undo the claim (drop that map entry and give a taken-over name back, G2) and
// fail with SUMMIT_TARGET_GONE.
async function setOwnName(
    root: string,
    groupKey: string,
    uuid: string,
    name: string,
    taken: TakenOver[] | undefined,
): Promise<void> {
    if ((await updateAgent(root, groupKey, uuid, { name }, { lockHeld: true })) !== null) return
    await restoreHolder(root, groupKey, name, uuid, taken)
    log('warn', 'rename.setOwnName', 'agent folder left the group during the rename', { groupKey, uuid, name })
    throw summitError('SUMMIT_TARGET_GONE', `agent ${uuid} left ${groupKey} during rename`, 'setOwnName', {
        groupKey,
        uuid,
        name,
    })
}

// Step: claim the name and set it in agent.json (updateAgent, N3), both under the members lock so the
// map and agent.json never disagree.
const claim = step<RenameCtx>('claimName', async (ctx) => {
    const host = need(ctx.host, 'host')
    let takenOver: TakenOver[] | undefined
    await updateMembers(
        ctx.call.root,
        host.groupKey,
        claimName(ctx.call.root, host.groupKey, ctx.name, host.uuid, {
            force: ctx.force,
            onTakeover: (taken) => (takenOver = taken),
        }),
        async () => await setOwnName(ctx.call.root, host.groupKey, host.uuid, ctx.name, takenOver),
    )
    return { ...ctx, takenOver }
})

// Purpose: run the rename flow.
export async function rename(call: CallContext, name: string, force = false): Promise<RenameResult> {
    const ctx = await pipe<RenameCtx>('rename', { call, name, force }, [
        hostKeyStep(),
        requireHostStep(),
        validate,
        loadAgent,
        claim,
    ])
    const host = need(ctx.host, 'host')
    const takeover = takeoverOf(ctx.takenOver)
    log('info', 'rename', 'renamed', { uuid: host.uuid, name: ctx.name, takeover })
    return {
        uuid: host.uuid,
        name: ctx.name,
        previousName: need(ctx.agent, 'agent').name,
        groupKey: host.groupKey,
        takeover,
    }
}
