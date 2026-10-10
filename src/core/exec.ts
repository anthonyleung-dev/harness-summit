// The one door to external harness CLIs (codex, opencode, claude). Callers receive an Exec object so
// tests can inject a stub. With HARNESS_SUMMIT_EXEC_LOG=<file>, the default Exec records each command
// as a JSON line in that file and runs nothing (used by process-level tests and dry runs).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { summitError } from './errors.js'
import { log } from './log.js'

export interface ExecRequest {
    cmd: string
    args: string[]
    env?: NodeJS.ProcessEnv
}

export interface CaptureResult {
    // Exit code; -1 when the process was killed (timeout) or died by a signal.
    code: number
    stdout: string
    stderr: string
}

export interface Exec {
    // Run a process to completion (killed after `timeoutMs`) and capture its output.
    capture(req: ExecRequest, timeoutMs: number): Promise<CaptureResult>
}

// Env names that carry the absolute path of a harness CLI. Install writes them into every MCP
// registration, because a daemon-started MCP child may not have the shell PATH (REVIEW m10).
export const BIN_ENV = { codex: 'SUMMIT_CODEX_BIN', opencode: 'SUMMIT_OPENCODE_BIN' } as const
export type BinName = keyof typeof BIN_ENV

// Purpose: tell whether `file` exists and is executable by this process.
function isExecutable(file: string): boolean {
    try {
        fs.accessSync(file, fs.constants.X_OK)
        return true
    } catch {
        return false
    }
}

// Purpose: find an executable on PATH without running it; null when absent.
export function findOnPath(bin: string, envPath: string = process.env.PATH ?? ''): string | null {
    for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
        const p = path.join(dir, bin)
        if (isExecutable(p)) return p
    }
    return null
}

// Purpose: the command to start a harness CLI: the absolute path from its env name when it is set
// AND still executable, else the bare name (resolved on PATH at spawn time). A recorded path that is
// gone or not executable (the CLI moved after install: an nvm switch, a reinstall) falls back to
// PATH with a log line (F12).
export function cliBin(name: BinName, env: NodeJS.ProcessEnv = process.env): string {
    const fromEnv = env[BIN_ENV[name]]
    if (fromEnv === undefined || fromEnv.trim() === '') return name
    if (isExecutable(fromEnv)) return fromEnv
    log('warn', 'cliBin', 'recorded CLI path is not executable; using PATH', { name, recorded: fromEnv })
    return name
}

// Purpose: in record mode, append the command to the exec log and report true.
function recordIfDryRun(mode: string, req: ExecRequest): boolean {
    const file = process.env.HARNESS_SUMMIT_EXEC_LOG
    if (file === undefined || file === '') return false
    fs.appendFileSync(file, JSON.stringify({ mode, cmd: req.cmd, args: req.args }) + '\n')
    log('info', 'exec', 'recorded instead of run', { mode, cmd: req.cmd, args: req.args })
    return true
}

// Purpose: run a child to completion with a timeout and collect stdout/stderr.
async function capture(req: ExecRequest, timeoutMs: number): Promise<CaptureResult> {
    if (recordIfDryRun('capture', req)) return { code: 0, stdout: '', stderr: '' }
    return await new Promise<CaptureResult>((resolve, reject) => {
        const child = spawn(req.cmd, req.args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: req.env ?? process.env,
            timeout: timeoutMs,
        })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
        child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
        child.once('error', (err) =>
            reject(
                summitError(
                    'SUMMIT_EXEC_FAILED',
                    `cannot run ${req.cmd}: ${err.message}`,
                    'exec.capture',
                    { cmd: req.cmd, args: req.args },
                    err,
                ),
            ),
        )
        child.once('close', (code, signal) => {
            log('info', 'exec.capture', 'finished', { cmd: req.cmd, code, signal })
            resolve({ code: code ?? -1, stdout, stderr: signal ? `${stderr}\nkilled by ${signal}`.trim() : stderr })
        })
    })
}

export const defaultExec: Exec = { capture }
