// Shared context and steps for the tool flows.
import { refreshAgentPid } from '../core/agents.js'
import { summitError, toSummitError } from '../core/errors.js'
import type { Exec } from '../core/exec.js'
import { isPidKeyed, resolveHostKey, type RequestMeta } from '../core/hostKey.js'
import { requireHost } from '../core/identity.js'
import { log } from '../core/log.js'
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

// Purpose: record the pid that serves the caller now in its agent.json (F1: a resumed Codex thread
// or a restarted server keeps the identity but runs under a new pid). Best effort: liveness is a
// hint, so a failure is logged and never fails the tool call.
export async function refreshCallerPid(call: CallContext, host: HostRecord): Promise<void> {
    await refreshAgentPid(call.root, host.groupKey, host.uuid, agentPidFor(call)).catch((err) =>
        log('warn', 'refreshCallerPid', 'could not refresh the liveness pid', {
            error: toSummitError(err, 'refreshCallerPid', { hostKey: host.hostKey }).toJSON(),
        }),
    )
}

// Purpose: step that loads the caller's identity or fails with SUMMIT_NOT_JOINED. The record is
// checked for staleness and repaired after an unfinished group move (src/core/identity.ts); the
// caller's liveness pid is refreshed (F1).
export function requireHostStep<C extends WithHost>() {
    return step<C>('requireHost', async (ctx) => {
        const host = await requireHost(ctx.call.root, need(ctx.hostKey, 'hostKey'))
        await refreshCallerPid(ctx.call, host)
        return { ...ctx, host }
    })
}
