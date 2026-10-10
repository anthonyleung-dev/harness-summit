// Identity records `<root>/.hosts/<hostKey>.json` (SPEC §3). Read from disk on every call; never cached.
//
// Two repairs happen on every read:
// - Stale record (REVIEW m8): a pid-keyed record stores the host process start time. When the pid now
//   names another process (or no process), the record belongs to a dead session: it is deleted and
//   the caller counts as not joined. Only a definite answer deletes it: "unknown" from /proc
//   (src/core/proc.ts: EACCES, EMFILE, no /proc for the reader) never does (F9, DELTA-REVIEW-3 E2).
// - Moved folder (REVIEW M1): when the record's group has no folder for the uuid, but another group
//   has it (a group move that stopped after the folder moved), the record is pointed at that group.
import fs from 'node:fs/promises'

import { agentExists, findAgentGroup } from './agents.js'
import { summitError } from './errors.js'
import { readJsonFile, writeJsonAtomic } from './fsx.js'
import { pidOfHostKey } from './hostKey.js'
import { log } from './log.js'
import { updateMembers, withoutUuid } from './members.js'
import { hostFile } from './paths.js'
import { isSameProcess, processStartTime } from './proc.js'
import { HostRecordSchema, type HostRecord } from './schemas.js'

// Purpose: the start time of the host process behind a pid-keyed host key, else null.
export function hostStartFor(hostKey: string): number | null {
    const pid = pidOfHostKey(hostKey)
    return pid === null ? null : processStartTime(pid)
}

// Purpose: tell whether a record belongs to a host process that no longer exists (pid reused or gone).
// Only a definite answer counts: when /proc cannot tell ('unknown'), the record stays (F9). A record
// without a start time, or with a key that holds no pid, is never stale.
export function isStaleHost(host: HostRecord): boolean {
    const pid = pidOfHostKey(host.hostKey)
    if (pid === null) return false
    return isSameProcess(pid, host.hostStart) === false
}

// Purpose: read the identity of a host key, or null when it has not joined. A stale record is
// deleted and reads as null.
export async function readHost(root: string, hostKey: string): Promise<HostRecord | null> {
    const host = await readJsonFile(hostFile(root, hostKey), HostRecordSchema)
    if (host === null || !isStaleHost(host)) return host
    log('warn', 'readHost', 'stale host record (host process changed); treating as not joined', {
        hostKey,
        uuid: host.uuid,
        recordedStart: host.hostStart,
        currentStart: hostStartFor(hostKey),
    })
    await deleteHost(root, hostKey)
    return null
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
