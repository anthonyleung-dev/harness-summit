// The MCP stdio server: registers the eight tools and maps every call to a CallContext. Logs go to
// stderr and the log file only; stdout carries the protocol.
import type { z } from 'zod'

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

import { summitError, toSummitError } from '../core/errors.js'
import { defaultExec, type Exec } from '../core/exec.js'
import { serveHostKey, startHeartbeat } from '../core/heartbeat.js'
import { hostKeyForPid, isPidKeyed, type RequestMeta } from '../core/hostKey.js'
import { dropStaleHost } from '../core/identity.js'
import { configureLog, log } from '../core/log.js'
import { summitRoot } from '../core/paths.js'
import { SUMMIT_NAME, type Harness } from '../core/schemas.js'
import type { CallContext } from '../flows/context.js'
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
                    ppid: process.ppid,
                    pid: process.pid,
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

// Purpose: start this server's heartbeat (SPEC §3, §7). A pid-keyed server (claude, pi, omp) first drops
// the record of its host key when no server beat its agent for HEARTBEAT_STALE_MS (a dead session whose
// pid this host now has), then serves that key; a Codex server registers threads as calls arrive.
// Runs before the transport connects, so no tool call sees a record the check would drop.
export async function startServing(root: string, harness: Harness): Promise<() => void> {
    if (isPidKeyed(harness)) {
        const hostKey = hostKeyForPid(harness, process.ppid)
        await dropStaleHost(root, hostKey).catch((err) =>
            log('warn', 'startServing', 'stale host check failed; record kept', { hostKey, error: String(err) }),
        )
        serveHostKey(hostKey)
    }
    return startHeartbeat(root)
}

// Purpose: entry point of `harness-summit mcp --harness <h>`.
export async function runMcpServer(harness: Harness): Promise<void> {
    configureLog({ stderr: true, component: `mcp-${harness}` })
    const root = summitRoot()
    installExitHandlers(harness, await startServing(root, harness))
    const server = createSummitServer({ harness, root })
    await server.connect(new StdioServerTransport())
    log('info', 'mcp', 'server started', {
        harness,
        pid: process.pid,
        ppid: process.ppid,
        cwd: process.cwd(),
        root,
    })
}
