// Per-harness install plans (SPEC §8): the list of actions install applies and uninstall reverses.
import path from 'node:path'

import type { ExecRequest } from '../core/exec.js'
import { PLUGIN_ID } from '../core/fixText.js'
import { log } from '../core/log.js'
import { isInsideDir } from '../core/project.js'
import { staleOwned } from '../core/prune.js'
import { SUMMIT_NAME, type Harness } from '../core/schemas.js'
import { SUMMIT_VERSION } from '../core/version.js'
import { TOOL_NAMES } from '../server/tools.js'
import type { Action, SyncAction } from './actions.js'
import { removeJsonKey, removeTomlBlock, setJsonKey, tomlBlock, upsertTomlBlock } from './edits.js'
import { codexDir, execEnv, OPENCODE_CONFIG_FILES, opencodeDir } from './homes.js'
import { renderExtension } from './launch.js'
import {
    CODEX_CONFIG,
    CODEX_WHAT,
    configDirFor,
    MOVABLE,
    OPENCODE_KEY,
    retiredRegistrations,
    staleConfigDirs,
} from './movable.js'
import { CODEX_KEY, JSON_KEY, readLaunch, sameLaunch } from './registration.js'
import { mcpLaunch, renderClaudePlugin, renderCommands, renderMarketplace, type Launch } from './render.js'
import { dataDir, type InstallState } from './state.js'

export interface PlanInput {
    home: string
    launch: Launch
    // The OpenCode global config (install.ts opencodeConfigPath), looked up only when OpenCode is planned.
    opencodeConfig?: string
}

// Registration key in every harness config, and the Claude plugin + marketplace name.
const SERVER_KEY = SUMMIT_NAME

// Purpose: where each harness keeps its command files (relative paths come from render.ts). A switch, so
// only the requested harness's dir is resolved.
export function commandDirFor(home: string, harness: Harness): string {
    switch (harness) {
        case 'claude':
            return path.join(dataDir(home), 'claude-marketplace', 'claude')
        case 'pi':
            return path.join(home, '.pi', 'agent', 'prompts')
        case 'omp':
            return path.join(home, '.omp', 'agent', 'commands')
        case 'codex':
        case 'opencode':
            return path.join(configDirFor(home, harness), MOVABLE[harness].commands)
    }
}

// Purpose: the user config file that registers the MCP server, and the key path inside it.
export function registrationFor(
    home: string,
    harness: Exclude<Harness, 'claude'>,
    opencodeConfig?: string,
): { file: string; keyPath: string[] } {
    switch (harness) {
        case 'codex':
            return { file: path.join(codexDir(home), CODEX_CONFIG), keyPath: CODEX_KEY }
        case 'pi':
        case 'omp':
            return { file: path.join(home, `.${harness}`, 'agent', 'mcp.json'), keyPath: JSON_KEY }
        case 'opencode':
            return {
                file: opencodeConfig ?? path.join(opencodeDir(home), ...OPENCODE_CONFIG_FILES[0]!),
                keyPath: OPENCODE_KEY,
            }
    }
}

// Purpose: the shared pi/OMP extension file install writes for one of them.
export function extensionFile(home: string, harness: 'pi' | 'omp'): string {
    return path.join(path.dirname(registrationFor(home, harness).file), 'extensions', 'harness-summit.ts')
}

// Purpose: owned-file actions for rendered files under one directory.
function fileActions(dir: string, files: { rel: string; content: string }[]): Action[] {
    return files.map((f) => ({ kind: 'file', path: path.join(dir, f.rel), content: f.content }))
}

// Purpose: the Codex TOML tables: server, its env (harness CLI paths) and one approval table per tool.
export function codexTables(launch: Launch): string {
    const { command, args, env } = mcpLaunch(launch, 'codex')
    const head = `[mcp_servers.${SERVER_KEY}]\ncommand = ${JSON.stringify(command)}\nargs = [${args.map((a) => JSON.stringify(a)).join(', ')}]\n`
    const envTable =
        env === undefined
            ? ''
            : `\n[mcp_servers.${SERVER_KEY}.env]\n` +
              Object.entries(env)
                  .map(([k, v]) => `${k} = ${JSON.stringify(v)}\n`)
                  .join('')
    const tools = TOOL_NAMES.map((t) => `\n[mcp_servers.${SERVER_KEY}.tools.${t}]\napproval_mode = "approve"\n`)
    return head + envTable + tools.join('')
}

