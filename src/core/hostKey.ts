// Host-key resolution (SPEC §3). The only module that knows how each harness names its caller.
// claude/pi/omp: `<harness>-<host pid>`; codex: `codex-<threadId>`; opencode: `opencode-<sessionID>`.
import { summitError } from './errors.js'
import { log } from './log.js'
import type { Harness } from './schemas.js'

export type RequestMeta = Record<string, unknown> | undefined

export const CODEX_THREAD_KEY = 'threadId'
export const CODEX_TURN_META_KEY = 'x-codex-turn-metadata'
export const OPENCODE_SESSION_KEY = 'ai.opencode/sessionID'

const ID_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/

// The one list of harnesses that identify their caller by host pid (one host process = one agent).
// `isPidKeyed` and `pidOfHostKey` both derive from it (DELTA-REVIEW-1 N2).
export const PID_KEYED_HARNESSES: readonly Harness[] = ['claude', 'pi', 'omp']
const PID_HOST_KEY = new RegExp(`^(${PID_KEYED_HARNESSES.join('|')})-(\\d+)$`)

// Purpose: tell whether the harness identifies its caller by host pid.
export function isPidKeyed(harness: Harness): boolean {
    return PID_KEYED_HARNESSES.includes(harness)
}

// Purpose: host key of a pid-keyed harness. Used by the MCP server (pid = process.ppid), the Claude
// hooks (pid = $CLAUDE_PID) and the pi/OMP extension (pid = its process.pid).
export function hostKeyForPid(harness: Harness, pid: number): string {
    if (!isPidKeyed(harness) || !Number.isInteger(pid) || pid <= 0) {
        throw summitError('SUMMIT_NO_HOST_KEY', `no pid host key for ${harness}`, 'hostKeyForPid', { harness, pid })
    }
    return `${harness}-${pid}`
}

// Purpose: the host pid inside a pid-keyed host key (`claude-123` → 123), or null for codex/opencode
// keys and anything else.
export function pidOfHostKey(hostKey: string): number | null {
    const m = PID_HOST_KEY.exec(hostKey)
    return m ? Number(m[2]) : null
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

// Purpose: resolve the host key of one tool call. Never reads env (SPEC §3).
export function resolveHostKey(input: { harness: Harness; meta: RequestMeta; ppid: number }): string {
    const { harness, meta, ppid } = input
    if (isPidKeyed(harness)) return hostKeyForPid(harness, ppid)
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
