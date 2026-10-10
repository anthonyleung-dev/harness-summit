// The one door to external CLIs (codex, opencode, claude, git). Callers receive an Exec object so tests
// can inject a stub. With HARNESS_SUMMIT_EXEC_LOG=<file>, the default Exec records each command as a
// JSON line in that file and runs nothing (used by process-level tests and dry runs).
//
// Every OS (XPLAT-AUDIT D12-D14): a bare name is looked up on PATH here, not by libuv, because libuv's
// Windows search tries only `.com` and `.exe`. On Windows the lookup tries each PATHEXT extension, and
// "executable" means "an existing file whose extension is in PATHEXT" (X_OK means nothing there). A
// `.cmd` or `.bat` file (an npm shim) runs through `cmd.exe /d /s /c` with the line from
// src/core/winCmd.ts; everything else (an `.exe`, a POSIX executable) is spawned directly, with no shell.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { summitError } from './errors.js'
import { log } from './log.js'
import { cmdArgs, isBatchFile } from './winCmd.js'

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

// The PATHEXT list of Windows, upper case (Windows' default when the variable is unset).
function pathExts(env: NodeJS.ProcessEnv): string[] {
    const raw = env.PATHEXT ?? env.Pathext ?? '.COM;.EXE;.BAT;.CMD'
    return raw
        .split(';')
        .map((e) => e.trim().toUpperCase())
        .filter((e) => e.startsWith('.'))
}

// Purpose: tell whether `file` is an existing file this process can execute: on Windows, a file whose
// extension is in PATHEXT; elsewhere, a file with the execute bit for this process.
export function isExecutable(
    file: string,
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    try {
        if (!fs.statSync(file).isFile()) return false
        if (platform === 'win32') return pathExts(env).includes(path.extname(file).toUpperCase())
        fs.accessSync(file, fs.constants.X_OK)
        return true
    } catch {
        return false
    }
}

// Purpose: the files to try for one command name in one place: on Windows the name itself when it
// already has a PATHEXT extension, else the name plus each extension; elsewhere the name.
function candidates(base: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
    if (platform !== 'win32') return [base]
    const exts = pathExts(env)
    return exts.includes(path.extname(base).toUpperCase()) ? [base] : exts.map((e) => base + e.toLowerCase())
}

// Purpose: find an executable on PATH without running it; null when absent. On Windows each PATHEXT
// extension is tried in order (`codex` finds `codex.cmd`, `opencode` finds `opencode.exe`).
export function findOnPath(
    bin: string,
    envPath: string = process.env.PATH ?? '',
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
): string | null {
    const delimiter = platform === 'win32' ? ';' : ':'
    for (const dir of envPath.split(delimiter).filter(Boolean)) {
        for (const file of candidates(path.join(dir, bin), platform, env))
            if (isExecutable(file, platform, env)) return file
    }
    return null
}

// Purpose: the file to spawn for `cmd`: a path (it holds a separator) is used as it is, or with a PATHEXT
// extension on Windows; a bare name is looked up on the PATH of `env`. Null when nothing executable
// is found (the spawn then fails with ENOENT, a structured SUMMIT_EXEC_FAILED).
export function resolveCommand(
    cmd: string,
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): string | null {
    const isPath = cmd.includes('/') || (platform === 'win32' && cmd.includes('\\'))
    if (!isPath) return findOnPath(cmd, env.PATH ?? env.Path ?? '', platform, env)
    return candidates(cmd, platform, env).find((f) => isExecutable(f, platform, env)) ?? null
}

// How the door starts one command: the file, its argv, and whether Node must pass the argv unchanged
// (the cmd.exe line is already quoted).
export interface SpawnPlan {
    file: string
    args: string[]
    verbatim: boolean
}

// Purpose: the one spawn plan (XPLAT-AUDIT B4): resolve `cmd`; on Windows run a `.cmd`/`.bat` file through
// `cmd.exe /d /s /c` with safely quoted arguments, and spawn anything else directly. Never a shell for
// anything but a batch file.
export function spawnPlan(
    cmd: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
    platform: NodeJS.Platform = process.platform,
): SpawnPlan {
    const file = resolveCommand(cmd, env, platform) ?? cmd
    if (platform === 'win32' && isBatchFile(file)) {
        const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe'
        return { file: comspec, args: cmdArgs(file, args), verbatim: true }
    }
    return { file, args, verbatim: false }
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
    const env = req.env ?? process.env
    const plan = spawnPlan(req.cmd, req.args, env)
    return await new Promise<CaptureResult>((resolve, reject) => {
        const child = spawn(plan.file, plan.args, {
            stdio: ['ignore', 'pipe', 'pipe'],
            env,
            timeout: timeoutMs,
            windowsHide: true,
            windowsVerbatimArguments: plan.verbatim,
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

// Purpose: run a short command synchronously through the same spawn plan and return its stdout, or null
// when it fails (spawn error, non-zero exit, timeout). Used where a caller must stay synchronous
// (`git rev-parse` in src/core/project.ts).
export function captureSync(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }): string | null {
    const plan = spawnPlan(cmd, args)
    const res = spawnSync(plan.file, plan.args, {
        cwd: opts.cwd,
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: opts.timeoutMs,
        windowsHide: true,
        windowsVerbatimArguments: plan.verbatim,
        encoding: 'utf8',
    })
    if (res.error !== undefined || res.status !== 0) {
        log('debug', 'captureSync', 'command failed', { cmd, status: res.status, error: String(res.error ?? '') })
        return null
    }
    return res.stdout
}

export const defaultExec: Exec = { capture }
