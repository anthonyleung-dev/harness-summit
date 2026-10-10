// Identity records `<root>/.hosts/<hostKey>.json` (SPEC §3). Read from disk on every call; never cached.
//
// Two repairs:
// - Stale record (REVIEW m8): a pid-keyed record (claude, pi, omp) whose host process is gone must not
//   pass to a new process that got the same pid. A new MCP server checks the record of its own host key
//   once, when it starts and before it answers anything (dropStaleHost): when no server has beaten the
//   agent for HEARTBEAT_STALE_MS, the record belongs to a dead session and is deleted. From then on the
//   server's own beats keep the record fresh, so the check is not repeated on read (an age check on read
//   would also drop a live record after a suspend, before the first beat). Known limit: a pid reused
//   within HEARTBEAT_STALE_MS of the old server's last beat inherits the record.
// - Moved folder (REVIEW M1): when the record's group has no folder for the uuid, but another group
//   has it (a group move that stopped after the folder moved), the record is pointed at that group.
import fs from 'node:fs/promises'

import { agentExists, findAgentGroup } from './agents.js'
import { summitError } from './errors.js'
import { readJsonFile, writeJsonAtomic } from './fsx.js'
import { heartbeatAge, HEARTBEAT_STALE_MS } from './heartbeat.js'
import { pidOfHostKey } from './hostKey.js'
import { log } from './log.js'
import { updateMembers, withoutUuid } from './members.js'
import { agentDir, hostFile } from './paths.js'
import { HostRecordSchema, type HostRecord } from './schemas.js'

// Purpose: read the identity of a host key, or null when it has not joined.
export async function readHost(root: string, hostKey: string): Promise<HostRecord | null> {
    return await readJsonFile(hostFile(root, hostKey), HostRecordSchema)
}

// Purpose: at server start, delete the record of a pid-keyed host key when its agent has no heartbeat
// younger than HEARTBEAT_STALE_MS (missing counts as old): the server that served it is gone, and this
// process only has the same pid. Codex and OpenCode keys are never touched (they hold no pid). A record
// whose folder is in no group is left to loadHost (it reads as not joined). True when deleted.
export async function dropStaleHost(root: string, hostKey: string, now = Date.now()): Promise<boolean> {
    if (pidOfHostKey(hostKey) === null) return false
    const host = await readHost(root, hostKey)
    if (host === null) return false
    const groupKey = await findAgentGroup(root, host.uuid, host.groupKey)
    if (groupKey === null) return false
    const age = await heartbeatAge(agentDir(root, groupKey, host.uuid), now)
    if (age !== null && age <= HEARTBEAT_STALE_MS) {
        log('info', 'dropStaleHost', 'host record is fresh; kept', { hostKey, uuid: host.uuid, age })
        return false
    }
    log('warn', 'dropStaleHost', 'stale host record (no heartbeat); treating as not joined', {
        hostKey,
        uuid: host.uuid,
        age,
    })
    await deleteHost(root, hostKey)
    return true
}

// Purpose: point the record at the group that really holds the agent folder. Returns the record
// (repaired or not), or null when no group holds the folder.
export async function locateHost(root: string, host: HostRecord): Promise<HostRecord | null> {
    if (await agentExists(root, host.groupKey, host.uuid)) return host
    const found = await findAgentGroup(root, host.uuid)
    if (found === null) {
        log('warn', 'locateHost', 'agent folder missing in every group', { hostKey: host.hostKey, uuid: host.uuid })
        return null
    }
    const repaired = { ...host, groupKey: found }
    await writeHost(root, repaired)
    // The old group's map may still name this uuid; drop it (best effort, the uuid has no folder there).
    await updateMembers(root, host.groupKey, (m) => withoutUuid(m, host.uuid)).catch((err) =>
        log('warn', 'locateHost', 'could not clean the old map', { groupKey: host.groupKey, error: String(err) }),
    )
    log('warn', 'locateHost', 'repaired host record after an unfinished group move', {
        hostKey: host.hostKey,
        uuid: host.uuid,
        from: host.groupKey,
        to: found,
    })
    return repaired
}

// Purpose: the caller's identity with its folder located, or null when not joined or the folder is
// gone everywhere.
export async function loadHost(root: string, hostKey: string): Promise<HostRecord | null> {
    const host = await readHost(root, hostKey)
    return host === null ? null : await locateHost(root, host)
}

// Purpose: read the identity or fail with SUMMIT_NOT_JOINED (also when the agent folder is gone).
export async function requireHost(root: string, hostKey: string): Promise<HostRecord> {
    const host = await loadHost(root, hostKey)
    if (host === null) {
        throw summitError('SUMMIT_NOT_JOINED', 'this session has not joined; call summit_join first', 'requireHost', {
            hostKey,
        })
    }
    return host
}

// Purpose: write the identity of a host key (atomic: temp file + rename).
export async function writeHost(root: string, host: HostRecord): Promise<void> {
    await writeJsonAtomic(hostFile(root, host.hostKey), HostRecordSchema.parse(host))
    log('info', 'writeHost', 'identity written', { hostKey: host.hostKey, uuid: host.uuid, groupKey: host.groupKey })
}

// Purpose: delete the identity of a host key (summit_bye, stale record).
export async function deleteHost(root: string, hostKey: string): Promise<void> {
    await fs.rm(hostFile(root, hostKey), { force: true })
    log('info', 'deleteHost', 'identity removed', { hostKey })
}
