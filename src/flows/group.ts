// summit_group (SPEC §2, §4): MOVE the agent to a named group: folder, map entry and host record.
//
// Order (REVIEW M1): claim the name in the new map → move the folder → write the host record
// (atomic) → release the old name last. A failure undoes the earlier steps (Pipe undo). A crash
// between the move and the host write is repaired by the next call of this host: the identity
// loader finds the folder in its new group (src/core/identity.ts locateHost).
//
// The claim and the folder move run under ONE hold of the new group's members lock (F6), so no other
// claimer ever sees the claim without the folder: outside the lock, a map entry without a folder in
// its group is a leftover, and every claim treats it as free. The same hold also covers the OLD
// group's lock (both in key order, lockGroups), and the name is read again under it: a summit_rename
// (which writes agent.json under the old group's lock) then either ends before the read, so the move
// claims the new name, or runs after the move and finds its folder gone (SUMMIT_TARGET_GONE). So
// agent.json and the new map never disagree on the name. The undo of the claim gives a name that was
// taken over back to its holder (F7, restoreHolder).
import fs from 'node:fs/promises'

import { requireAgent } from '../core/agents.js'
import { summitError } from '../core/errors.js'
import { pathExists, renameRetry } from '../core/fsx.js'
import { writeHost } from '../core/identity.js'
import { withLock } from '../core/lock.js'
import { log } from '../core/log.js'
import { applyMembersUpdate, lockGroups, updateMembers, withoutUuid } from '../core/members.js'
import { agentDir, cursorLock, groupDir } from '../core/paths.js'
import { pipe, rollBack, step } from '../core/pipe.js'
import { namedGroupKey } from '../core/project.js'
import type { AgentRecord, Takeover } from '../core/schemas.js'
import { hostKeyStep, need, requireHostStep, type CallContext, type WithHost } from './context.js'
import { claimName, restoreHolder, takeoverOf, type TakenOver } from './rename.js'

export interface GroupResult {
    uuid: string
    groupKey: string
    previousGroupKey: string
    name: string | null
    folder: string
    moved: boolean
    takeover: Takeover | null
}

interface GroupCtx extends WithHost {
    name: string
    force: boolean
    newKey?: string
    previousKey?: string
    agent?: AgentRecord
    // The name the claim took over: the holder's agent.json before the takeover, and the reason.
    takenOver?: TakenOver
}

// Step: validate the group name.
const validate = step<GroupCtx>('validateGroup', (ctx) => ({ ...ctx, newKey: namedGroupKey(ctx.name.trim()) }))

// Step: load the caller's agent.json from its current group.
const loadAgent = step<GroupCtx>('loadAgent', async (ctx) => {
    const host = need(ctx.host, 'host')
    return { ...ctx, previousKey: host.groupKey, agent: await requireAgent(ctx.call.root, host.groupKey, host.uuid) }
})

// Step: read agent.json again under both groups' locks (claimAndMove), so the name the move claims is
// the name agent.json holds when the folder moves (a summit_rename may have ended since loadAgent).
const reloadAgent = step<GroupCtx>('reloadAgent', async (ctx) => {
    const before = need(ctx.agent, 'agent')
    const agent = await requireAgent(ctx.call.root, need(ctx.previousKey, 'previousKey'), before.uuid)
    if (agent.name !== before.name)
        log('info', 'group.reloadAgent', 'name changed before the move', { uuid: agent.uuid, from: before.name })
    return { ...ctx, agent }
})

// Step: claim the agent's name in the new group (fails with SUMMIT_NAME_TAKEN before anything moves).
// Runs under both groups' locks (claimAndMove). Undo: drop the claim, and give a taken-over name
// back to its holder.
const claimNewName = step<GroupCtx>(
    'claimNewName',
    async (ctx) => {
        const agent = need(ctx.agent, 'agent')
        if (agent.name === null) return ctx
        const newKey = need(ctx.newKey, 'newKey')
        let takenOver: TakenOver | undefined
        const claim = claimName(ctx.call.root, newKey, agent.name, agent.uuid, {
            force: ctx.force,
            onTakeover: (taken) => (takenOver = taken),
        })
        await applyMembersUpdate(ctx.call.root, newKey, claim)
        return takenOver === undefined ? ctx : { ...ctx, takenOver }
    },
    async (ctx) => {
        const agent = need(ctx.agent, 'agent')
        if (agent.name === null) return
        await restoreHolder(ctx.call.root, need(ctx.newKey, 'newKey'), agent.name, agent.uuid, ctx.takenOver)
    },
)

