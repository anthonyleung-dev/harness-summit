// Install checks for Claude Code, run before any write; never in doctor (doctor runs no harness CLI).
// 1. Marketplace name: Claude Code keeps one marketplace per name, and the public plugin's marketplace has
//    the same name as the one install registers (SUMMIT_NAME). `claude plugin marketplace add` of a second
//    source under a taken name exits 0 either way: the CLI reference says it prints "already on disk" (the
//    public plugin stays active); Claude Code 2.1.299, run in a temp home, instead repoints the name to the new
//    source ("was already added from ... and now points at ..."), silently moving the user's plugin. The check
//    reads `claude plugin marketplace list --json` first and stops with the fix.
// 2. Plugin still installed: a user can remove the plugin by hand (/plugin uninstall) while the install state
//    says it is installed. The check reads `claude plugin list --json` and, when the plugin is missing, drops
//    the records of the marketplace and plugin commands so this run adds them again (both are idempotent:
//    Claude Code 2.1.299 answers "already on disk" and installs).
import { z } from 'zod'

import { summitError, toSummitError } from '../core/errors.js'
import type { Exec } from '../core/exec.js'
import { PLUGIN_ID, PUBLIC_PLUGIN_REMOVAL } from '../core/fixText.js'
import { log } from '../core/log.js'
import { samePath } from '../core/project.js'
import { SUMMIT_NAME } from '../core/schemas.js'
import { CLAUDE_EXECS, claudeMarketDir, claudeRequest } from './plan.js'
import type { InstallState } from './state.js'

// One entry of `claude plugin marketplace list --json` (documented fields; every field is a string).
const MarketEntrySchema = z.looseObject({
    name: z.string(),
    source: z.string(),
    path: z.string().optional(),
    repo: z.string().optional(),
    url: z.string().optional(),
})
const MarketListSchema = z.array(MarketEntrySchema)
type MarketEntry = z.infer<typeof MarketEntrySchema>

// One entry of `claude plugin list --json` (Claude Code 2.1.299: id, version, scope, enabled, ...).
const PluginListSchema = z.array(z.looseObject({ id: z.string() }))

const LIST_TIMEOUT_MS = 30_000

// Purpose: parse a `--json` list output: the whole stdout, else its last line (a JSON result line), else the
// text from its first `[` to its last `]` (pretty-printed JSON after a warning line). Null when none is a
// valid list.
export function parseJsonList<S extends z.ZodType>(stdout: string, schema: S): z.infer<S> | null {
    const text = stdout.trim()
    const bracketed = text.slice(text.indexOf('['), text.lastIndexOf(']') + 1)
    for (const candidate of [text, text.split('\n').at(-1) ?? '', bracketed]) {
        try {
            const parsed = schema.safeParse(JSON.parse(candidate))
            if (parsed.success) return parsed.data
        } catch {
            // not JSON: try the next candidate
        }
    }
    return null
}

// Purpose: parse `claude plugin marketplace list --json` (parseJsonList). Null when it is not a valid list.
export function parseMarketList(stdout: string): MarketEntry[] | null {
    return parseJsonList(stdout, MarketListSchema)
}

// Purpose: run one `claude ... --json` list and parse it. On an unreadable list (claude missing, an older
// claude without `--json`, a recorded dry run) it logs a structured error, reports a visible `warn` line and
// returns null: the caller then goes on as it did before the check.
async function readList<S extends z.ZodType>(
    home: string,
    exec: Exec,
    args: string[],
    schema: S,
    report: (line: string) => void,
): Promise<z.infer<S> | null> {
    const req = claudeRequest(home, args)
    const shown = `claude ${args.join(' ')}`
    try {
        const res = await exec.capture(req, LIST_TIMEOUT_MS)
        const list = res.code === 0 ? parseJsonList(res.stdout, schema) : null
        if (list !== null) return list
        const e = summitError('SUMMIT_EXEC_FAILED', `${shown} gave no readable list`, 'readList', {
            args,
            code: res.code,
            stderr: res.stderr.trim().slice(-500),
        })
        log('warn', 'readList', 'list unreadable', { error: e.toJSON() })
    } catch (err) {
        log('warn', 'readList', 'list did not run', { error: toSummitError(err, 'readList', { args }).toJSON() })
    }
    report(`warn    could not read \`${shown}\`; install goes on without this check`)
    return null
}

// Purpose: tell whether a listed marketplace is the one install registers (a directory source at `market`).
function isInstallMarket(entry: MarketEntry, market: string): boolean {
    return entry.source === 'directory' && entry.path !== undefined && samePath(entry.path, market)
}

// Purpose: stop the Claude install with SUMMIT_INSTALL_CONFLICT when a marketplace named SUMMIT_NAME is
// registered from another source (most likely the public plugin). An unreadable list warns (readList) and
// lets install go on: install then behaves as it did before this check.
export async function checkClaudeMarketplace(home: string, exec: Exec, report: (line: string) => void) {
    const market = claudeMarketDir(home)
    const args = ['plugin', 'marketplace', 'list', '--json']
    const entries = await readList(home, exec, args, MarketListSchema, report)
    const taken = entries?.find((e) => e.name === SUMMIT_NAME && !isInstallMarket(e, market))
    if (taken === undefined) return
    const from = taken.repo ?? taken.url ?? taken.path ?? taken.source
    log('error', 'checkClaudeMarketplace', 'marketplace name taken', { from, market })
    throw summitError(
        'SUMMIT_INSTALL_CONFLICT',
        `Claude Code already has a marketplace named ${SUMMIT_NAME} from ${taken.source} ${from}, most likely the public plugin. Claude Code keeps one marketplace per name, so install cannot register its own. Fix: ${PUBLIC_PLUGIN_REMOVAL}; then run this install again. Or keep the public plugin and install the other harnesses only: run \`${SUMMIT_NAME} install --harness codex,pi,omp,opencode\`.`,
        'checkClaudeMarketplace',
        { name: SUMMIT_NAME, source: taken.source, from, market },
    )
}

// Purpose: when the state records that install installed the plugin but `claude plugin list --json` does not
// list it (removed by hand), drop the records of the marketplace and plugin commands so this run adds them
// again, and report it. An unreadable list changes nothing (readList warns; the update step's own check in
// sync.ts remains).
export async function checkClaudePlugin(home: string, exec: Exec, state: InstallState, report: (l: string) => void) {
    if (state.execs['claude-plugin'] !== true) return
    const plugins = await readList(home, exec, ['plugin', 'list', '--json'], PluginListSchema, report)
    if (plugins === null || plugins.some((p) => p.id === PLUGIN_ID)) return
    for (const id of CLAUDE_EXECS) delete state.execs[id]
    log('warn', 'checkClaudePlugin', 'plugin removed outside install; installing again', {
        home,
        dropped: CLAUDE_EXECS,
    })
    report(`warn    ${PLUGIN_ID} is no longer installed in Claude Code (removed by hand?); installing it again`)
}
