// Where this checkout lives and how registrations start its CLI (SPEC §8: absolute node, absolute CLI).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { summitError } from '../core/errors.js'
import { BIN_ENV, findOnPath, type BinName } from '../core/exec.js'
import { log } from '../core/log.js'
import { mcpLaunch, type Launch } from './render.js'

// Purpose: repo root, found from this module (src/install or dist/install → two levels up).
export function repoRoot(): string {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

// Purpose: absolute path of the built CLI.
export function builtCli(): string {
    return path.join(repoRoot(), 'dist', 'cli.js')
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

// Purpose: the launch used by the repo's dev plugin (`claude --plugin-dir plugins/claude`).
export function devPluginLaunch(): Launch {
    return { node: 'node', cli: '${CLAUDE_PLUGIN_ROOT}/../../dist/cli.js' }
}

export const EXTENSION_SOURCE = path.join('adapters', 'pi-omp', 'harness-summit.ts')
export const HARNESS_MARKER = 'const INJECTED_HARNESS: string | null = null'
export const CLI_MARKER = 'const INJECTED_CLI: string[] | null = null'
export const MCP_MARKER = 'const INJECTED_MCP: McpLaunch | null = null'

// Purpose: the pi/OMP extension source with the harness, the absolute CLI launch and (pi) the MCP server
// launch substituted. pi registers the server from the extension (SPEC §3, §8).
export function renderExtension(harness: 'pi' | 'omp', launch: Launch): string {
    const file = path.join(repoRoot(), EXTENSION_SOURCE)
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