// Purpose: an edit action that sets/removes one JSON key.
function jsonKeyEdit(file: string, keyPath: string[], value: unknown): Action {
    return {
        kind: 'edit',
        path: file,
        what: keyPath.join('.'),
        apply: (t) => setJsonKey(t, keyPath, value, file),
        revert: (t, original) => removeJsonKey(t, keyPath, original, file),
    }
}

// Purpose: the marketplace directory install writes for Claude Code (it holds the plugin in `claude/`).
export function claudeMarketDir(home: string): string {
    return path.dirname(commandDirFor(home, 'claude'))
}

// Purpose: one `claude` command run against the chosen home (the plan's commands and the install check).
export function claudeRequest(home: string, args: string[]): ExecRequest {
    return { cmd: 'claude', args, env: execEnv(home) }
}

// The exec ids of the Claude marketplace and plugin commands (claudePlan), in run order.
export const CLAUDE_EXECS = ['claude-marketplace', 'claude-plugin']

// What `claude plugin update` prints when the plugin was removed outside install (Claude Code 2.1.299, run in
// a temp home): after `/plugin uninstall` "Plugin "<name>" is not installed"; after `/plugin marketplace
// remove` (that also uninstalls the plugin) "Plugin "<name>" not found". sync.ts drops the records of what is
// gone, so the next install adds it again.
const CLAUDE_GONE: SyncAction['gone'] = [
    { match: `Plugin "${SERVER_KEY}" is not installed`, what: 'plugin', drop: ['claude-plugin'] },
    { match: `Plugin "${SERVER_KEY}" not found`, what: 'plugin and its marketplace', drop: CLAUDE_EXECS },
]

// Purpose: Claude Code: generated plugin + marketplace in the data dir, the two plugin commands, then the
// refresh of Claude's plugin copy after an upgrade (sync.ts).
function claudePlan(p: PlanInput): Action[] {
    const market = claudeMarketDir(p.home)
    const run = (args: string[]): ExecRequest => claudeRequest(p.home, args)
    return [
        ...fileActions(market, [renderMarketplace()]),
        ...fileActions(path.join(market, 'claude'), renderClaudePlugin(p.launch)),
        {
            kind: 'exec',
            id: 'claude-marketplace',
            run: run(['plugin', 'marketplace', 'add', market]),
            undo: run(['plugin', 'marketplace', 'remove', SERVER_KEY]),
        },
        {
            kind: 'exec',
            id: 'claude-plugin',
            run: run(['plugin', 'install', PLUGIN_ID, '--scope', 'user']),
            undo: run(['plugin', 'uninstall', PLUGIN_ID]),
        },
        {
            kind: 'sync',
            id: 'claude-plugin-update',
            after: 'claude-plugin',
            watch: market,
            version: SUMMIT_VERSION,
            run: run(['plugin', 'update', PLUGIN_ID, '--scope', 'user']),
            gone: CLAUDE_GONE,
        },
    ]
}

// Purpose: Codex: TOML block in config.toml, skills in skills/, both in the Codex home (codexDir).
function codexPlan(p: PlanInput): Action[] {
    const config = registrationFor(p.home, 'codex').file
    const block = tomlBlock(codexTables(p.launch))
    return [
        {
            kind: 'edit',
            path: config,
            what: CODEX_WHAT,
            apply: (t) => upsertTomlBlock(t, block, SERVER_KEY),
            revert: removeTomlBlock,
        },
        ...fileActions(commandDirFor(p.home, 'codex'), renderCommands('codex')),
    ]
}

