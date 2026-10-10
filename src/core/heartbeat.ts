// Agent liveness by heartbeat (SPEC §3, §7). No OS process inspection: the same rule runs on Linux,
// macOS and Windows.
//
// Every MCP server, while it runs, sets the mtime of `<group>/<uuid>/.heartbeat` to now for each agent
// it serves: every HEARTBEAT_INTERVAL_MS (an unref'd timer) and on every tool call of that agent. An
// agent is alive while its heartbeat is younger than HEARTBEAT_STALE_MS. Which agents a server serves:
// - claude, pi, omp: the agent of its host key `<harness>-<process.ppid>` (registered at start).
// - codex: the agent of each thread id it has seen in a tool call (registered by that call).
// - opencode: none. One shared server outlives every session, so a beat proves nothing; OpenCode
//   agents read alive "unknown" (src/core/agents.ts isAlive).
// The server finds the agent's folder through its `.hosts` record on every tick, so a beat follows a
// group move. A beat never creates a folder: a folder that moved or was removed is skipped.
import fs from 'node:fs/promises'

import { hasErrno } from './errors.js'
import { readJsonFile } from './fsx.js'
import { log } from './log.js'
import { heartbeatFile, hostFile, mailboxOf } from './paths.js'
import { HostRecordSchema } from './schemas.js'

export const HEARTBEAT_INTERVAL_MS = 5_000
// Three missed beats: an agent whose heartbeat is older than this is gone.
export const HEARTBEAT_STALE_MS = 15_000

// Host keys this process serves; the timer beats each of their agents (registered by serveHostKey).
const served = new Set<string>()

// Purpose: set the heartbeat of the agent folder `folder` to `now`. Creates the `.heartbeat` file when it
// is missing, but never the folder. True when the beat landed, false when the folder is gone.
export async function beat(folder: string, now = new Date()): Promise<boolean> {
    const file = heartbeatFile(folder)
    try {
        await fs.utimes(file, now, now)
        return true
    } catch (err) {
        if (!hasErrno(err, 'ENOENT')) throw err
    }
    try {
        // Mode 'a' creates the file without truncating and fails with ENOENT when the folder is gone.
        await (await fs.open(file, 'a')).close()
        await fs.utimes(file, now, now)
        return true
    } catch (err) {
        if (hasErrno(err, 'ENOENT')) return false
        throw err
    }
}

// Purpose: age in ms of the heartbeat in `folder`, or null when the folder has no heartbeat.
export async function heartbeatAge(folder: string, now = Date.now()): Promise<number | null> {
    try {
        const st = await fs.stat(heartbeatFile(folder))
        return now - st.mtimeMs
    } catch (err) {
        if (hasErrno(err, 'ENOENT') || hasErrno(err, 'ENOTDIR')) return null
        throw err
    }
}

// Purpose: tell whether an agent folder has a heartbeat younger than HEARTBEAT_STALE_MS.
export async function isBeatFresh(folder: string, now = Date.now()): Promise<boolean> {
    const age = await heartbeatAge(folder, now)
    return age !== null && age <= HEARTBEAT_STALE_MS
}

// Purpose: register a host key whose agent this process serves, so the timer beats it.
export function serveHostKey(hostKey: string): void {
    if (served.has(hostKey)) return
    served.add(hostKey)
    log('debug', 'serveHostKey', 'serving host key', { hostKey })
}

// Purpose: beat the agent behind one host key: read its `.hosts` record and beat its folder. False when
// the key has not joined or its folder is not where the record says (a group move in progress: the
// next tick finds it).
export async function beatHostKey(root: string, hostKey: string, now = new Date()): Promise<boolean> {
    const host = await readJsonFile(hostFile(root, hostKey), HostRecordSchema)
    if (host === null) return false
    const landed = await beat(mailboxOf(root, host), now)
    if (!landed) log('debug', 'beatHostKey', 'agent folder not found; beat skipped', { hostKey })
    return landed
}

// Purpose: one timer tick: beat every served host key. Errors are logged per key and never stop the
// other keys or the timer.
export async function beatServed(root: string): Promise<void> {
    for (const hostKey of served) {
        await beatHostKey(root, hostKey).catch((err) =>
            log('warn', 'beatServed', 'heartbeat failed', { hostKey, error: String(err) }),
        )
    }
}

// Purpose: start the heartbeat timer of this server: beat at once, then every `everyMs`. Returns the stop
// function. The timer is unref'd (it never keeps the process alive) and ticks never overlap.
export function startHeartbeat(root: string, everyMs = HEARTBEAT_INTERVAL_MS): () => void {
    let busy = false
    const tick = () => {
        if (busy) return
        busy = true
        void beatServed(root).finally(() => (busy = false))
    }
    tick()
    const timer = setInterval(tick, everyMs)
    timer.unref()
    log('info', 'startHeartbeat', 'heartbeat started', { everyMs, served: [...served] })
    return () => clearInterval(timer)
}
