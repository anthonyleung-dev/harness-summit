// Receiver-side hooks: Claude Code SessionStart / FileChanged (SPEC §6) and the arm call of the
// pi/OMP extension. Each returns what the CLI must print and the exit code; nothing here writes to
// stdout or stderr directly.
import path from 'node:path'
import { z } from 'zod'

import { toSummitError } from '../core/errors.js'
import { hostKeyForPid } from '../core/hostKey.js'
import { log, logFilePath } from '../core/log.js'
import { noticeForHostKey } from '../core/notice.js'
import { signalPathFor } from '../core/paths.js'
import type { Harness } from '../core/schemas.js'
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

// Purpose: the claude pid of this hook: $CLAUDE_PID, else the hook's parent pid.
export function claudePid(env: NodeJS.ProcessEnv, ppid: number): number {
    const fromEnv = Number(env.CLAUDE_PID)
    if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
    log('debug', 'claudePid', 'CLAUDE_PID unset; using the hook parent pid', { ppid })
    return ppid
}

// Purpose: arm the signal file of a pid-keyed host and return its host key and path.
export async function armSignal(
    root: string,
    harness: Harness,
    pid: number,
): Promise<{ hostKey: string; signalPath: string }> {
    const hostKey = hostKeyForPid(harness, pid)
    const signalPath = signalPathFor(root, hostKey)
    await ensureSignal(signalPath)
    log('debug', 'armSignal', 'armed', { hostKey, signalPath })
    return { hostKey, signalPath }
}

// Purpose: SessionStart: arm `<root>/.wake/claude-<pid>.signal`, print watchPaths, and add the
// notice as additionalContext when mail is already unread (the watcher ignores initial content).
export async function claudeSessionStart(stdin: string, he: HookEnv): Promise<HookResult> {
    const input = parseStdin(stdin, SessionStartInput, 'claudeSessionStart')
    try {
        const { hostKey, signalPath } = await armSignal(he.root, 'claude', claudePid(he.env, he.ppid))
        const notice = await noticeForHostKey(he.root, hostKey)
        const out = {
            hookSpecificOutput: {
                hookEventName: 'SessionStart',
                watchPaths: [signalPath],
                ...(notice !== null ? { additionalContext: notice } : {}),
            },
        }
        log('info', 'claudeSessionStart', 'armed', { hostKey, source: input.source, unread: notice !== null })
        return { stdout: JSON.stringify(out) + '\n', exitCode: 0 }
    } catch (err) {
        log('error', 'claudeSessionStart', 'arm failed', { error: toSummitError(err, 'claudeSessionStart').toJSON() })
        return { exitCode: 0 }
    }
}

// Purpose: FileChanged (asyncRewake): exit 2 with the notice on stderr when this host has unread
// mail, else exit 0. Never prints watchPaths (that would replace the watch list).
export async function claudeFileChanged(stdin: string, he: HookEnv): Promise<HookResult> {
    const input = parseStdin(stdin, FileChangedInput, 'claudeFileChanged')
    try {
        const hostKey = hostKeyForPid('claude', claudePid(he.env, he.ppid))
        const ours = signalPathFor(he.root, hostKey)
        if (input.file_path === undefined || path.resolve(input.file_path) !== ours || input.event === 'unlink') {
            log('debug', 'claudeFileChanged', 'not our signal', { file: input.file_path, event: input.event })
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

// Purpose: `hook ext-arm`: the pi/OMP extension's arm call. Prints host key, signal path, log file.
export async function extArm(harness: Harness, pid: number, root: string): Promise<HookResult> {
    const armed = await armSignal(root, harness, pid)
    log('info', 'extArm', 'armed', { harness, ...armed })
    return { stdout: JSON.stringify({ ...armed, logFile: logFilePath() }) + '\n', exitCode: 0 }
}
