// `harness-summit doctor`: report what is installed and whether the pieces are reachable. Read-only;
// never runs a harness CLI.
import fs from 'node:fs'
import path from 'node:path'

import { toSummitError } from '../core/errors.js'
import { findOnPath } from '../core/exec.js'
import { pathExists, readTextFile } from '../core/fsx.js'
import { log } from '../core/log.js'
import { summitRoot } from '../core/paths.js'
import { HARNESSES, type Harness } from '../core/schemas.js'
import { getAt, parseJsonc, TOML_BEGIN } from './edits.js'
import { opencodeConfigPath } from './install.js'
import { builtCli } from './launch.js'
import { commandDirFor, registrationFor } from './plan.js'
import { renderCommands } from './render.js'
import { loadState } from './state.js'

// Purpose: tell whether a JSON/JSONC file has a key path (an unreadable file counts as no).
async function hasJsonKey(file: string, keyPath: string[]): Promise<boolean> {
    const text = await readTextFile(file).catch(() => null)
    if (text === null) return false
    try {
        return getAt(parseJsonc(text, file), keyPath) !== undefined
    } catch {
        log('warn', 'hasJsonKey', 'config does not parse', { file })
        return false
    }
}

// Purpose: tell whether the MCP server registration of a harness is present. pi registers the server from
// its extension (SPEC §3), so for pi that is the installed extension file.
async function isRegistered(home: string, h: Exclude<Harness, 'claude'>): Promise<boolean> {
    const reg = registrationFor(home, h, h === 'opencode' ? await opencodeConfigPath(home) : undefined)
    if (h === 'pi') return await pathExists(path.join(path.dirname(reg.file), 'extensions', 'harness-summit.ts'))
    if (h === 'codex') return ((await readTextFile(reg.file).catch(() => null)) ?? '').includes(TOML_BEGIN)
    return await hasJsonKey(reg.file, reg.keyPath)
}

// Purpose: one status line per harness.
async function harnessLine(home: string, h: Harness): Promise<string> {
    const state = await loadState(home)
    const registered = h === 'claude' ? state.execs['claude-plugin'] === true : await isRegistered(home, h)
    const files = renderCommands(h)
    let cmds = 0
    for (const f of files) if (await pathExists(path.join(commandDirFor(home, h), f.rel))) cmds++
    const bin = findOnPath(h)
    const line = `${h.padEnd(9)} registered=${registered ? 'yes' : 'no '} commands=${cmds}/${files.length} cli=${bin ?? 'not on PATH'}`
    if (h === 'claude') return `${line} ${claudeRoute(registered)}`
    // The config dir an env var can move (CODEX_HOME, XDG_CONFIG_HOME): show which one doctor checked.
    return h === 'codex' || h === 'opencode' ? `${line} dir=${path.dirname(commandDirFor(home, h))}` : line
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
    for (const h of HARNESSES) lines.push(await harnessLine(home, h).catch((err) => errorLine(h, err)))
    log('debug', 'doctorReport', 'report built', { home })
    return lines
}
