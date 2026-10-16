// The edit action (actions.ts): install's edit of a user config file, and its exact undo. A backup holds only the
// user's own file from before install's first edit; a file install created is undone by its content.
import fs from 'node:fs/promises'

import { pathExists, readTextFile } from '../core/fsx.js'
import { BACKUP_SUFFIX, ensureParentDirs, runChecked, type Action, type ActionEnv } from './actions.js'
import { keepInTheWay } from './inTheWay.js'
import { sha } from './state.js'

type EditAction = Extract<Action, { kind: 'edit' }>

// Purpose: tell whether `text` already holds what an edit writes: `apply` changes nothing, or `holds` says so.
function holdsEdit(a: EditAction, text: string): boolean {
    if (a.run) return a.holds?.(text) ?? true
    return (a.apply ?? ((t: string) => t))(text) === text
}

// Purpose: tell whether a config text holds nothing but whitespace and an empty top-level object: what is left of
// a file install created once our key is reverted, when the user added nothing (a comment counts as content).
export function isBlankConfig(text: string): boolean {
    const bare = text.replace(/\s/g, '')
    return bare === '' || bare === '{}'
}

// Purpose: edit a user file once-backed-up; a no-op when it still holds our last edit and that edit is still the
// wanted one (a re-install after the launch changed edits again, SPEC §8).
export async function applyEdit(a: EditAction, env: ActionEnv): Promise<void> {
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
    // The backup holds only the user's file from before install: never our own last edit, and never a file
    // install created (there was no user file before it; uninstall undoes it by content).
    const userFile = current !== null && !ours && rec?.existed !== false
    if (userFile && !(await pathExists(a.path + BACKUP_SUFFIX))) await fs.writeFile(a.path + BACKUP_SUFFIX, current)
    // Recorded before a command runs too, so uninstall removes the dirs that command creates for its file.
    await ensureParentDirs(a.path, env.state)
    let next: string
    if (a.run) {
        await runChecked(a.run, env.exec)
        next = (await readTextFile(a.path)) ?? ''
    } else {
        next = (a.apply ?? ((t: string) => t))(text)
        await fs.writeFile(a.path, next)
    }
    // A file that still holds our last edit keeps its recorded pre-install state, so uninstall restores the backup.
    const preSha = rec === undefined ? sha(text) : ours ? rec.preSha : sha(a.revert(text, null))
    env.state.edits[a.path] = { existed: rec?.existed ?? current !== null, preSha, postSha: sha(next) }
}

// Purpose: undo an edit. A file install created is decided by its content, not its sha history (a re-install
// records a new sha over whatever the user added since, so "unchanged since install" does not mean "nothing of the
// user's"): our key is removed, and the file goes only when nothing else is left in it. A file the user had is
// restored from the backup when nothing changed since install, else only our key is removed.
export async function revertEdit(a: EditAction, env: ActionEnv): Promise<void> {
    const rec = env.state.edits[a.path]
    if (rec === undefined) return
    if (await keepInTheWay(a.path, 'file', env, () => delete env.state.edits[a.path])) return
    const current = await readTextFile(a.path)
    const backup = await readTextFile(a.path + BACKUP_SUFFIX)
    const untouched = current !== null && sha(current) === rec.postSha
    if (current !== null && !rec.existed) {
        const reverted = a.revert(current, '')
        if (isBlankConfig(reverted)) {
            env.report(`remove  ${a.path} (created by install)`)
            if (!env.dryRun) await fs.rm(a.path, { force: true })
        } else {
            env.report(`edit    ${a.path} (remove ${a.what}; created by install, keeps the user's content)`)
            if (!env.dryRun) await fs.writeFile(a.path, reverted)
        }
    } else if (untouched && backup !== null && sha(backup) === rec.preSha) {
        env.report(`restore ${a.path} from ${a.path + BACKUP_SUFFIX}`)
        if (!env.dryRun) {
            await fs.writeFile(a.path, backup)
            await fs.rm(a.path + BACKUP_SUFFIX, { force: true })
        }
    } else if (current !== null) {
        env.report(`edit    ${a.path} (remove ${a.what}; changed since install, backup kept)`)
        if (!env.dryRun) await fs.writeFile(a.path, a.revert(current, backup))
    }
    if (!env.dryRun) delete env.state.edits[a.path]
}