// Purpose: pi or OMP: the server registration, the shared extension, command files. OMP: an mcp.json key.
// pi: no mcp.json key, because the extension registers the server itself with the session id in its env
// (SPEC §3); an mcp.json entry of the same name would win, so the one an older install wrote is retired.
function piLikePlan(p: PlanInput, harness: 'pi' | 'omp'): Action[] {
    const reg = registrationFor(p.home, harness)
    const registration: Action =
        harness === 'pi'
            ? {
                  kind: 'retire',
                  path: reg.file,
                  what: reg.keyPath.join('.'),
                  revert: (t, original) => removeJsonKey(t, reg.keyPath, original, reg.file),
              }
            : jsonKeyEdit(reg.file, reg.keyPath, mcpLaunch(p.launch, harness))
    return [
        registration,
        { kind: 'file', path: extensionFile(p.home, harness), content: renderExtension(harness, p.launch) },
        ...fileActions(commandDirFor(p.home, harness), renderCommands(harness)),
    ]
}

// Purpose: OpenCode: `opencode mcp add --global` (never a hand edit of the JSONC), command files. The
// command writes `mcp.servers.harness-summit` = `{ type: "local", command: [...], environment }` into
// the file opencodeConfigPath() names; each `--env K=V` becomes one `environment` key. The command cannot be
// previewed, so `holds` tells whether the file already starts this launch (else a re-install runs it again).
function opencodePlan(p: PlanInput): Action[] {
    const wanted = mcpLaunch(p.launch, 'opencode')
    const { command, args, env } = wanted
    const envFlags = Object.entries(env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`])
    const { file, keyPath } = registrationFor(p.home, 'opencode', p.opencodeConfig)
    return [
        {
            kind: 'edit',
            path: file,
            what: keyPath.join('.'),
            run: {
                cmd: 'opencode',
                args: ['mcp', 'add', '--global', ...envFlags, SERVER_KEY, '--', command, ...args],
                env: execEnv(p.home),
            },
            holds: (t) => sameLaunch(readLaunch('opencode', t, file), wanted, true),
            revert: (t, original) => removeJsonKey(t, keyPath, original, file),
        },
        ...fileActions(commandDirFor(p.home, 'opencode'), renderCommands('opencode')),
    ]
}

// Purpose: the directories under which install owns every file it records for one harness (what a later
// release may stop rendering). Only recorded files there are ever pruned, so a user's own file is safe.
export function ownedDirsFor(home: string, harness: Harness): string[] {
    if (harness === 'claude') return [claudeMarketDir(home)]
    if (harness === 'pi' || harness === 'omp')
        return [commandDirFor(home, harness), path.dirname(extensionFile(home, harness))]
    return [commandDirFor(home, harness)]
}

// Purpose: actions that clean up what an earlier install left for one harness and `planned` no longer
// writes: prune each file the state records under its owned dirs (staleOwned, the rule gen-plugin shares);
// for Codex and OpenCode also the command dir and the registration in a config dir that is no longer current
// (retired, so install and uninstall both undo it when the state records it).
export function prunePlan(harness: Harness, p: PlanInput, state: InstallState, planned: Action[]): Action[] {
    const movable = harness === 'codex' || harness === 'opencode' ? harness : null
    const stale = movable === null ? [] : staleConfigDirs(p.home, movable, state)
    const dirs = [...ownedDirsFor(p.home, harness), ...stale.map((d) => path.join(d, MOVABLE[movable!].commands))]
    const owned = Object.keys(state.files).filter((f) => dirs.some((d) => isInsideDir(f, d)))
    const produced = planned.flatMap((a) => (a.kind === 'file' ? [a.path] : []))
    const retired = movable === null ? [] : stale.flatMap((d) => retiredRegistrations(movable, d))
    if (stale.length > 0) log('info', 'prunePlan', 'config dir changed', { home: p.home, harness, stale })
    return [...staleOwned(owned, produced).map((f): Action => ({ kind: 'prune', path: f })), ...retired]
}

// Purpose: the actions for one harness.
export function planFor(harness: Harness, p: PlanInput): Action[] {
    switch (harness) {
        case 'claude':
            return claudePlan(p)
        case 'codex':
            return codexPlan(p)
        case 'pi':
        case 'omp':
            return piLikePlan(p, harness)
        case 'opencode':
            return opencodePlan(p)
    }
}
