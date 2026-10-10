// Every on-disk path of the summit root comes from this module (SPEC §4). No other module joins
// root-relative paths by hand. These are pure path joins with no side effect, and the logger itself
// uses them (logsDir), so they do not log: a log call here would recurse.
import os from 'node:os'
import path from 'node:path'

// Purpose: resolve the summit root: $HARNESS_SUMMIT_HOME, else ~/.harness-summit.
export function summitRoot(env: NodeJS.ProcessEnv = process.env): string {
    const fromEnv = env.HARNESS_SUMMIT_HOME
    if (fromEnv !== undefined && fromEnv.trim() !== '') return path.resolve(fromEnv)
    return path.join(os.homedir(), '.harness-summit')
}

// Purpose: directory of the identity records.
export function hostsDir(root: string): string {
    return path.join(root, '.hosts')
}

// Purpose: identity file of one host key.
export function hostFile(root: string, hostKey: string): string {
    return path.join(hostsDir(root), `${hostKey}.json`)
}

// Purpose: directory of the wake signal files.
export function wakeDir(root: string): string {
    return path.join(root, '.wake')
}

// Purpose: the wake signal file of a signal-type host (claude/pi/omp). The host key already is
// `<harness>-<pid>`, so the file is `<root>/.wake/<harness>-<pid>.signal`.
export function signalPathFor(root: string, hostKey: string): string {
    return path.join(wakeDir(root), `${hostKey}.signal`)
}

// Purpose: directory of the daily log files.
export function logsDir(root: string): string {
    return path.join(root, '.logs')
}

// Purpose: directory of one group.
export function groupDir(root: string, groupKey: string): string {
    return path.join(root, groupKey)
}

// Purpose: the name map of one group.
export function membersFile(root: string, groupKey: string): string {
    return path.join(groupDir(root, groupKey), 'members.json')
}

// Purpose: the lock file that guards members.json.
export function membersLock(root: string, groupKey: string): string {
    return path.join(groupDir(root, groupKey), 'members.lock')
}

// Purpose: the folder (inbox) of one agent in one group.
export function agentDir(root: string, groupKey: string, uuid: string): string {
    return path.join(groupDir(root, groupKey), uuid)
}

// Purpose: agent.json of one agent.
export function agentFile(root: string, groupKey: string, uuid: string): string {
    return path.join(agentDir(root, groupKey, uuid), 'agent.json')
}

// Purpose: the read cursor of an agent folder (only the owner writes it).
export function cursorFile(folder: string): string {
    return path.join(folder, '.cursor.json')
}

// Purpose: the lock file that serialises summit_read calls of one agent (REVIEW m13).
export function cursorLock(folder: string): string {
    return path.join(folder, '.cursor.lock')
}

// Purpose: the liveness heartbeat of an agent folder (its mtime is the last beat of the serving MCP
// server, SPEC §7).
export function heartbeatFile(folder: string): string {
    return path.join(folder, '.heartbeat')
}

// Purpose: epoch ms of the last wake of an agent (written by the waking sender).
export function lastWakeFile(folder: string): string {
    return path.join(folder, '.lastwake')
}

// Purpose: the inbox file in `folder` that holds messages from one sender.
export function inboxFile(folder: string, senderLabel: string): string {
    return path.join(folder, `${senderLabel}.md`)
}

// Purpose: the agent folder (inbox) of a joined host.
export function mailboxOf(root: string, host: { groupKey: string; uuid: string }): string {
    return agentDir(root, host.groupKey, host.uuid)
}
