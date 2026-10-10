// Shared context and steps for the tool flows.
import { summitError, toSummitError } from '../core/errors.js'
import type { Exec } from '../core/exec.js'
import { beat, serveHostKey } from '../core/heartbeat.js'
import { isSignalHarness, resolveHostKey, usesSessionFile, type RequestMeta } from '../core/hostKey.js'
import { requireHost } from '../core/identity.js'
import { log } from '../core/log.js'
import { step } from '../core/pipe.js'
import type { Harness, HostRecord } from '../core/schemas.js'
import { readSession, SESSION_CLOCK_TOLERANCE_MS } from '../core/sessions.js'

// Everything a flow needs to know about the call and the process it runs in.
export interface CallContext {
    root: string
    harness: Harness
    meta: RequestMeta
    // The MCP server's parent pid, read ONCE when the server started (the host process for claude, pi
    // and omp). Read again later, it would name init after the host died (Linux reparents).
    hostPid: number
    // The MCP server's own pid.
    pid: number
    // pi only: the session id the pi extension put into this server's env (PI_SESSION_ENV), read once.
    sessionEnv?: string
    // When this server started (epoch ms). A session file written before it, minus
    // SESSION_CLOCK_TOLERANCE_MS, belongs to a dead process that had the same pid (src/core/sessions.ts).
    startedAt: number
    exec: Exec
}

export interface WithHostKey {
    call: CallContext
    hostKey?: string
}

export interface WithHost extends WithHostKey {
    host?: HostRecord
}

// Purpose: assert a value set by an earlier step (a missing value is a programming error).
export function need<T>(value: T | undefined, what: string): T {
    if (value === undefined) {
        log('error', 'need', 'flow bug: value not set', { what })
        throw summitError('SUMMIT_INTERNAL', `flow bug: ${what} not set by an earlier step`, 'need', { what })
    }
    return value
}

// Purpose: the session id the host provides for a signal harness (SPEC §3): claude and omp from the
// session file of the host process (read on every call: `/clear` and `/new` change it; a file older than
// this server is not trusted), pi from the env;
// undefined for codex and opencode (they send ids in `_meta`) and when the host side wrote nothing.
export async function callSessionId(call: CallContext): Promise<string | undefined> {
    if (usesSessionFile(call.harness)) {
        const notBefore = call.startedAt - SESSION_CLOCK_TOLERANCE_MS
        return (await readSession(call.root, call.harness, call.hostPid, { notBefore })) ?? undefined
    }
    return call.harness === 'pi' ? call.sessionEnv : undefined
}

// Purpose: the host key of one call (src/core/hostKey.ts, with the host-provided session id).
export async function callHostKey(call: CallContext): Promise<string> {
    return resolveHostKey({ harness: call.harness, meta: call.meta, sessionId: await callSessionId(call) })
}

// Purpose: step that resolves the host key of this call.
export function hostKeyStep<C extends WithHostKey>() {
    return step<C>('resolveHostKey', async (ctx) => ({ ...ctx, hostKey: await callHostKey(ctx.call) }))
}

// Purpose: agent.json pid rule (SPEC §4, informational only): the host pid for claude/pi/omp, the MCP
// server's own pid for codex, null for opencode (one server process serves many sessions).
export function agentPidFor(call: CallContext): number | null {
    if (isSignalHarness(call.harness)) return call.hostPid
    return call.harness === 'codex' ? call.pid : null
}

// Purpose: beat the caller's host key now (SPEC §7), so a fresh or resumed agent reads alive at once; a
// Codex key is also registered with this server's timer (a `codex resume` runs a new server, which serves
// the thread from its first call). Claude, pi and omp keys come back on every tick from the session
// itself, so they are not registered (an old session must stop beating after `/clear`). OpenCode is
// skipped: its liveness is always "unknown". Best effort: a failure is logged and never fails the call.
export async function beatCaller(call: CallContext, hostKey: string): Promise<void> {
    if (call.harness === 'opencode') return
    if (call.harness === 'codex') serveHostKey(hostKey)
    await beat(call.root, hostKey, call.harness).catch((err) =>
        log('warn', 'beatCaller', 'could not write the heartbeat', {
            error: toSummitError(err, 'beatCaller', { hostKey }).toJSON(),
        }),
    )
}

// Purpose: step that loads the caller's identity or fails with SUMMIT_NOT_JOINED. The record is
// repaired after an unfinished group move (src/core/identity.ts); the caller's agent is beaten.
export function requireHostStep<C extends WithHost>() {
    return step<C>('requireHost', async (ctx) => {
        const host = await requireHost(ctx.call.root, need(ctx.hostKey, 'hostKey'))
        await beatCaller(ctx.call, host.hostKey)
        return { ...ctx, host }
    })
}
