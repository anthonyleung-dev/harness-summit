// Session files (SPEC §3): which harness session a host process runs now. Claude Code and OMP keep one
// MCP server per host process across `/clear` and `/new`, and they give the server no session id. So the
// host side writes `<root>/.sessions/<harness>-<hostPid>.json` = `{ sessionId, at }` every time the
// session changes (the Claude SessionStart hook on startup, resume, clear and compact; the OMP extension
// on session_start and session_switch), and the server reads it through its own parent pid on every
// call. The pid only finds the file that the live host rewrote; it never is the identity.
import { z } from 'zod'

import { summitError } from './errors.js'
import { readJsonFile, writeJsonAtomic } from './fsx.js'
import { ID_PATTERN } from './hostKey.js'
import { log } from './log.js'
import { sessionFile } from './paths.js'

// One session file.
export const SessionFileSchema = z.object({
    sessionId: z.string().regex(ID_PATTERN, 'unusable session id'),
    at: z.string(),
})
export type SessionFile = z.infer<typeof SessionFileSchema>

// Purpose: record the session that host process `pid` of `harness` runs now (atomic write).
export async function writeSession(root: string, harness: string, pid: number, sessionId: string): Promise<void> {
    const parsed = SessionFileSchema.safeParse({ sessionId, at: new Date().toISOString() })
    if (!parsed.success) {
        throw summitError('SUMMIT_BAD_INPUT', 'unusable session id', 'writeSession', { harness, pid, sessionId })
    }
    await writeJsonAtomic(sessionFile(root, harness, pid), parsed.data)
    log('info', 'writeSession', 'session recorded', { harness, pid, sessionId })
}

// Purpose: the session id that host process `pid` of `harness` runs now, or null when its host side
// never wrote one (or wrote an unreadable file, logged).
export async function readSession(root: string, harness: string, pid: number): Promise<string | null> {
    try {
        return (await readJsonFile(sessionFile(root, harness, pid), SessionFileSchema))?.sessionId ?? null
    } catch (err) {
        log('warn', 'readSession', 'unreadable session file; treated as none', { harness, pid, error: String(err) })
        return null
    }
}
