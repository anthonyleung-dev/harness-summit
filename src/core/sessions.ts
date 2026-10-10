// Session files (SPEC §3): which harness session a host process runs now. Claude Code and OMP keep one
// MCP server per host process across `/clear` and `/new`, and they give the server no session id. So the
// host side writes `<root>/.sessions/<harness>-<hostPid>.json` = `{ sessionId, at }` every time the
// session changes (the Claude SessionStart hook on startup, resume, clear and compact; the OMP extension
// on session_start and session_switch), and the server reads it through its own parent pid on every
// call. The pid only finds the file; it never is the identity.
//
// Trust (team review R1): a host process with a reused pid whose hook did not run (yet, or at all) would
// find the file of the dead process that had the pid before. A server therefore accepts a session file
// only when it was written after the server started, minus SESSION_CLOCK_TOLERANCE_MS (the host writes it
// at its startup, and the host starts its server at about the same time). An older file is ignored: the
// call fails with SUMMIT_NO_HOST_KEY ("hooks did not run") and the server's timer never beats its key.
// Known cost: a server reconnected by hand long after the host's last SessionStart (Claude `/mcp`) waits
// for the next one (`/resume`, `/clear` or a restart).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { summitError } from './errors.js'
import { CLEANUP_AGE_MS, isStaleMtime } from './freshness.js'
import { jsonText, readJsonFile, writeJsonAtomic } from './fsx.js'
import { beatTime } from './heartbeat.js'
import { ID_PATTERN, joinHostKey, SESSION_FILE_HARNESSES } from './hostKey.js'
import { log } from './log.js'
import { DIR_MODE, FILE_MODE, sessionFile, sessionsDir } from './paths.js'

// How much earlier than its server's start a session file may be written and still be trusted.
export const SESSION_CLOCK_TOLERANCE_MS = 30_000
// Session files whose rejection was logged already (one warn per file and `at`).
const rejectedLogged = new Set<string>()

// One session file.
export const SessionFileSchema = z.object({
    sessionId: z.string().regex(ID_PATTERN, 'unusable session id'),
    at: z.string(),
})
export type SessionFile = z.infer<typeof SessionFileSchema>

// Purpose: the validated content of one session file (shared by both writers below).
function sessionRecord(harness: string, pid: number, sessionId: string, at: Date): SessionFile {
    const parsed = SessionFileSchema.safeParse({ sessionId, at: at.toISOString() })
    if (!parsed.success) {
        throw summitError('SUMMIT_BAD_INPUT', 'unusable session id', 'sessionRecord', { harness, pid, sessionId })
    }
    return parsed.data
}

// Purpose: record the session that host process `pid` of `harness` runs now (atomic write).
export async function writeSession(root: string, harness: string, pid: number, sessionId: string): Promise<void> {
    await writeJsonAtomic(sessionFile(root, harness, pid), sessionRecord(harness, pid, sessionId, new Date()))
    log('info', 'writeSession', 'session recorded', { harness, pid, sessionId })
}

// Purpose: the synchronous form of writeSession, with a chosen `at`, for in-process test callers that
// must stay synchronous (test/helpers). Not atomic: no reader runs while a test sets up a caller.
export function writeSessionSync(root: string, harness: string, pid: number, sessionId: string, at = new Date()): void {
    const file = sessionFile(root, harness, pid)
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE })
    fs.writeFileSync(file, jsonText(sessionRecord(harness, pid, sessionId, at)), { mode: FILE_MODE })
}

// Purpose: the session id that host process `pid` of `harness` runs now, or null when its host side
// never wrote one, wrote an unreadable file (logged), or wrote it before `notBefore` (a server passes its
// start time minus SESSION_CLOCK_TOLERANCE_MS: an older file belongs to a dead process that had the pid).
export async function readSession(
    root: string,
    harness: string,
    pid: number,
    opts: { notBefore?: number } = {},
): Promise<string | null> {
    let file: SessionFile | null
    try {
        file = await readJsonFile(sessionFile(root, harness, pid), SessionFileSchema)
    } catch (err) {
        log('warn', 'readSession', 'unreadable session file; treated as none', { harness, pid, error: String(err) })
        return null
    }
    if (file === null) return null
    const at = Date.parse(file.at)
    if (opts.notBefore !== undefined && !(at >= opts.notBefore)) {
        // Once per (file, at): the timer reads it every 2 s.
        const seen = `${harness}-${pid}-${file.at}`
        if (!rejectedLogged.has(seen)) {
            rejectedLogged.add(seen)
            log('warn', 'readSession', 'session file older than this server; ignored (hooks did not run?)', {
                harness,
                pid,
                at: file.at,
                notBefore: new Date(opts.notBefore).toISOString(),
            })
        }
        return null
    }
    return file.sessionId
}

// Purpose: the harness and pid of a session file name, or null for any other file: the name must be
// exactly what sessionFile (the one name builder) gives for them.
function sessionFileOwner(root: string, name: string): { harness: string; pid: number } | null {
    for (const harness of SESSION_FILE_HARNESSES) {
        const pid = Number(name.slice(harness.length + 1, -'.json'.length))
        if (Number.isInteger(pid) && pid > 0 && path.basename(sessionFile(root, harness, pid)) === name)
            return { harness, pid }
    }
    return null
}

// Purpose: at server start, delete session files older than CLEANUP_AGE_MS whose session nobody beats
// any more (a live claude can run one session for days: its file stays). Best effort, logged.
export async function cleanupSessions(root: string, now = Date.now()): Promise<void> {
    const names = new Set(await fsp.readdir(sessionsDir(root)).catch(() => [] as string[]))
    for (const name of names) {
        const owner = sessionFileOwner(root, name)
        if (owner === null) continue
        const file = await readJsonFile(sessionFile(root, owner.harness, owner.pid), SessionFileSchema).catch(
            () => null,
        )
        // Math.abs: a stamp far in the future (a clock set back, or set by hand) is cleaned up too.
        if (file === null || Math.abs(now - Date.parse(file.at)) <= CLEANUP_AGE_MS) continue
        const beat = await beatTime(root, joinHostKey(owner.harness, file.sessionId))
        if (beat !== null && !isStaleMtime(beat, now)) continue
        await fsp.rm(sessionFile(root, owner.harness, owner.pid), { force: true }).catch(() => undefined)
        log('info', 'cleanupSessions', 'removed an old session file', { name, sessionId: file.sessionId })
    }
}
