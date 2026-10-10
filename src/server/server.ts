// The MCP stdio server: registers the eight tools and maps every call to a CallContext. Logs go to
// stderr and the log file only; stdout carries the protocol.
import type { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { summitError, toSummitError } from '../core/errors.js'
import { defaultExec, type Exec } from '../core/exec.js'
import { cleanupBeats, startHeartbeat } from '../core/heartbeat.js'
import { isSignalHarness, PI_SESSION_ENV, type RequestMeta } from '../core/hostKey.js'
import { configureLog, log } from '../core/log.js'
import { summitRoot } from '../core/paths.js'
import { SUMMIT_NAME, type Harness } from '../core/schemas.js'
import { callHostKey, type CallContext } from '../flows/context.js'
import { TOOLS, type ToolDef } from './tools.js'

export const SERVER_VERSION = '1.0.0'
// How long shutdown waits for running tool calls before it exits anyway (REVIEW m7).
export const SHUTDOWN_GRACE_MS = 3_000

// Tool calls that have started and not yet answered. Shutdown waits for them (bounded).
const inFlight = new Set<Promise<unknown>>()

export interface ServerOptions {
    harness: Harness
    root?: string
    exec?: Exec
    // The parent pid, read once at server start (default: process.ppid now).
    hostPid?: number
    // pi: the session id from PI_SESSION_ENV, read once at server start.
    sessionEnv?: string
}

// Purpose: run one tool definition for one request and shape the MCP result. Errors become
// `isError` results carrying the structured error; they never crash the server.
export async function runTool<I extends z.ZodObject, O extends z.ZodObject>(
    def: ToolDef<I, O>,
    call: CallContext,
    args: unknown,
): Promise<CallToolResult> {
    try {
        const parsed = def.input.safeParse(args ?? {})
        if (!parsed.success) {
            throw summitError('SUMMIT_BAD_INPUT', `invalid arguments for ${def.name}`, def.name, {
                issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
            })
        }
        const input = parsed.data
        const output = def.output.parse(await def.run(call, input)) as Record<string, unknown>
        log('info', def.name, 'tool ok', { harness: call.harness })
        return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output }
    } catch (err) {
        const e = toSummitError(err, def.name, { args })
        log('warn', def.name, 'tool failed', { error: e.toJSON() })
        return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: e.toJSON() }) }] }
    }
}

// Purpose: build the MCP server with all tools registered.
export function createSummitServer(options: ServerOptions): McpServer {
    const root = options.root ?? summitRoot()
    const exec = options.exec ?? defaultExec
    const hostPid = options.hostPid ?? process.ppid
    const server = new McpServer({ name: SUMMIT_NAME, version: SERVER_VERSION })
    for (const def of TOOLS as ToolDef<z.ZodObject, z.ZodObject>[]) {
        server.registerTool(
            def.name,
            { description: def.description, inputSchema: def.input, outputSchema: def.output },
            async (args: unknown, extra: { _meta?: Record<string, unknown> }) => {
                const call: CallContext = {
                    root,
                    harness: options.harness,
                    meta: extra._meta as RequestMeta,
                    hostPid,
                    pid: process.pid,
                    sessionEnv: options.sessionEnv,
                    exec,
                }
                const running = runTool(def, call, args)
                inFlight.add(running)
                try {
                    return await running
                } finally {
                    inFlight.delete(running)
                }
            },
        )
    }
    return server
}

// Purpose: wait until every running tool call has answered, or `graceMs` passed. True when idle.
export async function drainInFlight(graceMs: number): Promise<boolean> {
    const idle = Promise.allSettled([...inFlight]).then(() => true)
    const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), graceMs).unref())
    return await Promise.race([idle, timeout])
}

// Purpose: let the SDK write the answers of the drained calls, then wait until stdout has flushed
// them (bounded), so process.exit does not drop a response.
async function flushStdout(): Promise<void> {
    await new Promise((r) => setImmediate(r))
    await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 500).unref()
        process.stdout.write('', () => {
            clearTimeout(timer)
            resolve()
        })
    })
}

// Purpose: the exit signals this platform delivers (SPEC §7): SIGTERM and SIGINT everywhere, SIGHUP
// only off Windows (Windows has no SIGHUP; Node only emulates it when a console window closes).
export function exitSignals(platform: NodeJS.Platform = process.platform): NodeJS.Signals[] {
    return platform === 'win32' ? ['SIGTERM', 'SIGINT'] : ['SIGTERM', 'SIGHUP', 'SIGINT']
}

// Purpose: exit cleanly on an exit signal or stdin end (SPEC §7): let running tool calls finish (bounded
// by SHUTDOWN_GRACE_MS, so a kill during a members.json write does not leave the lock behind), then exit
// 0. Never deletes folders. On Windows a harness usually ends the server by closing stdin or by
// terminating it, so only the stdin path drains there.
function installExitHandlers(harness: Harness, stopHeartbeat: () => void): void {
    let exiting = false
    // Purpose: drain, log, flush and exit 0 once, whichever signal comes first.
    const exit = async (why: string) => {
        if (exiting) return
        exiting = true
        stopHeartbeat()
        const pending = inFlight.size
        const drained = await drainInFlight(SHUTDOWN_GRACE_MS)
        log('info', 'mcp', 'exiting', { why, harness, pending, drained })
        await flushStdout()
        process.exit(0)
    }
    for (const sig of exitSignals()) process.once(sig, () => exit(sig))
    process.stdin.once('end', () => exit('stdin end'))
}

// Purpose: start this server's heartbeat (SPEC §7): drop heartbeat files of long-ended sessions, then
// beat the host's current session key on every tick (claude and omp read their session file each time,
// so `/clear` and `/new` move the beat to the new session; pi's key is fixed by its env). Codex keys are
// added by the calls themselves (beatCaller); opencode beats nothing.
export async function startServing(root: string, base: CallContext): Promise<() => void> {
    await cleanupBeats(root).catch((err: unknown) =>
        log('warn', 'startServing', 'heartbeat cleanup failed', { error: String(err) }),
    )
    // Purpose: the host key of the host's current session, or none (not recorded yet, or no such key).
    const current = async (): Promise<string[]> =>
        isSignalHarness(base.harness)
            ? await callHostKey(base).then(
                  (k) => [k],
                  () => [],
              )
            : []
    return startHeartbeat(root, base.harness, current)
}

// Purpose: entry point of `harness-summit mcp --harness <h>`. The parent pid and the pi session env are
// read once, here: after the host dies, Linux reparents the server and process.ppid names init.
export async function runMcpServer(harness: Harness): Promise<void> {
    configureLog({ stderr: true, component: `mcp-${harness}` })
    const root = summitRoot()
    const hostPid = process.ppid
    const sessionEnv = harness === 'pi' ? process.env[PI_SESSION_ENV] : undefined
    const base: CallContext = {
        root,
        harness,
        meta: undefined,
        hostPid,
        pid: process.pid,
        sessionEnv,
        exec: defaultExec,
    }
    installExitHandlers(harness, await startServing(root, base))
    const server = createSummitServer({ harness, root, hostPid, sessionEnv })
    await server.connect(new StdioServerTransport())
    log('info', 'mcp', 'server started', { harness, pid: process.pid, hostPid, sessionEnv, cwd: process.cwd(), root })
}
