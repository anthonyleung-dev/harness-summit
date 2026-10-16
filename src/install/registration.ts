// What a harness registration starts, read back from the text of its file: the Claude plugin's .mcp.json, the
// Codex TOML block, the OMP mcp.json key, the OpenCode config key and the pi extension's injected launch. Used by
// the OpenCode edit (plan.ts: does the file already hold the wanted launch?) and by doctor (does a registration
// start another node or CLI than the one running?).
import { z } from 'zod'

import { log } from '../core/log.js'
import { samePath } from '../core/project.js'
import { type Harness } from '../core/schemas.js'
import { getAt, parseJsonc, parseTomlOrRefuse } from './edits.js'
import { CODEX_KEY, JSON_KEY, OPENCODE_KEY } from './keys.js'
import { MCP_PREFIX } from './launch.js'
import type { McpLaunch } from './render.js'

const EnvSchema = z.record(z.string(), z.string())
const LaunchSchema = z.object({ command: z.string(), args: z.array(z.string()), env: EnvSchema.optional() })
// What `opencode mcp add` writes (SPEC §8): the command and its args in one array, the env as `environment`.
const OpencodeSchema = z.object({ command: z.array(z.string()).min(1), environment: EnvSchema.optional() })

// Purpose: parse a registration text; a failure is rethrown with a short reason that names neither the file nor
// a fix (doctor's line prints both once), the parser's error kept as its cause.
function parsed<T>(what: string, parse: () => T): T {
    try {
        return parse()
    } catch (err) {
        throw new Error(`not valid ${what}`, { cause: err })
    }
}

// Purpose: the raw server value of one harness's registration text (unvalidated; undefined when absent).
function serverValue(harness: Harness, text: string, file: string): unknown {
    switch (harness) {
        case 'codex':
            return getAt(
                parsed('TOML', () => parseTomlOrRefuse(text, file)),
                CODEX_KEY,
            )
        case 'opencode':
            return getAt(
                parsed('JSON', () => parseJsonc(text, file)),
                OPENCODE_KEY,
            )
        case 'pi': {
            const line = text.split('\n').find((l) => l.startsWith(MCP_PREFIX))
            return line === undefined ? undefined : parsed('JSON', () => JSON.parse(line.slice(MCP_PREFIX.length)))
        }
        case 'claude':
        case 'omp':
            return getAt(
                parsed('JSON', () => parseJsonc(text, file)),
                JSON_KEY,
            )
    }
}

// What readLaunch found: the launch, or null; `problem` says why a text that should hold a launch does not (a
// file that does not parse, a wrong shape, a pi extension with no injected launch). A config with no
// registration at all reads launch null, problem null.
export interface LaunchRead {
    launch: McpLaunch | null
    problem: string | null
}

// Purpose: the reason text of a failed read (a Zod error lists each bad field).
function problemOf(err: unknown): string {
    if (err instanceof z.ZodError)
        return `unexpected shape: ${err.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`
    return err instanceof Error ? err.message : String(err)
}

// Purpose: the launch a registration text starts, and why none could be read (logged).
export function readLaunch(harness: Harness, text: string, file: string): LaunchRead {
    try {
        const value = serverValue(harness, text, file)
        if (value === undefined || value === null) {
            return { launch: null, problem: harness === 'pi' ? 'the extension holds no injected MCP launch' : null }
        }
        if (harness !== 'opencode') return { launch: LaunchSchema.parse(value), problem: null }
        const { command, environment } = OpencodeSchema.parse(value)
        return { launch: { command: command[0]!, args: command.slice(1), env: environment }, problem: null }
    } catch (err) {
        log('warn', 'readLaunch', 'registration not readable', {
            harness,
            file,
            error: String(err),
            cause: err instanceof Error ? String(err.cause) : undefined,
        })
        return { launch: null, problem: problemOf(err) }
    }
}

// Purpose: tell whether a registration starts the wanted launch: the same node and CLI (samePath), the same other
// args, and with `withEnv` the same env (a missing env equals an empty one; values are paths, samePath).
export function sameLaunch(
    found: McpLaunch | null,
    wanted: McpLaunch,
    withEnv: boolean,
    platform: NodeJS.Platform = process.platform,
): boolean {
    if (found === null || !samePath(found.command, wanted.command, platform)) return false
    const [cli, ...rest] = found.args
    const [wantedCli, ...wantedRest] = wanted.args
    if (cli === undefined || wantedCli === undefined || !samePath(cli, wantedCli, platform)) return false
    if (JSON.stringify(rest) !== JSON.stringify(wantedRest)) return false
    if (!withEnv) return true
    const env = found.env ?? {}
    const wantedEnv = wanted.env ?? {}
    const keys = Object.keys(wantedEnv)
    if (Object.keys(env).length !== keys.length) return false
    return keys.every((k) => env[k] !== undefined && samePath(env[k], wantedEnv[k]!, platform))
}
