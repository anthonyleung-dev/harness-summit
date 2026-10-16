// Install actions and their exact reversal. Kinds: an owned file, an edit of a user file (in-process
// text edit, or an external command that edits it), an external command with an undo command, a
// retired edit (an edit an older install made and this version no longer wants: install and uninstall
// both undo it when the state still records it), a pruned file (an owned file an older install wrote and
// this version no longer renders: install and uninstall both remove it, unless the user changed it), and a
// sync command (sync.ts: a refresh after an upgrade, with no undo).
import fs from 'node:fs/promises'
import path from 'node:path'

import { hasErrno, summitError, toSummitError } from '../core/errors.js'
import type { Exec, ExecRequest } from '../core/exec.js'
import { pathExists, readTextFile } from '../core/fsx.js'
import { log } from '../core/log.js'
import { isInsideDir } from '../core/project.js'
import { keepInTheWay } from './inTheWay.js'
import { sha, type InstallState } from './state.js'
import { applySync, forgetSync } from './sync.js'

export type Action =
    | { kind: 'file'; path: string; content: string }
    | {
          kind: 'edit'
          path: string
          what: string
          apply?: (text: string) => string
          run?: ExecRequest
          // A `run` edit only: tell whether `text` already holds what the command writes (a command cannot be
          // previewed like `apply`). Without it, a file unchanged since our last edit counts as holding it.
          holds?: (text: string) => boolean
          // Undo our edit in `text`. `original` is the file before install (the backup; '' when install
          // created the file; null when unknown).
          revert: (text: string, original: string | null) => string
      }
    | { kind: 'exec'; id: string; run: ExecRequest; undo: ExecRequest }
    | { kind: 'retire'; path: string; what: string; revert: (text: string, original: string | null) => string }
    | { kind: 'prune'; path: string }
    | SyncAction

// A refresh command (sync.ts): runs `run` when the exec `after` ran in an earlier install and either a file
// under `watch` changed in this run or the state records another version than `version` for `id`. `gone`: when
// a failed run's output contains `match`, what those execs installed was removed outside install, so their
// records are dropped (`drop`) and the next install runs them again.
export interface SyncAction {
    kind: 'sync'
    id: string
    after: string
    watch: string
    version: string
    run: ExecRequest
    gone: { match: string; what: string; drop: string[] }[]
}

export interface ActionEnv {
    state: InstallState
    exec: Exec
    dryRun: boolean
    report: (line: string) => void
    // What this run changed (dry run included: what it would change): owned paths written or removed, and
    // the exec ids that ran. A sync action reads both.
    written: Set<string>
    ran: Set<string>
    // The user's paths in the way that this run already reported (inTheWay.ts): each is reported once.
    kept: Set<string>
}

export const BACKUP_SUFFIX = '.harness-summit.bak'

// The report prefix of an action that failed and left what it owns behind (uninstall goes on; the CLI exits 1).
export const FAIL_PREFIX = 'fail    '

// Purpose: create the parent dirs of `p`, recording each one we create.
export async function ensureParentDirs(p: string, state: InstallState): Promise<void> {
    const missing: string[] = []
    for (let d = path.dirname(p); !(await pathExists(d)); d = path.dirname(d)) missing.push(d)
    await fs.mkdir(path.dirname(p), { recursive: true })
    for (const d of missing) if (!state.dirs.includes(d)) state.dirs.push(d)
}

// Purpose: run an external command to completion; non-zero exit is an error. The error's inputs carry the
// exit code and the end of stdout (a caller may read why the command failed, e.g. sync.ts).
export async function runChecked(req: ExecRequest, exec: Exec): Promise<void> {
    const res = await exec.capture(req, 120_000)
    if (res.code !== 0) {
        log('warn', 'runChecked', 'command failed', { cmd: req.cmd, code: res.code })
        throw summitError('SUMMIT_EXEC_FAILED', `${req.cmd} exited ${res.code}: ${res.stderr.trim()}`, 'runChecked', {
            cmd: req.cmd,
            args: req.args,
            code: res.code,
            stdout: res.stdout.trim().slice(-2000),
        })
    }
}

