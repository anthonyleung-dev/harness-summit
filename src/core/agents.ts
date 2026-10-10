// Agent folders and `agent.json` (SPEC §4), plus liveness (SPEC §7).
import fs from 'node:fs/promises'

import { hasErrno, summitError } from './errors.js'
import { confirmGone, isStaleMtime } from './freshness.js'
import { pathExists, readJsonFile, writeJsonAtomic } from './fsx.js'
import { beatTime } from './heartbeat.js'
import { log } from './log.js'
import { lockGroup } from './members.js'
import { agentDir, agentFile, aliveFile, DIR_MODE, groupDir } from './paths.js'
import { AgentRecordSchema, UUID_PATTERN, type AgentRecord } from './schemas.js'

export type Alive = boolean | 'unknown'

// Purpose: label used in records and notices: the display name, else the uuid.
export function agentLabel(agent: Pick<AgentRecord, 'name' | 'uuid'>): string {
    return agent.name ?? agent.uuid
}

// Purpose: read one agent.json, or null when the folder is gone.
export async function readAgent(root: string, groupKey: string, uuid: string): Promise<AgentRecord | null> {
    return await readJsonFile(agentFile(root, groupKey, uuid), AgentRecordSchema)
}

// Purpose: read one agent.json or fail with SUMMIT_TARGET_GONE.
export async function requireAgent(root: string, groupKey: string, uuid: string): Promise<AgentRecord> {
    const agent = await readAgent(root, groupKey, uuid)
    if (agent === null) {
        log('warn', 'requireAgent', 'agent folder missing', { groupKey, uuid })
        throw summitError('SUMMIT_TARGET_GONE', `agent ${uuid} has no folder in group ${groupKey}`, 'requireAgent', {
            groupKey,
            uuid,
        })
    }
    return agent
}

// Purpose: write agent.json. With `create: false` the folder must already exist (used when writing
// another agent's record, which must never resurrect a folder that moved or was removed).
export async function writeAgent(
    root: string,
    groupKey: string,
    agent: AgentRecord,
    opts: { create?: boolean } = {},
): Promise<void> {
    if (opts.create !== false) await fs.mkdir(agentDir(root, groupKey, agent.uuid), { recursive: true, mode: DIR_MODE })
    await writeJsonAtomic(agentFile(root, groupKey, agent.uuid), AgentRecordSchema.parse(agent), {
        mkdir: opts.create !== false,
    })
    log('info', 'writeAgent', 'agent.json written', { groupKey, uuid: agent.uuid, name: agent.name })
}

// Purpose: tell whether an agent folder exists.
export async function agentExists(root: string, groupKey: string, uuid: string): Promise<boolean> {
    return await pathExists(agentDir(root, groupKey, uuid), 'dir')
}

// Purpose: every group key under the root (dot-dirs such as .hosts, .wake and .logs are not groups).
async function groupKeys(root: string): Promise<string[]> {
    try {
        const entries = await fs.readdir(root, { withFileTypes: true })
        return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name)
    } catch (err) {
        if (hasErrno(err, 'ENOENT')) return []
        throw summitError('SUMMIT_IO', `cannot list ${root}`, 'groupKeys', { root }, err)
    }
}

// Purpose: find the group whose folder holds `uuid`, trying `preferred` first; null when no group
// holds it. Used to repair a host record after a group move that stopped half way (REVIEW M1).
export async function findAgentGroup(root: string, uuid: string, preferred?: string): Promise<string | null> {
    if (preferred !== undefined && (await agentExists(root, preferred, uuid))) return preferred
    const found: string[] = []
    for (const g of await groupKeys(root)) if (g !== preferred && (await agentExists(root, g, uuid))) found.push(g)
    if (found.length > 1) log('warn', 'findAgentGroup', 'uuid has folders in several groups', { uuid, found })
    log('debug', 'findAgentGroup', 'searched groups', { uuid, preferred, found })
    return found.sort()[0] ?? null
}

// Purpose: list every agent folder of a group with its agent.json. Folders without a valid
// agent.json are skipped and logged.
export async function listAgents(root: string, groupKey: string): Promise<AgentRecord[]> {
    let entries: string[]
    try {
        entries = await fs.readdir(groupDir(root, groupKey))
    } catch (err) {
        if (hasErrno(err, 'ENOENT')) return []
        throw summitError('SUMMIT_IO', `cannot list group ${groupKey}`, 'listAgents', { groupKey }, err)
    }
    const agents: AgentRecord[] = []
    for (const entry of entries.filter((e) => UUID_PATTERN.test(e)).sort()) {
        try {
            const agent = await readAgent(root, groupKey, entry)
            if (agent !== null) agents.push(agent)
        } catch (err) {
            log('warn', 'listAgents', 'skipping unreadable agent', { groupKey, uuid: entry, error: String(err) })
        }
    }
    return agents
}

// Purpose: liveness of an agent (SPEC §7), from the heartbeat of its host key: "unknown" for OpenCode
// (one shared server outlives every session); true while the heartbeat is fresh (src/core/freshness.ts);
// false when it is stale or missing (every agent is beaten at join, so a missing file was cleaned up
// after its session ended, or the agent joined before heartbeats existed). With `confirm` (a decision
// that declares the agent gone), a stale heartbeat gets the second look first, and any beat during it
// means alive.
export async function isAlive(
    root: string,
    agent: Pick<AgentRecord, 'harness' | 'hostKey'>,
    opts: { confirm?: boolean } = {},
): Promise<Alive> {
    if (agent.harness === 'opencode') return 'unknown'
    const seen = await beatTime(root, agent.hostKey)
    if (seen !== null && !isStaleMtime(seen)) return true
    if (opts.confirm === true && !(await confirmGone(aliveFile(root, agent.hostKey), seen))) return true
    return false
}

// A change to one agent.json: the fields to set, or a function of the current record that returns
// them (null: no change).
export type AgentPatch = Partial<AgentRecord> | ((current: AgentRecord) => Partial<AgentRecord> | null)

// Purpose: the one read-modify-write of an agent.json (N3): read the record under the group's members
// lock (the lock every writer of another agent's agent.json holds), apply `patch` and write it back,
// so no writer loses another's field. `lockHeld: true` when the caller already holds that lock (a
// name claim inside a members update). Never creates the folder: returns null when the record is
// gone, else the record as written (or as found, when the patch changes nothing).
export async function updateAgent(
    root: string,
    groupKey: string,
    uuid: string,
    patch: AgentPatch,
    opts: { lockHeld?: boolean } = {},
): Promise<AgentRecord | null> {
    const apply = async () => {
        const current = await readAgent(root, groupKey, uuid)
        if (current === null) {
            log('warn', 'updateAgent', 'agent.json gone; nothing updated', { groupKey, uuid })
            return null
        }
        const fields = typeof patch === 'function' ? patch(current) : patch
        if (fields === null) return current
        const next = { ...current, ...fields, uuid }
        await writeAgent(root, groupKey, next, { create: false })
        log('debug', 'updateAgent', 'agent.json updated', { groupKey, uuid, fields: Object.keys(fields) })
        return next
    }
    return opts.lockHeld === true ? await apply() : await lockGroup(root, groupKey, apply, { mkdir: false })
}
