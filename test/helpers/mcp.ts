// A raw JSON-RPC client for the real MCP server process (`node dist/cli.js mcp --harness <h>`). Raw on
// purpose: tests control `_meta` exactly and can send `server/discover` before `initialize`.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import readline from 'node:readline'

import type { Harness } from '../../src/core/schemas.js'
import { cliCommand } from './env.js'

type Pending = { resolve: (v: any) => void }

export interface StartOptions {
    harness: Harness
    root: string
    // Start through `sh -c '...; exit $?'` so the server's ppid is that shell, not the test runner.
    viaShell?: boolean
    env?: NodeJS.ProcessEnv
}

export class McpProc {
    readonly child: ChildProcessWithoutNullStreams
    stderr = ''
    // stdout lines that are not JSON-RPC (must stay empty: stdout is the protocol)
    readonly nonJson: string[] = []
    private nextId = 1
    private readonly pending = new Map<number, Pending>()
    readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>

    private constructor(child: ChildProcessWithoutNullStreams) {
        this.child = child
        readline.createInterface({ input: child.stdout }).on('line', (line) => {
            let msg: any
            try {
                msg = JSON.parse(line)
            } catch {
                this.nonJson.push(line)
                return
            }
            const p = this.pending.get(msg.id)
            if (p) {
                this.pending.delete(msg.id)
                p.resolve(msg)
            }
        })
        child.stderr.on('data', (d: Buffer) => (this.stderr += d.toString()))
        this.exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
    }

    // Purpose: start one server process.
    static start(opts: StartOptions): McpProc {
        const env = { ...process.env, ...opts.env, HARNESS_SUMMIT_HOME: opts.root }
        const [cmd, argv] = cliCommand(['mcp', '--harness', opts.harness], opts.viaShell)
        const child = spawn(cmd, argv, { env })
        return new McpProc(child)
    }

    // Purpose: send a request and wait for its response message.
    request(method: string, params: Record<string, unknown> = {}): Promise<any> {
        const id = this.nextId++
        const done = new Promise((resolve) => this.pending.set(id, { resolve }))
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
        return done
    }

    // Purpose: send a notification.
    notify(method: string, params: Record<string, unknown> = {}): void {
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
    }

    // Purpose: MCP handshake.
    async initialize(): Promise<any> {
        const res = await this.request('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'harness-summit-test', version: '0' },
        })
        this.notify('notifications/initialized')
        return res
    }

    // Purpose: call a tool; returns the parsed structured result, or `{ error }` for isError results.
    async call(name: string, args: Record<string, unknown> = {}, meta?: Record<string, unknown>): Promise<any> {
        const res = await this.request('tools/call', { name, arguments: args, ...(meta ? { _meta: meta } : {}) })
        if (res.error) throw new Error(`JSON-RPC error: ${JSON.stringify(res.error)}`)
        const text = res.result.content[0].text
        return res.result.isError ? JSON.parse(text) : res.result.structuredContent
    }

    // Purpose: stop the process (SIGTERM) and wait for it.
    async close(): Promise<void> {
        this.child.stdin.end()
        this.child.kill('SIGTERM')
        await this.exited
    }
}
