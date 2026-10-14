// Where this checkout lives and how registrations start its CLI (SPEC §8: absolute node, absolute CLI).
import fs from 'node:fs'
import path from 'node:path'

import { summitError } from '../core/errors.js'
import { BIN_ENV, findOnPath, type BinName } from '../core/exec.js'
import { log } from '../core/log.js'
import { BUNDLE_FILE, packageRoot } from '../core/version.js'
import { mcpLaunch, type Launch } from './render.js'

// The plugin-root variable Claude Code expands in plugin hook and MCP server args.
const PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}'

// Purpose: absolute path of the built CLI (the esbuild bundle) inside the package root.
export function builtCli(): string {
    return path.join(packageRoot(), BUNDLE_FILE)
}

// Purpose: env for registrations: the absolute path of each harness CLI found on install's PATH, so
// a daemon-started MCP child can wake codex/opencode receivers without the shell PATH (REVIEW m10).
// A CLI that is not found is left out; the wake then falls back to PATH.
export function harnessBinEnv(envPath: string = process.env.PATH ?? ''): Record<string, string> {
    const env: Record<string, string> = {}
    for (const name of Object.keys(BIN_ENV) as BinName[]) {
        const bin = findOnPath(name, envPath)
        if (bin !== null) env[BIN_ENV[name]] = bin
    }
    log('info', 'harnessBinEnv', 'harness CLIs found', { env })
    return env
}

// Purpose: the launch used by installed registrations: this node binary + the built CLI + the
// harness CLI paths. Synchronous on purpose: renderExtension callers (and review scripts) use it inline.
export function installLaunch(): Launch {
    const cli = builtCli()
    if (!fs.existsSync(cli)) {
        throw summitError(
            'SUMMIT_INSTALL_CONFLICT',
            `built CLI missing at ${cli}; run npm run build first`,
            'installLaunch',
            { cli },
        )
    }
    return { node: process.execPath, cli, env: harnessBinEnv() }
}

// Purpose: the launch used by the repo's dev plugin (`claude --plugin-dir plugins/claude`). Dev only: it
// starts the bare name `node` from PATH and the CLI relative to the checkout; install never ships it
// (installed hooks and servers use absolute paths, installLaunch).
export function devPluginLaunch(): Launch {
    return { node: 'node', cli: `${PLUGIN_ROOT}/../../${BUNDLE_FILE}` }
}

// Purpose: the launch used by the public Claude plugin (repo-root `.claude-plugin/plugin.json`, shipped in
// the npm package). Claude Code fetches the package as an npm plugin source and copies it to its plugin
// cache, so the CLI sits at `${CLAUDE_PLUGIN_ROOT}/dist/cli.js` and `node` comes from PATH.
export function npmPluginLaunch(): Launch {
    return { node: 'node', cli: `${PLUGIN_ROOT}/${BUNDLE_FILE}` }
}

export const EXTENSION_SOURCE = path.join('adapters', 'pi-omp', 'harness-summit.ts')
export const HARNESS_MARKER = 'const INJECTED_HARNESS: string | null = null'
export const CLI_MARKER = 'const INJECTED_CLI: string[] | null = null'
export const MCP_MARKER = 'const INJECTED_MCP: McpLaunch | null = null'

// Purpose: the pi/OMP extension source with the harness, the absolute CLI launch and (pi) the MCP server
// launch substituted. pi registers the server from the extension (SPEC §3, §8).
export function renderExtension(harness: 'pi' | 'omp', launch: Launch): string {
    const file = path.join(packageRoot(), EXTENSION_SOURCE)
    const src = fs.readFileSync(file, 'utf8')
    if (!src.includes(HARNESS_MARKER) || !src.includes(CLI_MARKER) || !src.includes(MCP_MARKER)) {
        throw summitError('SUMMIT_INTERNAL', 'extension source lost its injection markers', 'renderExtension', { file })
    }
    return src
        .replace(HARNESS_MARKER, `const INJECTED_HARNESS: string | null = ${JSON.stringify(harness)}`)
        .replace(CLI_MARKER, `const INJECTED_CLI: string[] | null = ${JSON.stringify([launch.node, launch.cli])}`)
        .replace(
            MCP_MARKER,
            `const INJECTED_MCP: McpLaunch | null = ${harness === 'pi' ? JSON.stringify(mcpLaunch(launch, 'pi')) : 'null'}`,
        )
}
