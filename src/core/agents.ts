// Agent folders and `agent.json` (SPEC §4), plus liveness (SPEC §7).
import fs from 'node:fs/promises'

import { hasErrno, summitError } from './errors.js'
import { pathExists, readJsonFile, writeJsonAtomic } from './fsx.js'
import { log } from './log.js'
import { lockGroup } from './members.js'
import { agentDir, agentFile, groupDir } from './paths.js'
import { isProcessAlive, readProcessStart } from './proc.js'
import { AgentRecordSchema, UUID_PATTERN, type AgentRecord } from './schemas.js'

export type Alive = boolean | 'unknown'

// Purpose: label used in file names and notices: the display name, else the uuid.
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
    if (opts.create !== false) await fs.mkdir(agentDir(root, groupKey, agent.uuid), { recursive: true })
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

// Purpose: liveness of an agent from agent.json (SPEC §7): null pid → "unknown"; a pid that is gone, or
// that now belongs to another process (pid reuse), → false; any other probe error → "unknown" (F9). A
// Codex agent whose recorded server pid is gone reads "unknown", not false (D5): Codex is keyed by its
// thread, and a `codex resume` serves the same thread from a new server that refreshes the pid only on
// its first tool call. Only a definite false lets another agent take a name over without `force`.
export function isAlive(agent: Pick<AgentRecord, 'harness' | 'pid' | 'pidStart'>): Alive {
    if (agent.pid === null) return 'unknown'
    const alive = isProcessAlive(agent.pid, agent.pidStart)
    if (alive === false && agent.harness === 'codex') {
        log('debug', 'isAlive', 'codex server pid gone; the thread may be resumed', { pid: agent.pid })
        return 'unknown'
    }
    return alive
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

// Purpose: keep agent.json's liveness pid current (F1). A Codex agent is keyed by its thread, so a
// resumed thread or a restarted MCP server serves the same agent from a new pid; every tool call
// records the pid that serves it now (updateAgent, under the group lock). Writes only when the pid or
// its start time changed, and only with a definite start time (an unreadable /proc never overwrites a
// good one). Never creates the folder.
export async function refreshAgentPid(root: string, groupKey: string, uuid: string, pid: number | null): Promise<void> {
    const start = pid === null ? null : readProcessStart(pid)
    if (typeof start === 'string') {
        // 'unknown' or 'gone': no definite start time to record, so leave the file as it is (F9).
        log('warn', 'refreshAgentPid', 'start time not readable; refresh skipped', { groupKey, uuid, pid, start })
        return
    }
    const pidStart = start
    const current = (a: AgentRecord | null) => a === null || (a.pid === pid && (a.pidStart ?? null) === pidStart)
    // Cheap check first: almost every call finds the pid unchanged and takes no lock.
    if (current(await readAgent(root, groupKey, uuid))) return
    await updateAgent(root, groupKey, uuid, (agent) => {
        if (current(agent)) return null
        log('info', 'refreshAgentPid', 'liveness pid refreshed', { groupKey, uuid, from: agent.pid, to: pid })
        return { pid, pidStart }
    })
}
