// Heartbeats (SPEC §7, XPLAT-AUDIT §H). No OS process inspection: the same rule runs on Linux, macOS
// and Windows.
//
// Every MCP server, while it runs, sets the mtime of `<root>/.alive/<hostKey>.json` to now (`utimes`,
// this machine's clock) every BEAT_MS for each host key it serves, and on every tool call:
// - claude, omp: the session its host runs now (read from the session file on every tick, so after
//   `/clear` or `/new` the new session beats and the old one goes stale);
// - pi: the session in its env (pi restarts the server for every session);
// - codex: every thread id a tool call on this server has used;
// - opencode: none. One shared server outlives every session, so a beat would prove nothing.
// The files live outside the agent folders: a group move renames an agent folder, and Windows refuses
// that while a file inside it is open. A beat never takes a lock and never writes agent.json.
//
// Freshness, the second look and the timing constants live in src/core/freshness.ts (shared with lock
// leases).
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { hasErrno } from './errors.js'
import { BEAT_MS, CLEANUP_AGE_MS, mtimeOf } from './freshness.js'
import { writeJsonAtomic } from './fsx.js'
import { log } from './log.js'
import { aliveDir, aliveFile } from './paths.js'
import type { Harness } from './schemas.js'

// This server process: written into each heartbeat file it creates, for people reading the files.
const SERVER_ID = randomUUID()
const STARTED_AT = new Date().toISOString()
// Codex host keys this process has served; the timer beats each of them (serveHostKey).
const served = new Set<string>()

// Purpose: beat one host key now. Creates the heartbeat file (and its folder) when it is missing.
export async function beat(root: string, hostKey: string, harness: Harness, now = new Date()): Promise<void> {
    const file = aliveFile(root, hostKey)
    try {
        await fs.utimes(file, now, now)
        return
    } catch (err) {
        if (!hasErrno(err, 'ENOENT')) throw err
    }
    await writeJsonAtomic(file, { serverId: SERVER_ID, harness, startedAt: STARTED_AT })
    await fs.utimes(file, now, now)
}

// Purpose: the mtime of the heartbeat of one host key, or null when nothing ever beat it.
export async function beatTime(root: string, hostKey: string): Promise<number | null> {
    return await mtimeOf(aliveFile(root, hostKey))
}

// Purpose: register a Codex host key this server serves, so its timer keeps beating it.
export function serveHostKey(hostKey: string): void {
    if (served.has(hostKey)) return
    served.add(hostKey)
    log('debug', 'serveHostKey', 'serving host key', { hostKey })
}

// Purpose: one timer tick: beat the current keys of the host (`current`) and every registered Codex key.
// Errors are logged per key and never stop the other keys or the timer.
export async function beatServed(root: string, harness: Harness, current: () => Promise<string[]>): Promise<void> {
    const keys = new Set([...(await current().catch(() => [] as string[])), ...served])
    for (const hostKey of keys) {
        await beat(root, hostKey, harness).catch((err) =>
            log('warn', 'beatServed', 'heartbeat failed', { hostKey, error: String(err) }),
        )
    }
}

// Purpose: delete heartbeat files older than CLEANUP_AGE_MS (sessions that ended long ago). Best effort.
export async function cleanupBeats(root: string, now = Date.now()): Promise<void> {
    const names = await fs.readdir(aliveDir(root)).catch(() => [] as string[])
    for (const name of names) {
        const file = path.join(aliveDir(root), name)
        const mtime = await mtimeOf(file).catch(() => null)
        if (mtime !== null && now - mtime > CLEANUP_AGE_MS) await fs.rm(file, { force: true }).catch(() => undefined)
    }
}

// Purpose: start this server's heartbeat timer: beat at once, then every `everyMs`. `current` gives the
// host keys of the host's current session (empty for codex and opencode). Returns the stop function.
// The timer is unref'd (it never keeps the process alive) and ticks never overlap.
export function startHeartbeat(
    root: string,
    harness: Harness,
    current: () => Promise<string[]>,
    everyMs = BEAT_MS,
): () => void {
    let busy = false
    const tick = () => {
        if (busy) return
        busy = true
        void beatServed(root, harness, current).finally(() => (busy = false))
    }
    tick()
    const timer = setInterval(tick, everyMs)
    timer.unref()
    log('info', 'startHeartbeat', 'heartbeat started', { harness, everyMs })
    return () => clearInterval(timer)
}
