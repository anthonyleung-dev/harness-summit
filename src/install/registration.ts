// What a harness registration starts, read back from the text of its file: the Claude plugin's .mcp.json, the
// Codex TOML block, the OMP mcp.json key, the OpenCode config key and the pi extension's injected launch. Used by
// the OpenCode edit (plan.ts: does the file already hold the wanted launch?) and by doctor (does a registration
// start another node or CLI than the one running?).
import { z } from 'zod'

import { log } from '../core/log.js'
import { SUMMIT_NAME, type Harness } from '../core/schemas.js'
import { getAt, parseJsonc, parseTomlOrRefuse } from './edits.js'
import { MCP_PREFIX } from './launch.js'
import { OPENCODE_KEY } from './movable.js'
import type { McpLaunch } from './render.js'

// The key of the server in a JSON `mcpServers` map (Claude's .mcp.json, the pi and OMP mcp.json).
export const JSON_KEY = ['mcpServers', SUMMIT_NAME]
// The key of the server table in the Codex config.toml.
export const CODEX_KEY = ['mcp_servers', SUMMIT_NAME]

const EnvSchema = z.record(z.string(), z.string())
const LaunchSchema = z.object({ command: z.string(), args: z.array(z.string()), env: EnvSchema.optional() })
// What `opencode mcp add` writes (SPEC §8): the command and its args in one array, the env as `environment`.
const OpencodeSchema = z.object({ command: z.array(z.string()).min(1), environment: EnvSchema.optional() })

// Purpose: the raw server value of one harness's registration text (unvalidated; undefined when absent).
function serverValue(harness: Harness, text: string, file: string): unknown {
    switch (harness) {
        case 'codex':
            return getAt(parseTomlOrRefuse(text, file), CODEX_KEY)
        case 'opencode':
            return getAt(parseJsonc(text, file), OPENCODE_KEY)
        case 'pi': {
            const line = text.split('\n').find((l) => l.startsWith(MCP_PREFIX))
            return line === undefined ? undefined : JSON.parse(line.slice(MCP_PREFIX.length))
        }
        case 'claude':
        case 'omp':
            return getAt(parseJsonc(text, file), JSON_KEY)
    }
}

// Purpose: the launch a registration text starts, or null when it holds none or cannot be read (logged).
export function readLaunch(harness: Harness, text: string, file: string): McpLaunch | null {
    try {
        const value = serverValue(harness, text, file)
        if (value === undefined || value === null) return null
        if (harness !== 'opencode') return LaunchSchema.parse(value)
        const { command, environment } = OpencodeSchema.parse(value)
        return { command: command[0]!, args: command.slice(1), env: environment }
    } catch (err) {
        log('warn', 'readLaunch', 'registration not readable', { harness, file, error: String(err) })
        return null
    }
}

// Purpose: tell whether a registration starts the wanted launch: same command and args, and with `withEnv`
// the same env (a missing env equals an empty one).
export function sameLaunch(found: McpLaunch | null, wanted: McpLaunch, withEnv: boolean): boolean {
    if (found === null || found.command !== wanted.command) return false
    if (JSON.stringify(found.args) !== JSON.stringify(wanted.args)) return false
    if (!withEnv) return true
    const sorted = (env?: Record<string, string>) => JSON.stringify(Object.entries(env ?? {}).sort())
    return sorted(found.env) === sorted(wanted.env)
}