// Purpose: rename an agent folder while holding its read lock (`.cursor.lock`), so no summit_read and
// no sender's wake decision holds that lock while the folder moves (a lock held across the rename
// would be left behind in the moved folder, held by a live process that no longer releases it). The
// lock file moves with the folder and is released at its new path (withLock `releaseAt`, N4); a break
// lock or tomb of a breaker at the old path that moved with it is removed there (E5). Windows refuses to
// rename a folder while another program holds a file in it open; renameRetry retries that for about 1 s.
async function renameHoldingReadLock(from: string, to: string): Promise<void> {
    await withLock(cursorLock(from), async () => await renameRetry(from, to), {
        mkdir: false,
        releaseAt: () => cursorLock(to),
    })
}

// Step: move the folder (one rename). Refuses when the new group already has a folder for this uuid.
// Undo: move it back.
const moveFolder = step<GroupCtx>(
    'moveFolder',
    async (ctx) => {
        const uuid = need(ctx.agent, 'agent').uuid
        const from = agentDir(ctx.call.root, need(ctx.previousKey, 'previousKey'), uuid)
        const newKey = need(ctx.newKey, 'newKey')
        const to = agentDir(ctx.call.root, newKey, uuid)
        if (await pathExists(to)) {
            throw summitError('SUMMIT_IO', `cannot move ${from}: ${to} already exists`, 'moveFolder', { from, newKey })
        }
        try {
            await fs.mkdir(groupDir(ctx.call.root, newKey), { recursive: true })
            await renameHoldingReadLock(from, to)
        } catch (err) {
            throw summitError('SUMMIT_IO', `cannot move ${from}`, 'moveFolder', { from, newKey }, err)
        }
        log('info', 'group.moveFolder', 'folder moved', { uuid, from: ctx.previousKey, to: newKey })
        return ctx
    },
    async (ctx) => {
        const uuid = need(ctx.agent, 'agent').uuid
        await renameHoldingReadLock(
            agentDir(ctx.call.root, need(ctx.newKey, 'newKey'), uuid),
            agentDir(ctx.call.root, need(ctx.previousKey, 'previousKey'), uuid),
        )
    },
)

const LOCKED_STEPS = [reloadAgent, claimNewName, moveFolder]

// Purpose: the members locks a move holds: the old and the new group's.
function moveLocks(ctx: GroupCtx): string[] {
    return [need(ctx.previousKey, 'previousKey'), need(ctx.newKey, 'newKey')]
}

// Step: read the name, claim it and move the folder under one hold of both groups' locks (F6). Undo (a
// later step failed): under the locks again, move the folder back and drop the claim (newest first).
const claimAndMove = step<GroupCtx>(
    'claimAndMove',
    async (ctx) => await lockGroups(ctx.call.root, moveLocks(ctx), () => pipe('group.locked', ctx, LOCKED_STEPS)),
    async (ctx) =>
        await lockGroups(ctx.call.root, moveLocks(ctx), () =>
            rollBack(
                'group.locked',
                LOCKED_STEPS.map((s) => ({ s, ctx })),
            ),
        ),
)

// Step: point the host record at the new group (atomic write).
const updateHost = step<GroupCtx>('updateHost', async (ctx) => {
    await writeHost(ctx.call.root, { ...need(ctx.host, 'host'), groupKey: need(ctx.newKey, 'newKey') })
    return ctx
})

// Step: release the old name last. Best effort: the move is complete, and a leftover entry points at
// a uuid with no folder in that group, which every claim treats as free and drops (F6).
const leaveOldMap = step<GroupCtx>('leaveOldMap', async (ctx) => {
    const previousKey = need(ctx.previousKey, 'previousKey')
    await updateMembers(ctx.call.root, previousKey, (m) => withoutUuid(m, need(ctx.agent, 'agent').uuid)).catch((err) =>
        log('warn', 'group.leaveOldMap', 'old map entry left behind', { previousKey, error: String(err) }),
    )
    return ctx
})

// Purpose: run the group move flow. Moving to the current group is a no-op. `force` takes the name
// over from a holder whose liveness is unknown, like summit_rename (F8).
export async function group(call: CallContext, name: string, force = false): Promise<GroupResult> {
    const head = await pipe<GroupCtx>('group', { call, name, force }, [
        hostKeyStep(),
        requireHostStep(),
        validate,
        loadAgent,
    ])
    const moved = head.newKey !== head.previousKey
    const ctx = moved ? await pipe<GroupCtx>('group', head, [claimAndMove, updateHost, leaveOldMap]) : head
    const agent = need(ctx.agent, 'agent')
    const newKey = need(ctx.newKey, 'newKey')
    log('info', 'group', moved ? 'moved' : 'already in group', { uuid: agent.uuid, from: ctx.previousKey, to: newKey })
    return {
        uuid: agent.uuid,
        groupKey: newKey,
        previousGroupKey: need(ctx.previousKey, 'previousKey'),
        name: agent.name,
        folder: agentDir(call.root, newKey, agent.uuid),
        moved,
        takeover: takeoverOf(ctx.takenOver),
    }
}