// Purpose: write an owned file. Refuses to overwrite a file install did not write.
async function applyFile(a: Extract<Action, { kind: 'file' }>, env: ActionEnv): Promise<void> {
    if (await keepInTheWay(a.path, 'file', env, () => delete env.state.files[a.path])) return
    const current = await readTextFile(a.path)
    if (current === a.content) {
        env.state.files[a.path] = sha(a.content)
        return env.report(`ok      ${a.path}`)
    }
    if (current !== null && env.state.files[a.path] === undefined) {
        throw summitError(
            'SUMMIT_INSTALL_CONFLICT',
            `${a.path} exists and was not written by harness-summit`,
            'applyFile',
            { path: a.path },
        )
    }
    env.report(`write   ${a.path}`)
    env.written.add(a.path)
    if (env.dryRun) return
    try {
        await ensureParentDirs(a.path, env.state)
        await fs.writeFile(a.path, a.content)
    } catch (err) {
        throw summitError('SUMMIT_IO', `cannot write ${a.path}`, 'applyFile', { path: a.path }, err)
    }
    env.state.files[a.path] = sha(a.content)
}

// Purpose: tell whether `text` already holds what an edit writes: `apply` changes nothing, or `holds` says so.
function holdsEdit(a: Extract<Action, { kind: 'edit' }>, text: string): boolean {
    if (a.run) return a.holds?.(text) ?? true
    return (a.apply ?? ((t: string) => t))(text) === text
}

// Purpose: edit a user file once-backed-up; a no-op when it still holds our last edit and that edit is still the
// wanted one (a re-install after the launch changed edits again, SPEC §8).
async function applyEdit(a: Extract<Action, { kind: 'edit' }>, env: ActionEnv): Promise<void> {
    if (await keepInTheWay(a.path, 'file', env, () => delete env.state.edits[a.path])) return
    const current = await readTextFile(a.path)
    const text = current ?? ''
    const rec = env.state.edits[a.path]
    const ours = rec !== undefined && sha(text) === rec.postSha
    if (ours && holdsEdit(a, text)) return env.report(`ok      ${a.path} (${a.what})`)
    env.report(
        `${a.run ? 'run    ' : 'edit   '} ${a.path} (${a.what})${a.run ? `: ${a.run.cmd} ${a.run.args.join(' ')}` : ''}`,
    )
    if (env.dryRun) return
    if (current !== null && !(await pathExists(a.path + BACKUP_SUFFIX)))
        await fs.writeFile(a.path + BACKUP_SUFFIX, current)
    let next: string
    if (a.run) {
        await runChecked(a.run, env.exec)
        next = (await readTextFile(a.path)) ?? ''
    } else {
        next = (a.apply ?? ((t: string) => t))(text)
        await ensureParentDirs(a.path, env.state)
        await fs.writeFile(a.path, next)
    }
    // A file that still holds our last edit keeps its recorded pre-install state, so uninstall restores the backup.
    const preSha = rec === undefined ? sha(text) : ours ? rec.preSha : sha(a.revert(text, null))
    env.state.edits[a.path] = { existed: rec?.existed ?? current !== null, preSha, postSha: sha(next) }
}

// Purpose: run an external command once.
async function applyExec(a: Extract<Action, { kind: 'exec' }>, env: ActionEnv): Promise<void> {
    if (env.state.execs[a.id]) return env.report(`ok      ${a.id}`)
    env.report(`run     ${a.run.cmd} ${a.run.args.join(' ')}`)
    env.ran.add(a.id)
    if (env.dryRun) return
    await runChecked(a.run, env.exec)
    env.state.execs[a.id] = true
}

// Purpose: apply one action.
export async function applyAction(a: Action, env: ActionEnv): Promise<void> {
    log('info', 'applyAction', a.kind, { target: actionTarget(a), dryRun: env.dryRun })
    if (a.kind === 'file') return await applyFile(a, env)
    if (a.kind === 'edit') return await applyEdit(a, env)
    if (a.kind === 'retire') return await revertEdit({ ...a, kind: 'edit' }, env)
    if (a.kind === 'prune') return await pruneFile(a.path, env)
    if (a.kind === 'sync') return await applySync(a, env)
    return await applyExec(a, env)
}

// Purpose: the log and report target of an action (its id or its path).
export function actionTarget(a: Action): string {
    return a.kind === 'exec' || a.kind === 'sync' ? a.id : a.path
}

// Purpose: remove an owned file unless the user changed it (uninstall, and install's prune of a file this
// version no longer renders). A file the state does not record is never touched: it is not ours. A changed
// file is kept, reported, and no longer recorded: from then on it is the user's.
export async function removeOwnedFile(file: string, env: ActionEnv): Promise<void> {
    const recorded = env.state.files[file]
    if (recorded === undefined) return
    if (await keepInTheWay(file, 'file', env, () => delete env.state.files[file])) return
    const current = await readTextFile(file)
    if (current !== null && sha(current) !== recorded) env.report(`keep    ${file} (changed since install)`)
    else {
        env.report(`remove  ${file}`)
        env.written.add(file)
        if (!env.dryRun && current !== null) await fs.rm(file, { force: true })
    }
    if (!env.dryRun) delete env.state.files[file]
}

