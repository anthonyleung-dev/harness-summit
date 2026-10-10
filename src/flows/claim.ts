// Name claims (SPEC §5): the one door that maps a name to an agent in a group's name map, shared by
// summit_rename and summit_group, and its undo.
//
// Name takeover (REVIEW M5; owner decision 2026-10-10): a live holder (`alive: true`) always keeps its
// name. Any other holder (`alive: false`: no server beat it for STALE_MS, or its heartbeat is gone;
// `"unknown"`: OpenCode) loses it only with `force`, because its session may be resumed later and expect
// its name back. A forced takeover of a holder that looks gone takes the second look first (a beat
// during it means alive: refused). The holder keeps its folder; its map entry goes and its agent.json
// name becomes null, so it can never write a second `<name>.md` next to the new holder. The result says
// why a name was taken over (`takeover.reason`, O1).
//
// Every case match is judged (`nameKeys`): our own exact entry is free; one other holder follows the
// rules above; several (a case pair an older version wrote, `Bob` and `bob`) are taken over together
// only with `force` and only when EVERY one of them is gone (`alive: false` after the second look); any
// holder that is alive or unknown keeps the pair. A map entry whose uuid has no folder in THAT group is
// free, and every claim drops such entries (F6): a group move holds the new group's lock from its claim
// until its folder is in place (src/flows/group.ts), so outside the lock an entry without a folder is
// always a leftover.
import { agentExists, isAlive, readAgent, updateAgent, type Alive } from '../core/agents.js'
import { summitError } from '../core/errors.js'
import { log } from '../core/log.js'
import { applyMembersUpdate, nameKeys, withName, withoutUuid, type MembersUpdate } from '../core/members.js'
import { isReservedName, type AgentRecord, type Members, type Takeover, type TakeoverReason } from '../core/schemas.js'

// A name that a claim took over: the holder's agent.json as it was before the takeover (so a failed
// call can give the name back, restoreHolder), the map key it held, and why the name was free (O1).
export interface TakenOver {
    holder: AgentRecord
    key: string
    reason: TakeoverReason
}

export interface ClaimOptions {
    force?: boolean
    // Called under the members lock with every holder the claim took the name over from.
    onTakeover?: (taken: TakenOver[]) => void
}

// One other agent that holds the name (or a case variant of it) in this group.
interface Holder {
    agent: AgentRecord
    key: string
}

// Purpose: the result form of a takeover (O1): the first holder's uuid and the reason, or null. (A case
// pair taken over together has one reason, holder-gone; every holder is logged and given back on undo.)
export function takeoverOf(taken: TakenOver[] | undefined): Takeover | null {
    const first = taken?.[0]
    return first === undefined ? null : { from: first.holder.uuid, reason: first.reason }
}

// Purpose: every other agent whose folder is in this group and that holds `name` ignoring case, with the
// key it holds. Empty when free: our own exact entry, or only our entries and leftovers (F6).
async function nameHolders(root: string, groupKey: string, m: Members, name: string, uuid: string): Promise<Holder[]> {
    if (m.members[name] === uuid) return []
    const holders: Holder[] = []
    for (const key of nameKeys(m, name)) {
        const owner = m.members[key] as string
        if (owner === uuid) continue
        const agent = await readAgent(root, groupKey, owner)
        if (agent !== null) holders.push({ agent, key })
    }
    return holders
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

// Purpose: the error that keeps a name with its holder(s), with a hint when force would help.
function nameTaken(name: string, groupKey: string, holders: Holder[], alive: Alive[], forceHelps: boolean) {
    const pair = holders.length > 1 ? ` (${holders.length} agents hold it in different letter case)` : ''
    const hint = forceHelps
        ? '; its holder is not alive now but its session may resume; pass force (`--force` with /sr or /sg) to take the name over'
        : ''
    return summitError(
        'SUMMIT_NAME_TAKEN',
        `name ${name} belongs to another agent in ${groupKey}${pair}${hint}`,
        'assertNameFree',
        {
            name,
            groupKey,
            owners: holders.map((h) => h.agent.uuid),
            alive,
        },
    )
}

// Purpose: fail with SUMMIT_NAME_TAKEN while a holder of `name` keeps it; return the holders to take over
// and why each may be taken (empty when the name is free).
export async function assertNameFree(
    root: string,
    groupKey: string,
    m: Members,
    name: string,
    uuid: string,
    force = false,
): Promise<TakenOver[]> {
    const holders = await nameHolders(root, groupKey, m, name, uuid)
    if (holders.length === 0) return []
    // Without force, any holder keeps the name: no second look is needed to refuse.
    const alive: Alive[] = []
    for (const h of holders) alive.push(await isAlive(root, h.agent, { confirm: force }))
    const pair = holders.length > 1
    const keeps = alive.some((a) => a === true || (pair && a === 'unknown'))
    if (keeps || !force) throw nameTaken(name, groupKey, holders, alive, !keeps)
    log('warn', 'assertNameFree', 'taking over a name', {
        name,
        groupKey,
        owners: holders.map((h) => h.agent.uuid),
        alive,
    })
    return holders.map((h, i) => ({
        holder: h.agent,
        key: h.key,
        reason: alive[i] === false ? 'holder-gone' : 'forced-unknown',
    }))
}

// Purpose: a members.json update that maps `name` to `uuid` (and drops the uuid's old name), taking the
// name over from holders that are gone (force). Shared by rename and group move.
export function claimName(
    root: string,
    groupKey: string,
    name: string,
    uuid: string,
    opts: ClaimOptions = {},
): MembersUpdate {
    return async (m) => {
        // A claim chooses a name anew: a Windows device name is refused here too (an agent named so by an
        // older version renames away first).
        if (isReservedName(name)) {
            throw summitError('SUMMIT_BAD_NAME', `name ${name} is a Windows device name; rename first`, 'claimName', {
                name,
                groupKey,
            })
        }
        const taken = await assertNameFree(root, groupKey, m, name, uuid, opts.force)
        for (const t of taken) {
            // Never creates a folder: the holder may have moved or left (updateAgent returns null).
            await updateAgent(root, groupKey, t.holder.uuid, { name: null }, { lockHeld: true }).catch((err) =>
                log('warn', 'claimName', 'could not clear the old holder name', { error: String(err) }),
            )
        }
        if (taken.length > 0) opts.onTakeover?.(taken)
        const next = withoutUuid(await withoutLeftovers(root, groupKey, m), uuid)
        return withName(
            next,
            name,
            uuid,
            taken.map((t) => t.key),
        )
    }
}

// Purpose: undo a claim of `name` by `uuid` (F7, G2): drop the claimer's map entry and give the name
// back to every holder the claim took it from (map entry under its own key, and agent.json name). Caller
// holds the group's lock. Shared by rename (its folder left the group) and the group move (a later step
// failed).
export async function restoreHolder(
    root: string,
    groupKey: string,
    name: string,
    uuid: string,
    taken: TakenOver[] | undefined,
): Promise<void> {
    const all = taken ?? []
    await applyMembersUpdate(root, groupKey, (m) =>
        all.reduce((next, t) => withName(next, t.key, t.holder.uuid), withoutUuid(m, uuid)),
    )
    for (const { holder } of all) {
        if (holder.name === null) continue
        const restored = await updateAgent(root, groupKey, holder.uuid, { name: holder.name }, { lockHeld: true })
        if (restored !== null)
            log('warn', 'restoreHolder', 'taken-over name given back', { groupKey, uuid: holder.uuid, name })
    }
}
