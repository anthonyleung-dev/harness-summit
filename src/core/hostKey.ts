// Host-key resolution (SPEC §3). The only module that knows how each harness names its caller. Every key
// follows the harness SESSION, not a process, so a resumed session gets its agent back:
// claude/pi/omp: `<harness>-<sessionId>`; codex: `codex-<threadId>`; opencode: `opencode-<sessionID>`.
import { summitError } from './errors.js'
import { log } from './log.js'
import type { Harness } from './schemas.js'

export type RequestMeta = Record<string, unknown> | undefined

export const CODEX_THREAD_KEY = 'threadId'
export const CODEX_TURN_META_KEY = 'x-codex-turn-metadata'
export const OPENCODE_SESSION_KEY = 'ai.opencode/sessionID'
// The env name through which the pi extension hands the session id to the server it registers.
export const PI_SESSION_ENV = 'SUMMIT_SESSION_ID'

export const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

// The harnesses woken by a signal file and keyed by a session id that the host side provides (not by
// `_meta`). `isSignalHarness` derives from it (DELTA-REVIEW-1 N2).
export const SIGNAL_HARNESSES: readonly Harness[] = ['claude', 'pi', 'omp']
// Of those, the ones whose server reads the session id from `<root>/.sessions/<harness>-<hostPid>.json`
// (their server lives across `/clear` or `/new`). pi gets it in the server's env instead (PI_SESSION_ENV).
export const SESSION_FILE_HARNESSES: readonly Harness[] = ['claude', 'omp']

// Why a signal harness call has no session id, in words a user can act on.
const NO_SESSION: Record<string, string> = {
    claude: 'no Claude Code session recorded for this server: the harness-summit plugin hooks did not run (SessionStart writes .sessions/claude-<pid>.json); restart Claude Code with the harness-summit plugin enabled',
    pi: `${PI_SESSION_ENV} is not set: the harness-summit pi extension registers this server; remove any harness-summit entry from ~/.pi/agent/mcp.json and restart pi`,
    omp: 'no OMP session recorded for this server: the harness-summit OMP extension did not run (it writes .sessions/omp-<pid>.json in an interactive session)',
}

// Purpose: tell whether the harness is woken by a signal file and keyed by a host-provided session id.
export function isSignalHarness(harness: Harness): boolean {
    return SIGNAL_HARNESSES.includes(harness)
}

// Purpose: tell whether the harness's server reads its session id from a session file.
export function usesSessionFile(harness: Harness): boolean {
    return SESSION_FILE_HARNESSES.includes(harness)
}

// Purpose: host key of a signal harness session. Used by the MCP server, the Claude hooks and the pi/OMP
// extension's arm call.
export function hostKeyForSession(harness: Harness, sessionId: string | undefined): string {
    if (!isSignalHarness(harness) || sessionId === undefined || sessionId === '') {
        const why = NO_SESSION[harness] ?? `no session host key for ${harness}`
        throw summitError('SUMMIT_NO_HOST_KEY', why, 'hostKeyForSession', { harness })
    }
    if (!ID_PATTERN.test(sessionId)) {
        throw summitError('SUMMIT_NO_HOST_KEY', 'unusable session id', 'hostKeyForSession', { harness, sessionId })
    }
    return `${harness}-${sessionId}`
}

// Purpose: read a string field from `_meta`, or undefined.
function metaString(meta: RequestMeta, key: string): string | undefined {
    const v = meta?.[key]
    return typeof v === 'string' && v !== '' ? v : undefined
}

// Purpose: the Codex thread id from `_meta.threadId`, cross-checked against the turn metadata.
export function codexThreadId(meta: RequestMeta): string | undefined {
    const threadId = metaString(meta, CODEX_THREAD_KEY)
    const turn = meta?.[CODEX_TURN_META_KEY]
    const turnThread =
        typeof turn === 'object' && turn !== null ? (turn as Record<string, unknown>).thread_id : undefined
    if (threadId !== undefined && typeof turnThread === 'string' && turnThread !== threadId) {
        log('warn', 'codexThreadId', 'threadId differs from turn metadata; using threadId', { threadId, turnThread })
    }
    return threadId
}

// Purpose: the OpenCode session id from `_meta["ai.opencode/sessionID"]`.
export function opencodeSessionId(meta: RequestMeta): string | undefined {
    return metaString(meta, OPENCODE_SESSION_KEY)
}

// Purpose: resolve the host key of one tool call. `sessionId` is what the host side provided for a signal
// harness (session file or the pi env, read by the caller); codex and opencode come from `_meta`.
export function resolveHostKey(input: { harness: Harness; meta: RequestMeta; sessionId?: string }): string {
    const { harness, meta } = input
    if (isSignalHarness(harness)) return hostKeyForSession(harness, input.sessionId)
    const id = harness === 'codex' ? codexThreadId(meta) : opencodeSessionId(meta)
    const expected = harness === 'codex' ? `_meta.${CODEX_THREAD_KEY}` : `_meta["${OPENCODE_SESSION_KEY}"]`
    if (id === undefined) {
        throw summitError('SUMMIT_NO_HOST_KEY', `tool call has no ${expected}`, 'resolveHostKey', {
            harness,
            metaKeys: Object.keys(meta ?? {}),
        })
    }
    if (!ID_PATTERN.test(id)) {
        throw summitError('SUMMIT_NO_HOST_KEY', `unusable ${expected}`, 'resolveHostKey', { harness, id })
    }
    return `${harness}-${id}`
}
