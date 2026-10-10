// Per-harness install plans (SPEC §8): the list of actions install applies and uninstall reverses.
import os from 'node:os'
import path from 'node:path'

import type { ExecRequest } from '../core/exec.js'
import { SUMMIT_NAME, type Harness } from '../core/schemas.js'
import { TOOL_NAMES } from '../server/tools.js'
import type { Action } from './actions.js'
import { removeJsonKey, removeTomlBlock, setJsonKey, tomlBlock, upsertTomlBlock } from './edits.js'
import { renderExtension } from './launch.js'
import { mcpLaunch, renderClaudePlugin, renderCommands, renderMarketplace, type Launch } from './render.js'
import { dataDir } from './state.js'

export interface PlanInput {
    home: string
    launch: Launch
    // Path of the OpenCode global config (opencode.jsonc or opencode.json).
    opencodeConfig: string
}

// Registration key in every harness config, and the Claude plugin + marketplace name.
const SERVER_KEY = SUMMIT_NAME

// Purpose: where each harness keeps its command files (relative paths come from render.ts).
export function commandDirFor(home: string, harness: Harness): string {
    const dirs: Record<Harness, string> = {
        claude: path.join(dataDir(home), 'claude-marketplace', 'claude'),
        codex: path.join(home, '.codex', 'skills'),
        pi: path.join(home, '.pi', 'agent', 'prompts'),
        omp: path.join(home, '.omp', 'agent', 'commands'),
        opencode: path.join(home, '.config', 'opencode', 'commands'),
    }
    return dirs[harness]
}

// Purpose: the user config file that registers the MCP server, and the key path inside it.
export function registrationFor(
    home: string,
    harness: Exclude<Harness, 'claude'>,
    opencodeConfig: string,
): { file: string; keyPath: string[] } {
    switch (harness) {
        case 'codex':
            return { file: path.join(home, '.codex', 'config.toml'), keyPath: ['mcp_servers', SERVER_KEY] }
        case 'pi':
        case 'omp':
            return { file: path.join(home, `.${harness}`, 'agent', 'mcp.json'), keyPath: ['mcpServers', SERVER_KEY] }
        case 'opencode':
            return { file: opencodeConfig, keyPath: ['mcp', 'servers', SERVER_KEY] }
    }
}

// Purpose: env for external commands, pointed at the chosen home.
function execEnv(home: string): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home }
    if (path.resolve(home) !== path.resolve(os.homedir())) env.XDG_CONFIG_HOME = path.join(home, '.config')
    return env
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

// Purpose: Claude Code: generated plugin + marketplace in the data dir, then the two plugin commands.
function claudePlan(p: PlanInput): Action[] {
    const market = path.dirname(commandDirFor(p.home, 'claude'))
    const env = execEnv(p.home)
    // Purpose: one `claude` command run against the chosen home.
    const run = (args: string[]): ExecRequest => ({ cmd: 'claude', args, env })
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
            run: run(['plugin', 'install', `${SERVER_KEY}@${SERVER_KEY}`, '--scope', 'user']),
            undo: run(['plugin', 'uninstall', `${SERVER_KEY}@${SERVER_KEY}`]),
        },
    ]
}

// Purpose: Codex: TOML block in config.toml, skills in ~/.codex/skills.
function codexPlan(p: PlanInput): Action[] {
    const config = registrationFor(p.home, 'codex', p.opencodeConfig).file
    const block = tomlBlock(codexTables(p.launch))
    return [
        {
            kind: 'edit',
            path: config,
            what: `[mcp_servers.${SERVER_KEY}]`,
            apply: (t) => upsertTomlBlock(t, block, SERVER_KEY),
            revert: removeTomlBlock,
        },
        ...fileActions(commandDirFor(p.home, 'codex'), renderCommands('codex')),
    ]
}

// Purpose: pi or OMP: mcp.json key, the shared extension, command files.
function piLikePlan(p: PlanInput, harness: 'pi' | 'omp'): Action[] {
    const reg = registrationFor(p.home, harness, p.opencodeConfig)
    const server = { ...mcpLaunch(p.launch, harness), ...(harness === 'pi' ? { exposure: 'direct' } : {}) }
    return [
        jsonKeyEdit(reg.file, reg.keyPath, server),
        {
            kind: 'file',
            path: path.join(path.dirname(reg.file), 'extensions', 'harness-summit.ts'),
            content: renderExtension(harness, p.launch),
        },
        ...fileActions(commandDirFor(p.home, harness), renderCommands(harness)),
    ]
}

// Purpose: OpenCode: `opencode mcp add --global` (never a hand edit of the JSONC), command files. The
// command writes `mcp.servers.harness-summit` = `{ type: "local", command: [...], environment }` into
// the file opencodeConfigPath() names; each `--env K=V` becomes one `environment` key.
function opencodePlan(p: PlanInput): Action[] {
    const { command, args, env } = mcpLaunch(p.launch, 'opencode')
    const envFlags = Object.entries(env ?? {}).flatMap(([k, v]) => ['--env', `${k}=${v}`])
    const { keyPath } = registrationFor(p.home, 'opencode', p.opencodeConfig)
    return [
        {
            kind: 'edit',
            path: p.opencodeConfig,
            what: keyPath.join('.'),
            run: {
                cmd: 'opencode',
                args: ['mcp', 'add', '--global', ...envFlags, SERVER_KEY, '--', command, ...args],
                env: execEnv(p.home),
            },
            revert: (t, original) => removeJsonKey(t, keyPath, original, p.opencodeConfig),
        },
        ...fileActions(commandDirFor(p.home, 'opencode'), renderCommands('opencode')),
    ]
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
