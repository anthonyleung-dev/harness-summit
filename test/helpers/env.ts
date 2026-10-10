// Shared test helpers: temp dirs, an in-process CallContext, a recording Exec stub, fake host pids, fake
// CLIs and a Node parent process. Portable: no shell, no POSIX-only program, no procfs read (XPLAT-AUDIT B6).
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import type { CaptureResult, Exec, ExecRequest } from '../../src/core/exec.js'
import { sleep } from '../../src/core/freshness.js'
import { usesSessionFile, type RequestMeta } from '../../src/core/hostKey.js'
import type { Harness } from '../../src/core/schemas.js'
import { writeSessionSync } from '../../src/core/sessions.js'
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

// Host pids of in-process callers. Identity comes from session ids and liveness from heartbeats (SPEC §3,
// §7), so a host pid only has to be distinct: no process runs behind it.
let nextFakePid = 4_100_000

// Purpose: a fresh, distinct host pid for one simulated caller.
export function fakePid(): number {
    return nextFakePid++
}

// Purpose: an fs error with an errno code, as Node throws it.
export function errno(code: string): Error {
    return Object.assign(new Error(code), { code })
}

// Purpose: a fake harness CLI `name` in `dir` that runs the JavaScript `body` under this node binary, and
// return the path to start it by. POSIX: an executable file with an absolute node shebang. Windows: a
// `.js` file plus a `name.cmd` shim of the npm shape (`"<node>" "<script>" %*`), so the spawn door's
// cmd.exe path runs for real. `body` sees the arguments in process.argv.slice(2).
export function fakeBin(dir: string, name: string, body = 'process.exit(0)'): string {
    if (process.platform !== 'win32') {
        const bin = path.join(dir, name)
        fs.writeFileSync(bin, `#!${process.execPath}\n${body}\n`, { mode: 0o755 })
        return bin
    }
    const script = path.join(dir, `${name}.js`)
    fs.writeFileSync(script, `${body}\n`)
    const bin = path.join(dir, `${name}.cmd`)
    fs.writeFileSync(bin, `@"${process.execPath}" "${script}" %*\r\n`)
    return bin
}

// Purpose: wait until `cond` (sync or async) holds, polling every 50 ms (timeout throws).
export async function until(cond: () => boolean | Promise<boolean>, ms = 8000): Promise<void> {
    const end = Date.now() + ms
    while (!(await cond())) {
        if (Date.now() > end) throw new Error('timed out')
        await sleep(50)
    }
}

// What a simulated caller runs in: its harness session (claude/pi/omp; default: a fresh one), its host
// pid (default: a fresh fake pid), `_meta` (codex/opencode) and the Exec stub.
export interface CallerOptions {
    session?: string
    hostPid?: number
    meta?: RequestMeta
    exec?: Exec
}

// Purpose: an in-process CallContext for one simulated caller. For claude and omp it records the
// session in the host's session file (as the SessionStart hook or the OMP extension does); for pi it is
// the server env. Two calls with the same session and different host pids are one session resumed in a
// new process.
export function callFor(root: string, harness: Harness, opts: CallerOptions = {}): CallContext {
    const hostPid = opts.hostPid ?? fakePid()
    const session = opts.session ?? randomUUID()
    if (usesSessionFile(harness)) writeSessionSync(root, harness, hostPid, session)
    return {
        root,
        harness,
        meta: opts.meta,
        hostPid,
        pid: process.pid,
        sessionEnv: harness === 'pi' ? session : undefined,
        // The simulated server started just now (its host's session file was written just before).
        startedAt: Date.now(),
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

// A Node script that starts its arguments as a child with stdio inherited, forwards SIGTERM and SIGINT
// and exits with the child's code. Started in front of the CLI, it gives the CLI a parent pid of its own
// (the host pid of a pid-keyed server or hook) on every OS, without a shell.
const PARENT_JS = [
    "const { spawn } = require('node:child_process')",
    'const [cmd, ...args] = process.argv.slice(1)',
    "const child = spawn(cmd, args, { stdio: 'inherit' })",
    "for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => child.kill(s))",
    "child.on('exit', (code) => process.exit(code ?? 1))",
].join('\n')

// Purpose: command + argv that start the built CLI; with `viaParent`, through PARENT_JS so the CLI's
// parent is that Node process (not the test runner).
export function cliCommand(args: string[], viaParent = false): [string, string[]] {
    const argv = [CLI, ...args]
    if (!viaParent) return [process.execPath, argv]
    return [process.execPath, ['-e', PARENT_JS, process.execPath, ...argv]]
}

// Purpose: run the built CLI once with stdin and env; `viaParent` puts a Node parent between us and the
// CLI, so the CLI's ppid is that parent's pid (returned as `parentPid`).
export async function runCli(
    args: string[],
    opts: { env?: NodeJS.ProcessEnv; stdin?: string; viaParent?: boolean } = {},
): Promise<CliRun & { parentPid?: number }> {
    const [cmd, argv] = cliCommand(args, opts.viaParent)
    const child = spawn(cmd, argv, { env: { ...process.env, ...opts.env } })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()))
    child.stdin.end(opts.stdin ?? '')
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
    return { code, stdout, stderr, ...(opts.viaParent ? { parentPid: child.pid } : {}) }
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
            // One separator on every OS, so tests compare with `.codex/config.toml`-style keys.
            const rel = path.relative(dir, p).split(path.sep).join('/')
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
