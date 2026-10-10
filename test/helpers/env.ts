// Shared test helpers: temp dirs, an in-process CallContext, a recording Exec stub, live pids.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vi } from 'vitest'

import type { CaptureResult, Exec, ExecRequest } from '../../src/core/exec.js'
import type { RequestMeta } from '../../src/core/hostKey.js'
import { sleep } from '../../src/core/lock.js'
import { parseStat } from '../../src/core/proc.js'
import type { Harness } from '../../src/core/schemas.js'
import type { CallContext } from '../../src/flows/context.js'

export const REPO = path.resolve(import.meta.dirname, '..', '..')
export const CLI = path.join(REPO, 'dist', 'cli.js')

// Purpose: a fresh temp dir under the OS temp dir.
export function tmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), `hs-${prefix}-`))
}

// Purpose: a fresh summit root, also exported as HARNESS_SUMMIT_HOME for code that reads the env.
export function tmpRoot(): string {
    const root = tmpDir('root')
    process.env.HARNESS_SUMMIT_HOME = root
    return root
}

export interface RecordingExec extends Exec {
    calls: { req: ExecRequest; timeoutMs: number }[]
}

// Purpose: an Exec stub that records every request and runs nothing. `capture` answers with `reply`
// after `delayMs` (a slow `codex queue`); with `fail`, it rejects as a spawn failure would.
export function recordingExec(
    reply: CaptureResult = { code: 0, stdout: '', stderr: '' },
    fail = false,
    delayMs = 0,
): RecordingExec {
    const calls: RecordingExec['calls'] = []
    return {
        calls,
        async capture(req, timeoutMs) {
            calls.push({ req, timeoutMs })
            if (delayMs > 0) await sleep(delayMs)
            if (fail) throw new Error('spawn failed (stub)')
            return reply
        },
    }
}

const sleepers: ChildProcess[] = []
process.once('exit', () => sleepers.forEach((c) => c.kill('SIGKILL')))

// Purpose: the pid of a fresh live process (a `sleep`), killed when the test process exits. Agents
// need live, distinct host pids for liveness rules (name takeover, stale host records).
export function livePid(): number {
    const child = spawn('sleep', ['600'], { stdio: 'ignore' })
    sleepers.push(child)
    if (child.pid === undefined) throw new Error('cannot start sleep')
    return child.pid
}

// Purpose: kill a process started by livePid() and wait until it is reaped (no zombie left).
export async function killLivePid(pid: number): Promise<void> {
    const child = sleepers.find((c) => c.pid === pid)
    if (child === undefined) throw new Error(`pid ${pid} was not started by livePid()`)
    const exited = new Promise((r) => child.once('exit', r))
    child.kill('SIGKILL')
    await exited
}

// Purpose: the pid of a zombie (exited, never reaped): `sh` starts `sleep 0` in the background and
// becomes `sleep 600`, which never waits for it. Resolves once /proc shows state Z. The parent is
// killed when the test process exits, and init reaps the zombie then.
export async function zombiePid(): Promise<number> {
    const parent = spawn('sh', ['-c', 'sleep 0 & echo $!; exec sleep 600'], { stdio: ['ignore', 'pipe', 'ignore'] })
    sleepers.push(parent)
    const pid = Number(await new Promise<string>((r) => parent.stdout?.once('data', (d) => r(String(d).trim()))))
    await until(() => parseStat(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'))?.state === 'Z')
    return pid
}

// Purpose: an fs error with an errno code, as Node throws it.
export function errno(code: string): Error {
    return Object.assign(new Error(code), { code })
}

// Purpose: make the /proc reads under `prefix` fail with `code` (other files read normally). Every
// /proc read failing with ENOENT is a process without /proc (DELTA-REVIEW-3 E2). Undo with
// vi.restoreAllMocks().
export function failProcReads(code: string, prefix = '/proc/'): void {
    const real = fs.readFileSync
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...rest: never[]) => {
        if (String(file).startsWith(prefix)) throw errno(code)
        return (real as (...a: unknown[]) => unknown)(file, ...rest)
    }) as typeof fs.readFileSync)
}

// Purpose: a pid that named a process that has exited and been reaped (a dead host).
export async function deadPid(): Promise<number> {
    const child = spawn('true', [], { stdio: 'ignore' })
    const pid = child.pid
    if (pid === undefined) throw new Error('cannot start true')
    await new Promise((r) => child.once('exit', r))
    return pid
}