// Purpose: undo an edit: restore the backup when nothing changed since install, else remove only our key.
async function revertEdit(a: Extract<Action, { kind: 'edit' }>, env: ActionEnv): Promise<void> {
    const rec = env.state.edits[a.path]
    if (rec === undefined) return
    if (await keepInTheWay(a.path, 'file', env, () => delete env.state.edits[a.path])) return
    const current = await readTextFile(a.path)
    const backup = await readTextFile(a.path + BACKUP_SUFFIX)
    const untouched = current !== null && sha(current) === rec.postSha
    if (untouched && !rec.existed) {
        env.report(`remove  ${a.path} (created by install)`)
        if (!env.dryRun) await fs.rm(a.path, { force: true })
    } else if (untouched && backup !== null && sha(backup) === rec.preSha) {
        env.report(`restore ${a.path} from ${a.path + BACKUP_SUFFIX}`)
        if (!env.dryRun) {
            await fs.writeFile(a.path, backup)
            await fs.rm(a.path + BACKUP_SUFFIX, { force: true })
        }
    } else if (current !== null) {
        env.report(`edit    ${a.path} (remove ${a.what}; changed since install, backup kept)`)
        const original = backup ?? (rec.existed ? null : '')
        if (!env.dryRun) await fs.writeFile(a.path, a.revert(current, original))
    }
    if (!env.dryRun) delete env.state.edits[a.path]
}

// Purpose: run the undo command of an external command that ran.
async function revertExec(a: Extract<Action, { kind: 'exec' }>, env: ActionEnv): Promise<void> {
    if (!env.state.execs[a.id]) return
    env.report(`run     ${a.undo.cmd} ${a.undo.args.join(' ')}`)
    if (env.dryRun) return
    try {
        await runChecked(a.undo, env.exec)
    } catch (err) {
        env.report(`warn    ${a.id}: undo failed: ${String(err)}`)
    }
    delete env.state.execs[a.id]
}

// Purpose: revert one action.
export async function revertAction(a: Action, env: ActionEnv): Promise<void> {
    log('info', 'revertAction', a.kind, { target: actionTarget(a), dryRun: env.dryRun })
    if (a.kind === 'file') return await removeOwnedFile(a.path, env)
    if (a.kind === 'prune') return await pruneFile(a.path, env)
    if (a.kind === 'edit' || a.kind === 'retire') return await revertEdit({ ...a, kind: 'edit' }, env)
    if (a.kind === 'sync') return forgetSync(a, env)
    return await revertExec(a, env)
}

// Purpose: prune one file this version no longer renders (removeOwnedFile), and at once the dirs install
// created that it leaves empty: a later action (the Claude plugin refresh) must not copy an empty skill dir.
async function pruneFile(file: string, env: ActionEnv): Promise<void> {
    await removeOwnedFile(file, env)
    await removeCreatedDirs(env, [file])
}

// Purpose: remove the directories install created, deepest first, each only when it is still an empty dir
// (rmdir, never a recursive rm). A missing one is only forgotten. One that is no longer a dir, or under a
// user's file, is the user's (keepInTheWay: reported once, forgotten). Any other error keeps it and its
// record (a later run retries) and is logged. With `around`, only the created dirs that hold one of those
// paths (install: the dirs a pruned file leaves behind).
export async function removeCreatedDirs(env: ActionEnv, around?: string[]): Promise<void> {
    const holds = (d: string) => around === undefined || around.some((p) => isInsideDir(p, d))
    const dirs = env.state.dirs.filter(holds).sort((a, b) => b.length - a.length)
    const forget = (d: string) => {
        if (!env.dryRun) env.state.dirs = env.state.dirs.filter((x) => x !== d)
    }
    for (const d of dirs) {
        if (await keepInTheWay(d, 'dir', env, () => forget(d))) continue
        try {
            if ((await fs.readdir(d)).length > 0) continue
            if (!env.dryRun) await fs.rmdir(d)
            forget(d)
        } catch (err) {
            if (hasErrno(err, 'ENOENT') || hasErrno(err, 'ENOTDIR')) {
                forget(d)
                continue
            }
            const e = toSummitError(err, 'removeCreatedDirs', { dir: d })
            log('warn', 'removeCreatedDirs', 'created dir kept', { dir: d, error: e.toJSON() })
        }
    }
}
