// `harness-summit` CLI (SPEC §8): mcp, hook, notice, install, uninstall, doctor (+ gen-plugin, build
// step). Only this module writes to stdout/stderr outside the MCP transport.
import fs from 'node:fs'
import path from 'node:path'

import { summitError, toSummitError } from '../core/errors.js'
import { configureLog, log } from '../core/log.js'
import { noticeForHostKey } from '../core/notice.js'
import { summitRoot } from '../core/paths.js'
import { doctorReport } from '../install/doctor.js'
import { runInstall, runUninstall } from '../install/install.js'
import { devPluginLaunch, repoRoot } from '../install/launch.js'
import { renderClaudePlugin } from '../install/render.js'
import { runMcpServer } from '../server/server.js'
import { logsToFile, parseCliArgs, parseHarness, parseHarnessList, parsePid, type CliArgs } from './args.js'
import { claudeFileChanged, claudeSessionStart, extArm, type HookResult } from './hooks.js'

const USAGE = `usage: harness-summit <command>
  mcp --harness <claude|codex|pi|omp|opencode>   run the MCP stdio server
  hook claude-session-start                      Claude Code SessionStart hook (stdin JSON)
  hook claude-file-changed                       Claude Code FileChanged hook (stdin JSON)
  hook ext-arm --harness <pi|omp> --pid <pid>    arm the pi/OMP extension's signal file
  notice --host-key <key>                        print the unread notice (empty when none)
  install --harness <list|all> [--dry-run] [--home <dir>]
  uninstall --harness <list|all> [--dry-run] [--home <dir>]
  doctor [--home <dir>]`

// Purpose: read all of stdin as text.
async function readStdin(): Promise<string> {
    const chunks: Buffer[] = []
    for await (const c of process.stdin) chunks.push(c as Buffer)
    return Buffer.concat(chunks).toString('utf8')
}

// Purpose: print a hook result and set the exit code.
function emit(r: HookResult): void {
    if (r.stdout) process.stdout.write(r.stdout)
    if (r.stderr) process.stderr.write(r.stderr)
    process.exitCode = r.exitCode
}

// Purpose: write the repo's dev plugin (plugins/claude) from the templates.
function genPlugin(): string[] {
    const dir = path.join(repoRoot(), 'plugins', 'claude')
    return renderClaudePlugin(devPluginLaunch()).map((f) => {
        const file = path.join(dir, f.rel)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, f.content)
        return `write   ${file}`
    })
}

// Purpose: run the `hook` sub-commands.
async function runHook(args: CliArgs): Promise<void> {
    const he = { root: summitRoot(), env: process.env, ppid: process.ppid }
    if (args.sub === 'claude-session-start') return emit(await claudeSessionStart(await readStdin(), he))
    if (args.sub === 'claude-file-changed') return emit(await claudeFileChanged(await readStdin(), he))
    if (args.sub === 'ext-arm') {
        const harness = parseHarness(args.harness, 'runHook')
        if (harness !== 'pi' && harness !== 'omp')
            throw summitError('SUMMIT_BAD_INPUT', 'ext-arm is for pi or omp', 'runHook', { harness })
        return emit(await extArm(harness, parsePid(args.pid), he.root))
    }
    throw summitError('SUMMIT_BAD_INPUT', `unknown hook ${args.sub}`, 'runHook', { sub: args.sub })
}

// Purpose: print the notice for one host key (empty output when nothing is unread).
async function runNotice(args: CliArgs): Promise<void> {
    if (args.hostKey === undefined || args.hostKey === '') {
        throw summitError('SUMMIT_BAD_INPUT', 'notice needs --host-key <key>', 'runNotice', {})
    }
    const notice = await noticeForHostKey(summitRoot(), args.hostKey)
    if (notice !== null) process.stdout.write(notice + '\n')
}

// Purpose: run install or uninstall and print the report.
async function runInstallCmd(args: CliArgs): Promise<void> {
    const opts = { harnesses: parseHarnessList(args.harness), home: args.home, dryRun: args.dryRun }
    const lines = args.cmd === 'install' ? await runInstall(opts) : await runUninstall(opts)
    process.stdout.write((opts.dryRun ? ['(dry run: nothing written)', ...lines] : lines).join('\n') + '\n')
}

// Purpose: dispatch one command line. Returns when done; the MCP server keeps the process alive.
// File logging starts only after the arguments parsed and only for commands that own the summit root.
export async function main(argv: string[]): Promise<void> {
    configureLog({ file: false })
    const args = parseCliArgs(argv)
    configureLog({ component: args.cmd ?? 'cli', file: logsToFile(args) })
    log('debug', 'main', 'command', { cmd: args.cmd, sub: args.sub })
    if (args.help || args.cmd === undefined) {
        process.stdout.write(USAGE + '\n')
        return
    }
    switch (args.cmd) {
        case 'mcp':
            return await runMcpServer(parseHarness(args.harness, 'main'))
        case 'hook':
            return await runHook(args)
        case 'notice':
            return await runNotice(args)
        case 'install':
        case 'uninstall':
            return await runInstallCmd(args)
        case 'doctor':
            process.stdout.write((await doctorReport(args.home)).join('\n') + '\n')
            return
        case 'gen-plugin':
            process.stdout.write(genPlugin().join('\n') + '\n')
            return
        default:
            throw summitError('SUMMIT_BAD_INPUT', `unknown command ${args.cmd}`, 'main', { cmd: args.cmd })
    }
}

// Purpose: CLI entry: run main, print a structured error on failure.
export async function cli(argv: string[]): Promise<void> {
    try {
        await main(argv)
    } catch (err) {
        const e = toSummitError(err, 'cli', { argv })
        log('error', 'cli', 'command failed', { error: e.toJSON() })
        process.stderr.write(JSON.stringify({ error: e.toJSON() }) + '\n')
        process.exitCode = 1
    }
}
