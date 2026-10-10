// Shared context and steps for the tool flows.
import { summitError, toSummitError } from '../core/errors.js'
import type { Exec } from '../core/exec.js'
import { beat, serveHostKey } from '../core/heartbeat.js'
import { isPidKeyed, resolveHostKey, type RequestMeta } from '../core/hostKey.js'
import { requireHost } from '../core/identity.js'
import { log } from '../core/log.js'
import { mailboxOf } from '../core/paths.js'
import { step } from '../core/pipe.js'
import type { Harness, HostRecord } from '../core/schemas.js'

// Everything a flow needs to know about the call and the process it runs in.
export interface CallContext {
    root: string
    harness: Harness
    meta: RequestMeta
    // The MCP server's parent pid (host pid for claude/pi/omp).
    ppid: number
    // The MCP server's own pid.
    pid: number
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

// Purpose: step that resolves the host key of this call.
export function hostKeyStep<C extends WithHostKey>() {
    return step<C>('resolveHostKey', (ctx) => ({
        ...ctx,
        hostKey: resolveHostKey({ harness: ctx.call.harness, meta: ctx.call.meta, ppid: ctx.call.ppid }),
    }))
}

// Purpose: agent.json pid rule (SPEC §4): host pid for claude/pi/omp, the MCP server's own pid for
// codex, null for opencode (one server process serves many sessions).
export function agentPidFor(call: CallContext): number | null {
    if (isPidKeyed(call.harness)) return call.ppid
    return call.harness === 'codex' ? call.pid : null
}

// Purpose: beat the caller's agent now and register its host key with this server's heartbeat timer
// (SPEC §7): a Codex thread is served by whichever server sees its calls (a `codex resume` runs a new
// server), and a pid-keyed agent is beaten from its first call even before the next tick. OpenCode is
// skipped: its liveness is always "unknown". Best effort: a failure is logged and never fails the call.
export async function beatCaller(call: CallContext, host: HostRecord): Promise<void> {
    if (call.harness === 'opencode') return
    serveHostKey(host.hostKey)
    await beat(mailboxOf(call.root, host)).catch((err) =>
        log('warn', 'beatCaller', 'could not write the heartbeat', {
            error: toSummitError(err, 'beatCaller', { hostKey: host.hostKey }).toJSON(),
        }),
    )
}

// Purpose: step that loads the caller's identity or fails with SUMMIT_NOT_JOINED. The record is
// repaired after an unfinished group move (src/core/identity.ts); the caller's agent is beaten.
export function requireHostStep<C extends WithHost>() {
    return step<C>('requireHost', async (ctx) => {
        const host = await requireHost(ctx.call.root, need(ctx.hostKey, 'hostKey'))
        await beatCaller(ctx.call, host)
        return { ...ctx, host }
    })
}
