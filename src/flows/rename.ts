// summit_rename (SPEC §2, §5): set the display name in the group's name map.
//
// Name takeover (REVIEW M5; owner decision 2026-10-10): a live holder (`alive: true`) always keeps its
// name. Any other holder (`alive: false`: no server beat it for STALE_MS; `"unknown"`: OpenCode, or an
// agent never beaten) loses it only with `force`, because its session may be resumed later and expect its
// name back. A forced takeover of a holder that looks gone takes the second look first (a beat during it
// means alive: refused). The holder keeps its folder; its map entry goes
// and its agent.json name becomes null, so it can never write a second `<name>.md` next to the new
// holder. The result says why a name was taken over (`takeover.reason`, O1).
//
// A map entry whose uuid has no folder in THAT group is free, and every claim drops such entries
// (F6): a group move holds the new group's lock from its claim until its folder is in place
// (src/flows/group.ts), so outside the lock an entry without a folder is always a leftover.
import { agentExists, isAlive, readAgent, requireAgent, updateAgent } from '../core/agents.js'
import { summitError } from '../core/errors.js'
import { log } from '../core/log.js'
import {
    applyMembersUpdate,
    nameKey,
    updateMembers,
    withName,
    withoutUuid,
    type MembersUpdate,
} from '../core/members.js'
import { pipe, step } from '../core/pipe.js'
import { NameSchema, type AgentRecord, type Members, type Takeover, type TakeoverReason } from '../core/schemas.js'
import { hostKeyStep, need, requireHostStep, type CallContext, type WithHost } from './context.js'

export interface RenameResult {
    uuid: string
    name: string
    previousName: string | null
    groupKey: string
    takeover: Takeover | null
}

// A name that a claim took over: the holder's agent.json as it was before the takeover (so a failed
// call can give the name back, restoreHolder) and why the name was free (O1).
export interface TakenOver {
    holder: AgentRecord
    reason: TakeoverReason
}

interface RenameCtx extends WithHost {
    name: string
    force: boolean
    agent?: AgentRecord
    takenOver?: TakenOver
}

export interface ClaimOptions {
    force?: boolean
    // Called under the members lock when the claim took the name over.
    onTakeover?: (taken: TakenOver) => void
}

// Purpose: the result form of a takeover (O1): the holder's uuid and the reason, or null.
export function takeoverOf(taken: TakenOver | undefined): Takeover | null {
    return taken === undefined ? null : { from: taken.holder.uuid, reason: taken.reason }
}

// Purpose: refuse names that cannot be file names or that look like a uuid (the one NameSchema).
export function validateName(name: string): string {
    const parsed = NameSchema.safeParse(name)
    if (!parsed.success) {
        throw summitError('SUMMIT_BAD_NAME', parsed.error.issues[0]?.message ?? 'bad name', 'validateName', { name })
    }
    return parsed.data
}

// Purpose: the current holder of `name` when it is another agent whose folder is in this group.
// Null when free (no entry, our own entry, or a leftover entry without a folder here, F6).
async function nameHolder(root: string, groupKey: string, m: Members, name: string, uuid: string) {
    const key = nameKey(m, name)
    const owner = key === undefined ? undefined : m.members[key]
    if (owner === undefined || owner === uuid) return null
    const agent = await readAgent(root, groupKey, owner)
    return agent === null ? null : { agent, groupKey }
}

// Purpose: drop every map entry whose uuid has no folder in this group (F6). Caller holds the lock.
async function withoutLeftovers(root: string, groupKey: string, m: Members): Promise<Members> {
    const members: Record<string, string> = {}
    for (const [name, uuid] of Object.entries(m.members)) {
        if (await agentExists(root, groupKey, uuid)) members[name] = uuid
        else log('warn', 'withoutLeftovers', 'dropping a map entry without a folder', { groupKey, name, uuid })
    }
    return { version: 1, members }
}

// Purpose: fail with SUMMIT_NAME_TAKEN while the holder of `name` may be alive; return the holder to
// take over and why it may be taken (or null when the name is free).
export async function assertNameFree(
    root: string,
    groupKey: string,
    m: Members,
    name: string,
    uuid: string,
    force = false,
): Promise<{ agent: AgentRecord; groupKey: string; reason: TakeoverReason } | null> {
    const holder = await nameHolder(root, groupKey, m, name, uuid)
    if (holder === null) return null
    // Without force, any holder keeps the name: no second look is needed to refuse.
    const alive = await isAlive(root, holder.agent, { confirm: force })
    if (alive === true || !force) {
        const hint =
            alive === true
                ? ''
                : `; its holder is not alive now (alive: ${String(alive)}) but its session may resume; pass force (\`--force\` with /sr or /sg) to take the name over`
        throw summitError(
            'SUMMIT_NAME_TAKEN',
            `name ${name} belongs to another agent in ${groupKey}${hint}`,
            'assertNameFree',
            { name, groupKey, owner: holder.agent.uuid, alive },
        )
    }
    log('warn', 'assertNameFree', 'taking over a name', {
        name,
        groupKey,
        owner: holder.agent.uuid,
        alive,
    })
    return { ...holder, reason: alive === false ? 'holder-gone' : 'forced-unknown' }
}

// Purpose: a members.json update that maps `name` to `uuid` (and drops the uuid's old name), taking
// the name over from a gone holder. Shared by rename and group move.
export function claimName(
    root: string,
    groupKey: string,
    name: string,
    uuid: string,
    opts: ClaimOptions = {},
): MembersUpdate {
    return async (m) => {
        const holder = await assertNameFree(root, groupKey, m, name, uuid, opts.force)
        if (holder !== null) {
            // Never creates a folder: the holder may have moved or left (updateAgent returns null).
            await updateAgent(root, holder.groupKey, holder.agent.uuid, { name: null }, { lockHeld: true }).catch(
                (err) => log('warn', 'claimName', 'could not clear the old holder name', { error: String(err) }),
            )
            opts.onTakeover?.({ holder: holder.agent, reason: holder.reason })
        }
        return withName(withoutUuid(await withoutLeftovers(root, groupKey, m), uuid), name, uuid)
    }
}

// Purpose: undo a claim of `name` by `uuid` (F7, G2): drop the claimer's map entry and give a name
// that the claim took over back to its holder (map entry and agent.json name). Caller holds the
// group's lock. Shared by rename (its folder left the group) and the group move (a later step failed).
export async function restoreHolder(
    root: string,
    groupKey: string,
    name: string,
    uuid: string,
    taken: TakenOver | undefined,
): Promise<void> {
    await applyMembersUpdate(root, groupKey, (m) => {
        const next = withoutUuid(m, uuid)
        return taken === undefined ? next : withName(next, taken.holder.name ?? name, taken.holder.uuid)
    })
    if (taken === undefined || taken.holder.name === null) return
    const { holder } = taken
    const restored = await updateAgent(root, groupKey, holder.uuid, { name: holder.name }, { lockHeld: true })
    if (restored !== null)
        log('warn', 'restoreHolder', 'taken-over name given back', { groupKey, uuid: holder.uuid, name })
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
    taken: TakenOver | undefined,
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
    let takenOver: TakenOver | undefined
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
