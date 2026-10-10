// `harness-summit doctor`: report what is installed and whether the pieces are reachable. Read-only;
// never runs a harness CLI.
import fs from 'node:fs'
import path from 'node:path'

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
    const reg = registrationFor(home, h, await opencodeConfigPath(home))
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
    return `${h.padEnd(9)} registered=${registered ? 'yes' : 'no '} commands=${cmds}/${files.length} cli=${bin ?? 'not on PATH'}`
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
    for (const h of HARNESSES) lines.push(await harnessLine(home, h))
    log('debug', 'doctorReport', 'report built', { home })
    return lines
}
