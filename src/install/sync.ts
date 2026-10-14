// The sync action (SPEC §8): a refresh command that brings a harness's own record up to date after an upgrade.
// Claude Code reads a plugin of a local directory marketplace from that folder (`claude plugin list --json`
// shows `readFromFolder`; Claude Code 2.1.299, run in a temp home), so a re-run of install that rewrites the
// marketplace files changes the plugin in use at the next session start or /reload-plugins. Claude Code also
// keeps a cache copy and a recorded version from `plugin install`; after a version change `claude plugin
// update` brings those in line, so `claude plugin list` shows the new version (with the same version it
// prints "nothing to update" and exits 0). It has no undo: uninstall removes the plugin itself (the
// `claude-plugin` exec), so it only forgets the record.
import { toSummitError } from '../core/errors.js'
import { log } from '../core/log.js'
import { isInsideDir } from '../core/project.js'
import { runChecked, type ActionEnv, type SyncAction } from './actions.js'

// Purpose: tell why the refresh must run, or null when nothing changed since the last refresh.
function syncReason(a: SyncAction, env: ActionEnv): string | null {
    if ([...env.written].some((p) => isInsideDir(p, a.watch))) return 'files changed'
    const last = env.state.synced?.[a.id]
    return last === a.version ? null : `recorded ${last ?? 'none'}, now ${a.version}`
}

// Purpose: record that the refresh brought in `a.version` (not in a dry run).
function recordSync(a: SyncAction, env: ActionEnv): void {
    if (env.dryRun) return
    env.state.synced = { ...env.state.synced, [a.id]: a.version }
}

// Purpose: run the refresh when an earlier install ran `a.after` and something changed since the last refresh.
// Silent before that exec has run (a fresh install: `plugin install` copies the current files itself, so the
// version is only recorded). A failed refresh warns and does not stop install: the plugin in use is already
// the new one (read from the folder); only the displayed version stays old. The record is dropped, so the
// next run retries. When the output says the plugin is gone (removed by hand), see dropGone.
export async function applySync(a: SyncAction, env: ActionEnv): Promise<void> {
    if (env.ran.has(a.after)) return recordSync(a, env)
    if (env.state.execs[a.after] !== true) return
    const reason = syncReason(a, env)
    if (reason === null) return env.report(`ok      ${a.id}`)
    const line = `${a.run.cmd} ${a.run.args.join(' ')}`
    env.report(`run     ${line} (${reason})`)
    if (env.dryRun) return
    try {
        await runChecked(a.run, env.exec)
        recordSync(a, env)
        log('info', 'applySync', 'refreshed', { id: a.id, version: a.version, reason })
    } catch (err) {
        // runChecked throws SUMMIT_EXEC_FAILED with the exit code and stderr; a spawn error keeps its own code.
        const e = toSummitError(err, 'applySync', { id: a.id, cmd: a.run.cmd, args: a.run.args })
        log('warn', 'applySync', 'refresh failed; install goes on', { id: a.id, error: e.toJSON() })
        forgetSync(a, env) // the next run sees no record and retries, even when no file changes then
        if (dropGone(a, env, err)) return
        env.report(
            `warn    ${a.id} failed (${e.code}: ${e.message}); install goes on. The plugin in use is already the new one; only the version Claude Code shows stays old. Run \`${line}\` later, or run install again.`,
        )
    }
}

// Purpose: when the failed refresh's output (stderr in the message, stdout in the inputs: runChecked) names
// one of `a.gone`, what those execs installed was removed outside install: drop their records, so the next
// install runs them again, and say so. Returns whether it matched.
function dropGone(a: SyncAction, env: ActionEnv, err: unknown): boolean {
    const e = toSummitError(err, 'dropGone', { id: a.id })
    const output = `${e.message}\n${typeof e.inputs.stdout === 'string' ? e.inputs.stdout : ''}`
    const gone = a.gone.find((g) => output.includes(g.match))
    if (gone === undefined) return false
    for (const id of gone.drop) delete env.state.execs[id]
    log('warn', 'dropGone', 'removed outside install; records dropped', { id: a.id, dropped: gone.drop })
    env.report(
        `warn    ${a.id}: the ${gone.what} is no longer installed in Claude Code (removed by hand?). Its install record is dropped: run install again to add it back.`,
    )
    return true
}

// Purpose: uninstall side: never undo a refresh (the plugin's own exec removes the plugin); drop its record.
export function forgetSync(a: SyncAction, env: ActionEnv): void {
    if (env.dryRun || env.state.synced?.[a.id] === undefined) return
    const { [a.id]: _gone, ...rest } = env.state.synced
    env.state.synced = Object.keys(rest).length > 0 ? rest : undefined
}
