// `harness-summit doctor`: report what is installed, whether the pieces are reachable, and (a `warn` line) each
// registration that starts another node or CLI than the one running. Read-only; never runs a harness CLI.
import fs from 'node:fs'
import path from 'node:path'

import { toSummitError } from '../core/errors.js'
import { findOnPath } from '../core/exec.js'
import { reinstallFix } from '../core/fixText.js'
import { pathExists, readTextFile } from '../core/fsx.js'
import { log } from '../core/log.js'
import { summitRoot } from '../core/paths.js'
import { HARNESSES, type Harness } from '../core/schemas.js'
import { opencodeConfigPath } from './install.js'
import { builtCli, installLaunch } from './launch.js'
import { commandDirFor, extensionFile, registrationFor } from './plan.js'
import { readLaunch, sameLaunch, type LaunchRead } from './registration.js'
import { CLAUDE_MCP_FILE, mcpLaunch, renderCommands, type Launch, type McpLaunch } from './render.js'
import { loadState } from './state.js'

// Purpose: the file that holds what a harness's MCP server registration starts: the Claude plugin's .mcp.json,
// the pi extension (it registers the server itself, SPEC §3), else the harness config (registrationFor).
async function launchFile(home: string, h: Harness): Promise<string> {
    if (h === 'claude') return path.join(commandDirFor(home, h), CLAUDE_MCP_FILE)
    if (h === 'pi') return extensionFile(home, h)
    return registrationFor(home, h, h === 'opencode' ? await opencodeConfigPath(home) : undefined).file
}

// Purpose: what the registration of a harness starts, and why it cannot be read (readLaunch). A missing or
// unopenable file is no registration.
async function registeredLaunch(home: string, h: Harness): Promise<LaunchRead & { file: string }> {
    const file = await launchFile(home, h)
    const text = await readTextFile(file).catch(() => null)
    return { file, ...(text === null ? { launch: null, problem: null } : readLaunch(h, text, file)) }
}

// Purpose: the warn line of a registration doctor cannot read, or null. The harness line says registered=no,
// because doctor cannot tell what it starts; this line says why.
function unreadableLine(h: Harness, found: LaunchRead & { file: string }): string | null {
    if (found.problem === null) return null
    return `warn      ${h} cannot read the registration in ${found.file}: ${found.problem}; fix the file, then ${reinstallFix(h)}`
}

// Purpose: the warn line of a registration that starts another node or CLI than `current` (the launch install
// would write now), or null. A warn, not a fail: the old CLI may still run, and only an install fixes it. The
// env (harness CLI paths found on PATH) is not compared: doctor's PATH need not be install's.
async function staleLine(h: Harness, found: McpLaunch | null, current: Launch | null): Promise<string | null> {
    if (found === null || current === null) return null
    const wanted = mcpLaunch(current, h)
    if (sameLaunch(found, wanted, false)) return null
    const cli = found.args[0] ?? ''
    const missing = (await pathExists(cli)) ? '' : ' (missing)'
    const starts = (l: McpLaunch) => `${l.command} ${l.args[0] ?? ''}`
    return `warn      ${h} registration is stale: it starts ${starts(found)}${missing}, this CLI is ${starts(wanted)}; ${reinstallFix(h)}`
}

// Purpose: the status line of one harness, then its warn line when its registration is unreadable or stale.
async function harnessLines(home: string, h: Harness, current: Launch | null): Promise<string[]> {
    const state = await loadState(home)
    const found = await registeredLaunch(home, h)
    const registered = h === 'claude' ? state.execs['claude-plugin'] === true : found.launch !== null
    const files = renderCommands(h)
    let cmds = 0
    for (const f of files) if (await pathExists(path.join(commandDirFor(home, h), f.rel))) cmds++
    const bin = findOnPath(h)
    let line = `${h.padEnd(9)} registered=${registered ? 'yes' : 'no '} commands=${cmds}/${files.length} cli=${bin ?? 'not on PATH'}`
    if (h === 'claude') line = `${line} ${claudeRoute(registered)}`
    // The config dir an env var can move (CODEX_HOME, XDG_CONFIG_HOME): show which one doctor checked.
    else if (h === 'codex' || h === 'opencode') line = `${line} dir=${path.dirname(commandDirFor(home, h))}`
    const warn = unreadableLine(h, found) ?? (await staleLine(h, found.launch, current))
    return warn === null ? [line] : [line, warn]
}

// Purpose: the launch install would write now, or null when the built CLI is missing (the cli line says so).
function currentLaunch(): Launch | null {
    try {
        return installLaunch()
    } catch (err) {
        log('debug', 'currentLaunch', 'no built CLI; stale check skipped', { error: String(err) })
        return null
    }
}

// Purpose: the status line of a harness whose paths cannot be resolved (a relative CODEX_HOME or
// XDG_CONFIG_HOME, homes.ts): doctor reports it on that harness's line and goes on with the others.
function errorLine(h: Harness, err: unknown): string {
    const e = toSummitError(err, 'harnessLine', { harness: h })
    log('warn', 'doctorReport', 'harness check failed', { harness: h, error: e.toJSON() })
    return `${h.padEnd(9)} error=${e.code}: ${e.message}`
}

// Purpose: which Claude route doctor can see. It sees only install's own record: the public plugin
// (/plugin install) lives in Claude Code's settings, and doctor runs no harness CLI to ask for them.
function claudeRoute(byInstall: boolean): string {
    return byInstall ? 'route=install' : 'route=unknown (doctor does not detect a /plugin install)'
}

// Purpose: build the doctor report. Read-only: it never creates the summit root.
export async function doctorReport(home: string): Promise<string[]> {
    const cli = builtCli()
    const root = summitRoot()
    const rootExists = await pathExists(root)
    let writable = 'no'
    try {
        fs.accessSync(rootExists ? root : path.dirname(root), fs.constants.W_OK)
        writable = rootExists ? 'yes' : 'yes (created on first join)'
    } catch {
        log('debug', 'doctorReport', 'summit root not writable', { root })
    }
    const lines = [
        `node      ${process.version} (${process.execPath})`,
        `cli       ${cli} ${(await pathExists(cli)) ? '(built)' : '(MISSING: run npm run build)'}`,
        `root      ${root} writable=${writable}`,
        `home      ${home}`,
    ]
    const current = currentLaunch()
    for (const h of HARNESSES) lines.push(...(await harnessLines(home, h, current).catch((err) => [errorLine(h, err)])))
    log('debug', 'doctorReport', 'report built', { home })
    return lines
}