// Purpose: an executable shell script `name` in `dir` with `body` (a fake harness CLI); returns its path.
export function fakeBin(dir: string, name: string, body = 'exit 0'): string {
    const bin = path.join(dir, name)
    fs.writeFileSync(bin, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return bin
}

// Purpose: wait until `cond` holds, polling every 50 ms (timeout throws).
export async function until(cond: () => boolean, ms = 8000): Promise<void> {
    const end = Date.now() + ms
    while (!cond()) {
        if (Date.now() > end) throw new Error('timed out')
        await sleep(50)
    }
}

// Purpose: an in-process CallContext for one simulated caller.
export function callFor(
    root: string,
    harness: Harness,
    opts: { ppid?: number; meta?: RequestMeta; exec?: Exec } = {},
): CallContext {
    return {
        root,
        harness,
        meta: opts.meta,
        ppid: opts.ppid ?? livePid(),
        pid: process.pid,
        exec: opts.exec ?? recordingExec(),
    }
}

// Purpose: Codex-style `_meta` for one thread.
export function codexMeta(threadId: string, cwd?: string): RequestMeta {
    return {
        threadId,
        'x-codex-turn-metadata': {
            thread_id: threadId,
            ...(cwd ? { workspaces: { [cwd]: { has_changes: false } } } : {}),
        },
        progressToken: 1,
    }
}

// Purpose: OpenCode-style `_meta` for one session.
export function opencodeMeta(sessionID: string): RequestMeta {
    return { 'ai.opencode/sessionID': sessionID, progressToken: 1 }
}

export interface CliRun {
    code: number | null
    stdout: string
    stderr: string
}

// Purpose: command + argv that start the built CLI; with `viaShell`, through
// `sh -c '<node> <cli> ...; exit $?'` so the CLI's parent is that shell (not the test runner).
export function cliCommand(args: string[], viaShell = false): [string, string[]] {
    const argv = [CLI, ...args]
    if (!viaShell) return [process.execPath, argv]
    return ['sh', ['-c', `"${process.execPath}" ${argv.map((a) => `"${a}"`).join(' ')}; exit $?`]]
}

// Purpose: run the built CLI once with stdin and env; `viaShell` puts `sh` between us and node so the
// CLI's ppid is that shell's pid (returned as `shellPid`).
export async function runCli(
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; stdin?: string; viaShell?: boolean } = {},
): Promise<CliRun & { shellPid?: number }> {
    const [cmd, argv] = cliCommand(args, opts.viaShell)
    const child = spawn(cmd, argv, { env: { ...process.env, ...opts.env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.stdin.end(opts.stdin ?? '')
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
    return { code, stdout, stderr, ...(opts.viaShell ? { shellPid: child.pid } : {}) }
}

export const FIXTURE_HOME = path.join(REPO, 'test', 'fixtures', 'home')

// Purpose: copy the seeded fixture home into a fresh temp home.
export function seededHome(): string {
    const home = tmpDir('home')
    fs.cpSync(FIXTURE_HOME, home, { recursive: true })
    return home
}

// Purpose: every file (path -> content) and directory under `dir`, for byte-exact comparisons.
export function snapshot(dir: string): { files: Record<string, string>; dirs: string[] } {
    const files: Record<string, string> = {}
    const dirs: string[] = []
    const walk = (d: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, e.name)
            const rel = path.relative(dir, p)
            if (e.isDirectory()) {
                dirs.push(rel)
                walk(p)
            } else files[rel] = fs.readFileSync(p, 'utf8')
        }
    }
    walk(dir)
    return { files, dirs: dirs.sort() }
}

// Purpose: one message record with fixed defaults, overridable per test.
export function sampleRecord(over: Record<string, string> = {}) {
    return {
        id: '11111111-1111-4111-8111-111111111111',
        from: 'alice',
        fromId: '22222222-2222-4222-8222-222222222222',
        to: 'bob',
        at: '2026-10-10T00:00:00.000Z',
        body: 'hello',
        ...over,
    }
}

// Purpose: the error code a promise rejects with ('NO ERROR' when it resolves).
export function errorCode(p: Promise<unknown>): Promise<string | undefined> {
    return p.then(
        () => 'NO ERROR',
        (e: { code?: string }) => e.code,
    )
}
