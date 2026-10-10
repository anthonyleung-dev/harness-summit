// Name claims (SPEC §5): the one door that maps a name to an agent in a group's name map, shared by
// summit_rename and summit_group, and its undo.
//
// Names are unique ignoring letter case. A live holder (`alive: true`) always keeps its name. Any other
// holder (`alive: false`: no server beat it for STALE_MS, or its heartbeat is gone; `"unknown"`:
// OpenCode) loses it only with `force`, because its session may be resumed later. A forced takeover of
// a holder that looks gone takes the second look first (a beat during it means alive: refused). The
// holder keeps its folder; its map entry goes and its agent.json name becomes null. The result says why
// a name was taken over (`takeover.reason`, O1). A map entry whose uuid has no folder in THAT group is
// free, and every claim drops such entries (F6): a group move holds the new group's lock from its claim
// until its folder is in place (src/flows/group.ts), so outside the lock such an entry is a leftover.
import { agentExists, isAlive, readAgent, updateAgent } from '../core/agents.js'
import { summitError } from '../core/errors.js'
import { log } from '../core/log.js'
import { applyMembersUpdate, nameKeys, withName, withoutUuid, type MembersUpdate } from '../core/members.js'
import type { AgentRecord, Members, Takeover, TakeoverReason } from '../core/schemas.js'

// A name that a claim took over: the holder's agent.json as it was before the takeover (so a failed
// call can give the name back, restoreHolder), the map key it held, and why the name was free (O1).
export interface TakenOver {
    holder: AgentRecord
    key: string
    reason: TakeoverReason
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

// Purpose: the other agent whose folder is in this group and that holds `name` ignoring case, with its
// key; null when free (only our own entry, or leftovers, F6).
async function nameHolder(root: string, groupKey: string, m: Members, name: string, uuid: string) {
    for (const key of nameKeys(m, name)) {
        const owner = m.members[key] as string
        if (owner === uuid) continue
        const agent = await readAgent(root, groupKey, owner)
        if (agent !== null) return { agent, key }
    }
    return null
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

// Purpose: fail with SUMMIT_NAME_TAKEN while the holder of `name` keeps it; return the holder to take
// over and why (null when the name is free).
export async function assertNameFree(
    root: string,
    groupKey: string,
    m: Members,
    name: string,
    uuid: string,
    force = false,
): Promise<TakenOver | null> {
    const holder = await nameHolder(root, groupKey, m, name, uuid)
    if (holder === null) return null
    // Without force, any holder keeps the name: no second look is needed to refuse.
    const alive = await isAlive(root, holder.agent, { confirm: force })
    if (alive === true || !force) {
        const hint =
            alive === true
                ? ''
                : '; its holder is not alive now but its session may resume; pass force (`--force` with /sr or /sg) to take the name over'
        throw summitError(
            'SUMMIT_NAME_TAKEN',
            `name ${name} belongs to another agent in ${groupKey}${hint}`,
            'assertNameFree',
            {
                name,
                groupKey,
                owner: holder.agent.uuid,
                alive,
            },
        )
    }
    log('warn', 'assertNameFree', 'taking over a name', { name, groupKey, owner: holder.agent.uuid, alive })
    return { holder: holder.agent, key: holder.key, reason: alive === false ? 'holder-gone' : 'forced-unknown' }
}

// Purpose: a members.json update that maps `name` to `uuid` (and drops the uuid's old name), taking the
// name over from a holder that is not alive (force). Shared by rename and group move.
export function claimName(
    root: string,
    groupKey: string,
    name: string,
    uuid: string,
    opts: ClaimOptions = {},
): MembersUpdate {
    return async (m) => {
        const taken = await assertNameFree(root, groupKey, m, name, uuid, opts.force)
        if (taken !== null) {
            // Never creates a folder: the holder may have moved or left (updateAgent returns null).
            await updateAgent(root, groupKey, taken.holder.uuid, { name: null }, { lockHeld: true }).catch((err) =>
                log('warn', 'claimName', 'could not clear the old holder name', { error: String(err) }),
            )
            opts.onTakeover?.(taken)
        }
        const next = withoutUuid(await withoutLeftovers(root, groupKey, m), uuid)
        return withName(next, name, uuid, taken === null ? [] : [taken.key])
    }
}

// Purpose: undo a claim of `name` by `uuid` (F7, G2): drop the claimer's map entry and give a name the
// claim took over back to its holder (map entry under its key, and agent.json name). Caller holds the
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
        return taken === undefined ? next : withName(next, taken.key, taken.holder.uuid)
    })
    if (taken === undefined || taken.holder.name === null) return
    const restored = await updateAgent(
        root,
        groupKey,
        taken.holder.uuid,
        { name: taken.holder.name },
        { lockHeld: true },
    )
    if (restored !== null)
        log('warn', 'restoreHolder', 'taken-over name given back', { groupKey, uuid: taken.holder.uuid, name })
}
