// Install actions and their exact reversal. Kinds: an owned file, an edit of a user file (in-process
// text edit, or an external command that edits it), an external command with an undo command, and a
// retired edit (an edit an older install made and this version no longer wants: install and uninstall
// both undo it when the state still records it).
import fs from 'node:fs/promises'
import path from 'node:path'

import { summitError } from '../core/errors.js'
import type { Exec, ExecRequest } from '../core/exec.js'
import { pathExists, readTextFile } from '../core/fsx.js'
import { log } from '../core/log.js'
import { sha, type InstallState } from './state.js'

export type Action =
    | { kind: 'file'; path: string; content: string }
    | {
          kind: 'edit'
          path: string
          what: string
          apply?: (text: string) => string
          run?: ExecRequest
          // Undo our edit in `text`. `original` is the file before install (the backup; '' when install
          // created the file; null when unknown).
          revert: (text: string, original: string | null) => string
      }
    | { kind: 'exec'; id: string; run: ExecRequest; undo: ExecRequest }
    | { kind: 'retire'; path: string; what: string; revert: (text: string, original: string | null) => string }

export interface ActionEnv {
    state: InstallState
    exec: Exec
    dryRun: boolean
    report: (line: string) => void
}

export const BACKUP_SUFFIX = '.harness-summit.bak'

// Purpose: create the parent dirs of `p`, recording each one we create.
export async function ensureParentDirs(p: string, state: InstallState): Promise<void> {
    const missing: string[] = []
    for (let d = path.dirname(p); !(await pathExists(d)); d = path.dirname(d)) missing.push(d)
    await fs.mkdir(path.dirname(p), { recursive: true })
    for (const d of missing) if (!state.dirs.includes(d)) state.dirs.push(d)
}

// Purpose: run an external command to completion; non-zero exit is an error.
async function runChecked(req: ExecRequest, exec: Exec): Promise<void> {
    const res = await exec.capture(req, 120_000)
    if (res.code !== 0) {
        log('warn', 'runChecked', 'command failed', { cmd: req.cmd, code: res.code })
        throw summitError('SUMMIT_EXEC_FAILED', `${req.cmd} exited ${res.code}: ${res.stderr.trim()}`, 'runChecked', {
            cmd: req.cmd,
            args: req.args,
        })
    }
}

// Purpose: write an owned file. Refuses to overwrite a file install did not write.
async function applyFile(a: Extract<Action, { kind: 'file' }>, env: ActionEnv): Promise<void> {
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
    if (env.dryRun) return
    await ensureParentDirs(a.path, env.state)
    await fs.writeFile(a.path, a.content)
    env.state.files[a.path] = sha(a.content)
}

// Purpose: edit a user file once-backed-up; a no-op when it still holds our last edit.
async function applyEdit(a: Extract<Action, { kind: 'edit' }>, env: ActionEnv): Promise<void> {
    const current = await readTextFile(a.path)
    const text = current ?? ''
    const rec = env.state.edits[a.path]
    if (rec !== undefined && sha(text) === rec.postSha) return env.report(`ok      ${a.path} (${a.what})`)
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
    const preSha = rec === undefined ? sha(text) : sha(a.revert(text, null))
    env.state.edits[a.path] = { existed: rec?.existed ?? current !== null, preSha, postSha: sha(next) }
}

// Purpose: run an external command once.
async function applyExec(a: Extract<Action, { kind: 'exec' }>, env: ActionEnv): Promise<void> {
    if (env.state.execs[a.id]) return env.report(`ok      ${a.id}`)
    env.report(`run     ${a.run.cmd} ${a.run.args.join(' ')}`)
    if (env.dryRun) return
    await runChecked(a.run, env.exec)
    env.state.execs[a.id] = true
}

// Purpose: apply one action.
export async function applyAction(a: Action, env: ActionEnv): Promise<void> {
    log('info', 'applyAction', a.kind, { target: a.kind === 'exec' ? a.id : a.path, dryRun: env.dryRun })
    if (a.kind === 'file') return await applyFile(a, env)
    if (a.kind === 'edit') return await applyEdit(a, env)
    if (a.kind === 'retire') return await revertEdit({ ...a, kind: 'edit' }, env)
    return await applyExec(a, env)
}

// Purpose: remove an owned file unless the user changed it.
async function revertFile(a: Extract<Action, { kind: 'file' }>, env: ActionEnv): Promise<void> {
    const recorded = env.state.files[a.path]
    if (recorded === undefined) return
    const current = await readTextFile(a.path)
    if (current !== null && sha(current) !== recorded) env.report(`keep    ${a.path} (changed since install)`)
    else {
        env.report(`remove  ${a.path}`)
        if (!env.dryRun) await fs.rm(a.path, { force: true })
    }
    if (!env.dryRun) delete env.state.files[a.path]
}

// Purpose: undo an edit: restore the backup when nothing changed since install, else remove only our key.
async function revertEdit(a: Extract<Action, { kind: 'edit' }>, env: ActionEnv): Promise<void> {
    const rec = env.state.edits[a.path]
    if (rec === undefined) return
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
    log('info', 'revertAction', a.kind, { target: a.kind === 'exec' ? a.id : a.path, dryRun: env.dryRun })
    if (a.kind === 'file') return await revertFile(a, env)
    if (a.kind === 'edit' || a.kind === 'retire') return await revertEdit({ ...a, kind: 'edit' }, env)
    return await revertExec(a, env)
}

// Purpose: remove the directories install created, deepest first, when empty.
export async function removeCreatedDirs(env: ActionEnv): Promise<void> {
    const dirs = [...env.state.dirs].sort((a, b) => b.length - a.length)
    for (const d of dirs) {
        const left = await fs.readdir(d).catch(() => null)
        if (left !== null && left.length > 0) continue
        if (!env.dryRun) {
            await fs.rm(d, { recursive: true, force: true })
            env.state.dirs = env.state.dirs.filter((x) => x !== d)
        }
    }
}
