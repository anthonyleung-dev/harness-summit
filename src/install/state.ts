// Install state: what `install` created or changed, so `uninstall` reverses exactly that.
// Stored in <home>/.local/share/harness-summit/install-state.json.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { z } from 'zod'

import { readJsonFile, writeJsonAtomic } from '../core/fsx.js'
import { log } from '../core/log.js'
import { SUMMIT_NAME } from '../core/schemas.js'

export const InstallStateSchema = z.object({
    version: z.literal(1),
    // Files install owns: path -> sha256 of the content it wrote.
    files: z.record(z.string(), z.string()),
    // Directories install created (removed on uninstall when empty).
    dirs: z.array(z.string()),
    // Edited user files: did it exist, sha before and after our edit.
    edits: z.record(z.string(), z.object({ existed: z.boolean(), preSha: z.string(), postSha: z.string() })),
    // External commands that ran (id -> true).
    execs: z.record(z.string(), z.boolean()),
})
export type InstallState = z.infer<typeof InstallStateSchema>

// Purpose: directory for install-owned data under a home.
export function dataDir(home: string): string {
    return path.join(home, '.local', 'share', SUMMIT_NAME)
}

// Purpose: path of the state file.
export function stateFile(home: string): string {
    return path.join(dataDir(home), 'install-state.json')
}

// Purpose: sha256 hex of a text.
export function sha(text: string): string {
    return createHash('sha256').update(text).digest('hex')
}

// Purpose: load the state (empty when missing).
export async function loadState(home: string): Promise<InstallState> {
    return (
        (await readJsonFile(stateFile(home), InstallStateSchema)) ?? {
            version: 1,
            files: {},
            dirs: [],
            edits: {},
            execs: {},
        }
    )
}

// Purpose: save the state.
export async function saveState(home: string, state: InstallState): Promise<void> {
    await writeJsonAtomic(stateFile(home), InstallStateSchema.parse(state))
    log('debug', 'saveState', 'install state written', { home })
}

// Purpose: tell whether the state records nothing (then the state file itself can go).
export function isEmptyState(state: InstallState): boolean {
    return (
        Object.keys(state.files).length === 0 &&
        state.dirs.length === 0 &&
        Object.keys(state.edits).length === 0 &&
        Object.keys(state.execs).length === 0
    )
}
