// harness-summit extension for pi and OMP (SPEC §6). One file for both harnesses.
//
// It arms the signal file `<root>/.wake/<harness>-<process.pid>.signal`, watches it, and when a sender
// rings it, asks the CLI for the notice and wakes the session:
//   pi  idle: custom message, then a steer user message (parent-wake shape, 10 s dedupe)
//   pi  busy: custom message with triggerTurn + deliverAs followUp
//   OMP     : custom message with triggerTurn + deliverAs followUp
//
// It imports nothing from the harness-summit sources on purpose: the installed copy lives alone in
// ~/.pi/agent/extensions or ~/.omp/agent/extensions. Host key, signal path and notice text all come
// from the CLI (`hook ext-arm`, `notice`), so this file holds none of that logic. `install` replaces
// the two INJECTED_ constants; a copy loaded from the repo finds the CLI next to itself.
//
// Spawning (XPLAT-AUDIT B4): this file starts exactly one program, the node binary that ran install
// (`process.execPath`, a real `.exe` on Windows), with the CLI as its first argument. It never starts a
// `.cmd` shim, so it needs no copy of the Windows batch-file door (src/core/exec.ts): every other
// command runs inside the CLI, through that door. The repo fallback is the bare name `node`, which
// libuv finds as `node.exe` on Windows.
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const INJECTED_HARNESS: string | null = null
const INJECTED_CLI: string[] | null = null

const WAKE_TEXT = 'harness-summit mail above. Call summit_read.'
const WAKE_DEDUPE_MS = 10_000
const SIGNAL_SETTLE_MS = 250
const CLI_TIMEOUT_MS = 10_000

type HostHarness = 'pi' | 'omp'

interface ExtError {
    code: string
    message: string
    fn: string
    inputs: Record<string, unknown>
}

interface Armed {
    hostKey: string
    signalPath: string
    logFile: string
}

// Purpose: which harness hosts this extension: injected by install, else from the process.
export function detectHarness(api: { registerMcpServer?: unknown }): HostHarness {
    if (INJECTED_HARNESS === 'pi' || INJECTED_HARNESS === 'omp') return INJECTED_HARNESS
    // `omp.exe` and `pi.exe` on Windows: compare names without the extension.
    const names = [process.execPath, ...process.argv].map((a) => path.basename(String(a)).replace(/\.exe$/i, ''))
    if (names.some((n) => n === 'omp' || n.startsWith('omp-'))) return 'omp'
    if (names.some((n) => n === 'pi' || n.includes('pi-coding-agent'))) return 'pi'
    return typeof api.registerMcpServer === 'function' ? 'pi' : 'omp'
}

// Purpose: argv prefix that starts the CLI: injected absolute paths, else `node <repo>/dist/cli.js`.
export function cliLaunch(): string[] {
    if (INJECTED_CLI !== null) return INJECTED_CLI
    const here = path.dirname(fileURLToPath(import.meta.url))
    return ['node', path.resolve(here, '..', '..', 'dist', 'cli.js')]
}

// Purpose: validate the `hook ext-arm` output (the CLI boundary DTO). This file cannot import Zod:
// the installed copy lives alone in the harness's extension dir, with no node_modules (written reason
// for a hand-written check, see repo CLAUDE.md "One function, one door").
export function parseArmed(stdout: string): Armed {
    const v = JSON.parse(stdout) as Record<string, unknown>
    for (const k of ['hostKey', 'signalPath', 'logFile'] as const) {
        if (typeof v[k] !== 'string' || v[k] === '') {
            const e: ExtError = {
                code: 'SUMMIT_BAD_INPUT',
                message: `ext-arm output lacks ${k}`,
                fn: 'parseArmed',
                inputs: { stdout },
            }
            throw e
        }
    }
    return { hostKey: v.hostKey as string, signalPath: v.signalPath as string, logFile: v.logFile as string }
}

