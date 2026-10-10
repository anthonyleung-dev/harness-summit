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
// A heartbeat is fresh while its mtime is at most STALE_MS old (or in the future). Every decision that
// declares a holder gone (a forced name takeover, a lock break) takes a second look (confirmGone): it
// waits SECOND_LOOK_MS on its own timer and reads the mtime again; any change means alive. So a jump of
// the wall clock or a laptop sleep never makes a live holder look gone.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import { hasErrno } from './errors.js'
import { writeJsonAtomic } from './fsx.js'
import { log } from './log.js'
import { aliveDir, aliveFile } from './paths.js'
import type { Harness } from './schemas.js'

export const BEAT_MS = 2_000
export const STALE_MS = 10_000
// One missed beat plus a margin: long enough that a live beater moves the mtime in between.
export const SECOND_LOOK_MS = BEAT_MS + 500
// A server deletes heartbeat files older than this when it starts (sessions long gone).
export const BEAT_CLEANUP_MS = 24 * 60 * 60 * 1000

// This server process: written into each heartbeat file it creates, for people reading the files.
const SERVER_ID = randomUUID()
const STARTED_AT = new Date().toISOString()
// Codex host keys this process has served; the timer beats each of them (serveHostKey).
const served = new Set<string>()

// Purpose: wait `ms` milliseconds on this process's own timer.
function wait(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

// Purpose: the mtime of `file` in ms, or null when it does not exist.
export async function mtimeOf(file: string): Promise<number | null> {
    try {
        return (await fs.stat(file)).mtimeMs
    } catch (err) {
        if (hasErrno(err, 'ENOENT') || hasErrno(err, 'ENOTDIR')) return null
        throw err
    }
}

// Purpose: tell whether a file last touched at `mtime` counts as fresh at `now` (a future mtime does).
export function isFresh(mtime: number, now = Date.now(), staleMs = STALE_MS): boolean {
    return now - mtime <= staleMs
}

// Purpose: the second look before a "gone" decision: wait `waitMs`, read the mtime of `file` again, and
// report gone only when it did not move (also when the file is still missing). Shared by agent
// liveness and lock breaks (one door).
export async function confirmGone(file: string, seen: number | null, waitMs = SECOND_LOOK_MS): Promise<boolean> {
    await wait(waitMs)
    const again = await mtimeOf(file)
    const gone = again === seen
    log('debug', 'confirmGone', gone ? 'still not touched: gone' : 'touched meanwhile: alive', { file })
    return gone
}

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

// Purpose: delete heartbeat files older than BEAT_CLEANUP_MS (sessions that ended long ago). Best effort.
export async function cleanupBeats(root: string, now = Date.now()): Promise<void> {
    const names = await fs.readdir(aliveDir(root)).catch(() => [] as string[])
    for (const name of names) {
        const file = path.join(aliveDir(root), name)
        const mtime = await mtimeOf(file).catch(() => null)
        if (mtime !== null && now - mtime > BEAT_CLEANUP_MS) await fs.rm(file, { force: true }).catch(() => undefined)
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
