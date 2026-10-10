// Receiver-side hooks: Claude Code SessionStart / FileChanged (SPEC §3, §6) and the arm call of the
// pi/OMP extension. Each returns what the CLI must print and the exit code; nothing here writes to
// stdout or stderr directly. Identity and the wake signal follow the harness session: SessionStart
// records the session id the claude process runs now (startup, resume, clear, compact) in its session
// file, and arms `<root>/.wake/claude-<sessionId>.signal`.
import path from 'node:path'
import { z } from 'zod'

import { summitError, toSummitError } from '../core/errors.js'
import { hostKeyForSession } from '../core/hostKey.js'
import { log, logFilePath } from '../core/log.js'
import { noticeForHostKey } from '../core/notice.js'
import { signalPathFor } from '../core/paths.js'
import { normalizeRootPath } from '../core/project.js'
import type { Harness } from '../core/schemas.js'
import { readSession, writeSession } from '../core/sessions.js'
import { ensureSignal } from '../core/signal.js'

export interface HookResult {
    stdout?: string
    stderr?: string
    exitCode: number
}

export interface HookEnv {
    root: string
    env: NodeJS.ProcessEnv
    ppid: number
}

const SessionStartInput = z.looseObject({ session_id: z.string().optional(), source: z.string().optional() })
const FileChangedInput = z.looseObject({ file_path: z.string().optional(), event: z.string().optional() })

// Purpose: parse hook stdin JSON leniently (bad input is logged and treated as empty).
function parseStdin<S extends z.ZodType>(text: string, schema: S, fn: string): z.infer<S> {
    try {
        return schema.parse(text.trim() === '' ? {} : JSON.parse(text))
    } catch (err) {
        log('warn', fn, 'unreadable hook input', { error: String(err) })
        return schema.parse({})
    }
}

// Purpose: the claude pid of this hook: its parent pid. Exec-form hooks are spawned by claude directly
// (no shell), so the parent is claude (verified from Claude Code 2.1.296). `$CLAUDE_PID` is inherited env
// and can be stale or forged (a claude started from another claude's tool call inherits it), so it only
// confirms: a value that differs from the parent pid is logged and ignored.
export function claudePid(env: NodeJS.ProcessEnv, ppid: number): number {
    const fromEnv = env.CLAUDE_PID
    if (fromEnv !== undefined && fromEnv !== '' && Number(fromEnv) !== ppid) {
        log('warn', 'claudePid', 'CLAUDE_PID differs from the hook parent pid; using the parent pid', {
            claudePidEnv: fromEnv,
            ppid,
        })
    }
    return ppid
}

// Purpose: tell whether two paths name the same file, compared through the one path normalizer
// (normalizeRootPath: one separator and a lower-case drive letter on Windows; Claude reports the
// changed file with backslashes there).
function samePath(a: string, b: string): boolean {
    return normalizeRootPath(path.resolve(a)) === normalizeRootPath(path.resolve(b))
}

// Purpose: arm the signal file of a session's host key (touch: never truncate) and return its path.
export async function armSignal(root: string, hostKey: string): Promise<{ hostKey: string; signalPath: string }> {
    const signalPath = signalPathFor(root, hostKey)
    await ensureSignal(signalPath)
    log('debug', 'armSignal', 'armed', { hostKey, signalPath })
    return { hostKey, signalPath }
}

// Purpose: SessionStart: record the session this claude process runs now (`.sessions/claude-<pid>.json`,
// read by its MCP server on every call), arm `<root>/.wake/claude-<sessionId>.signal`, print watchPaths,
// and add the notice as additionalContext when mail is already unread (the watcher ignores initial
// content). Without a session id in stdin nothing is armed (logged).
export async function claudeSessionStart(stdin: string, he: HookEnv): Promise<HookResult> {
    const input = parseStdin(stdin, SessionStartInput, 'claudeSessionStart')
    try {
        const pid = claudePid(he.env, he.ppid)
        const hostKey = hostKeyForSession('claude', input.session_id)
        await writeSession(he.root, 'claude', pid, input.session_id as string)
        const { signalPath } = await armSignal(he.root, hostKey)
        const notice = await noticeForHostKey(he.root, hostKey)
        const out = {
            hookSpecificOutput: {
                hookEventName: 'SessionStart',
                watchPaths: [signalPath],
                ...(notice !== null ? { additionalContext: notice } : {}),
            },
        }
        log('info', 'claudeSessionStart', 'armed', { hostKey, pid, source: input.source, unread: notice !== null })
        return { stdout: JSON.stringify(out) + '\n', exitCode: 0 }
    } catch (err) {
        log('error', 'claudeSessionStart', 'arm failed', { error: toSummitError(err, 'claudeSessionStart').toJSON() })
        return { exitCode: 0 }
    }
}

// Purpose: FileChanged (asyncRewake): exit 2 with the notice on stderr when the session this claude
// process runs now has unread mail and the changed file is its signal, else exit 0. Never prints
// watchPaths (that would replace the watch list).
export async function claudeFileChanged(stdin: string, he: HookEnv): Promise<HookResult> {
    const input = parseStdin(stdin, FileChangedInput, 'claudeFileChanged')
    try {
        const sessionId = await readSession(he.root, 'claude', claudePid(he.env, he.ppid))
        if (sessionId === null) {
            log('warn', 'claudeFileChanged', 'no session recorded for this claude process', { ppid: he.ppid })
            return { exitCode: 0 }
        }
        const hostKey = hostKeyForSession('claude', sessionId)
        const ours = signalPathFor(he.root, hostKey)
        if (input.file_path === undefined || !samePath(input.file_path, ours) || input.event === 'unlink') {
            log('warn', 'claudeFileChanged', 'not our signal', { file: input.file_path, ours, event: input.event })
            return { exitCode: 0 }
        }
        const notice = await noticeForHostKey(he.root, hostKey)
        if (notice === null) return { exitCode: 0 }
        log('info', 'claudeFileChanged', 'waking', { hostKey })
        return { stderr: notice + '\n', exitCode: 2 }
    } catch (err) {
        log('error', 'claudeFileChanged', 'failed', { error: toSummitError(err, 'claudeFileChanged').toJSON() })
        return { exitCode: 0 }
    }
}

// Purpose: `hook ext-arm`: the pi/OMP extension's arm call on every session start or switch. OMP keeps its
// MCP server across `/new`, so its session is recorded in `.sessions/omp-<pid>.json` for that server; pi
// hands the session id to its server in the env. Then the session's signal is armed. Prints host key,
// signal path and log file.
export async function extArm(
    harness: 'pi' | 'omp',
    sessionId: string,
    pid: number | null,
    root: string,
): Promise<HookResult> {
    const hostKey = hostKeyForSession(harness, sessionId)
    if (harness === 'omp') {
        if (pid === null) {
            throw summitError('SUMMIT_BAD_INPUT', 'ext-arm for omp needs --pid', 'extArm', { harness, sessionId })
        }
        await writeSession(root, harness, pid, sessionId)
    }
    const armed = await armSignal(root, hostKey)
    log('info', 'extArm', 'armed', { harness, pid, ...armed })
    return { stdout: JSON.stringify({ ...armed, logFile: logFilePath() }) + '\n', exitCode: 0 }
}