// Purpose: run the CLI and return its stdout; rejects with a structured error.
function runCli(args: string[]): Promise<string> {
    const [cmd, ...pre] = cliLaunch()
    return new Promise((resolve, reject) => {
        execFile(
            cmd as string,
            [...pre, ...args],
            { timeout: CLI_TIMEOUT_MS, windowsHide: true },
            (err, stdout, stderr) => {
                if (err) {
                    const e: ExtError = {
                        code: 'SUMMIT_EXEC_FAILED',
                        message: `${err.message} ${stderr}`.trim(),
                        fn: 'runCli',
                        inputs: { args },
                    }
                    reject(e)
                } else resolve(stdout)
            },
        )
    })
}

// Purpose: the extension entry: arm on session start (and OMP session switch), wake on a signal,
// stop watching on shutdown. Every step logs to the summit log file.
export default function harnessSummit(api: any): void {
    const harness = detectHarness(api)
    let ctx: any
    let armed: Armed | undefined
    let watcher: fs.FSWatcher | undefined
    let settle: NodeJS.Timeout | undefined
    let wakeSentAt: number | undefined

    // Purpose: append one JSON log line to the summit log file (never to the TUI).
    const log = (level: string, fn: string, msg: string, data: Record<string, unknown> = {}) => {
        if (!armed) return
        const line = { t: new Date().toISOString(), level, pid: process.pid, c: `ext-${harness}`, fn, msg, ...data }
        try {
            fs.appendFileSync(armed.logFile, JSON.stringify(line) + '\n')
        } catch {
            // logging must never break the session
        }
    }

    // Purpose: put the notice into the session and start (or queue) a turn.
    const deliver = (notice: string) => {
        const message = { customType: 'harness-summit', content: notice, display: true }
        if (harness === 'omp' || !ctx.isIdle()) {
            api.sendMessage(message, { triggerTurn: true, deliverAs: 'followUp' })
            return log('info', 'deliver', 'followUp', { idle: harness === 'omp' ? null : false })
        }
        api.sendMessage(message, { triggerTurn: false })
        if (wakeSentAt !== undefined && Date.now() - wakeSentAt < WAKE_DEDUPE_MS)
            return log('info', 'deliver', 'deduped')
        wakeSentAt = Date.now()
        api.sendUserMessage(WAKE_TEXT, { deliverAs: 'steer' })
        log('info', 'deliver', 'parent-wake')
    }

    // Purpose: on a signal change, fetch the notice from the CLI and deliver it when non-empty.
    const onSignal = () => {
        if (settle) clearTimeout(settle)
        settle = setTimeout(async () => {
            if (!armed || !ctx) return
            try {
                const notice = (await runCli(['notice', '--host-key', armed.hostKey])).trim()
                if (notice !== '') deliver(notice)
                else log('debug', 'onSignal', 'nothing unread')
            } catch (err) {
                log('error', 'onSignal', 'notice failed', { error: err as ExtError })
            }
        }, SIGNAL_SETTLE_MS)
    }

    // Purpose: (re-)arm the signal file and its watcher for this process.
    const arm = async (event: string, c: any) => {
        if (c?.hasUI !== true) return
        ctx = c
        try {
            armed = parseArmed(await runCli(['hook', 'ext-arm', '--harness', harness, '--pid', String(process.pid)]))
            watcher?.close()
            watcher = fs.watch(armed.signalPath, onSignal)
            log('info', 'arm', 'watching', { event, signalPath: armed.signalPath })
        } catch (err) {
            log('error', 'arm', 'arm failed', { event, error: err as ExtError })
        }
    }

    api.on('session_start', (_e: unknown, c: any) => arm('session_start', c))
    if (harness === 'omp') api.on('session_switch', (_e: unknown, c: any) => arm('session_switch', c))
    api.on('session_shutdown', () => {
        watcher?.close()
        watcher = undefined
        log('info', 'shutdown', 'watcher closed')
    })
    api.on('agent_start', () => {
        wakeSentAt = undefined
        log('debug', 'agentStart', 'wake dedupe reset')
    })
}
