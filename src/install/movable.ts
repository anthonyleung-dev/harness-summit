// The harnesses whose config dir an env var can move (Codex, OpenCode; homes.ts movableDir): their current
// config dir, and the cleanup of a config dir an earlier install registered in that is no longer current.
import path from 'node:path'

import { samePath } from '../core/project.js'
import { SUMMIT_NAME } from '../core/schemas.js'
import type { Action } from './actions.js'
import { removeJsonKey, removeTomlBlock } from './edits.js'
import { codexDir, OPENCODE_CONFIG_FILES, opencodeDir } from './homes.js'
import type { InstallState } from './state.js'

// Codex's user config file in the Codex home (codexDir). No other harness registration is a config.toml, so
// a recorded edit of a file of this name is a Codex registration (staleConfigDirs).
export const CODEX_CONFIG = 'config.toml'

// The harnesses whose config dir an env var can move (homes.ts movableDir): the registration files (paths in
// the config dir) that identify their recorded edit (no other harness uses these names) and their command dir.
export type Movable = 'codex' | 'opencode'
export const MOVABLE: Record<Movable, { files: readonly string[][]; commands: string }> = {
    codex: { files: [[CODEX_CONFIG]], commands: 'skills' },
    opencode: { files: OPENCODE_CONFIG_FILES, commands: 'commands' },
}

// Where `opencode mcp add` puts the server in opencode.json(c).
export const OPENCODE_KEY = ['mcp', 'servers', SUMMIT_NAME]

// Purpose: the current config dir of a movable harness. Resolved only on request: a refused env value
// (homes.ts) must block only the harness that uses it.
export function configDirFor(home: string, harness: Movable): string {
    return harness === 'codex' ? codexDir(home) : opencodeDir(home)
}

// The `what` of the Codex registration edit (report lines).
export const CODEX_WHAT = `[mcp_servers.${SUMMIT_NAME}]`

// Purpose: the config dirs a recorded file can be the registration of: each dir D where the file is
// D/<one of MOVABLE[harness].files> (`x/.opencode/opencode.json` fits both `x` and `x/.opencode`).
function configDirsOf(file: string, harness: Movable): string[] {
    return MOVABLE[harness].files.flatMap((rel) => {
        let d = file
        for (const seg of [...rel].reverse()) {
            if (path.basename(d) !== seg) return []
            d = path.dirname(d)
        }
        return [d]
    })
}

// Purpose: the config dirs of a movable harness that an earlier install registered in and that are not the
// current one (the user set or changed CODEX_HOME, OPENCODE_CONFIG_DIR or XDG_CONFIG_HOME since, e.g. a 1.0.1
// install in ~/.codex or ~/.config/opencode): every dir a recorded registration edit fits, unless one fits the
// current dir. Only recorded files and edits are ever cleaned there, so a dir too many touches nothing.
export function staleConfigDirs(home: string, harness: Movable, state: InstallState): string[] {
    const current = configDirFor(home, harness)
    const dirs = Object.keys(state.edits)
        .map((f) => configDirsOf(f, harness))
        .filter((ds) => ds.length > 0 && !ds.some((d) => samePath(d, current)))
    return [...new Set(dirs.flat())]
}

// Purpose: the retired registrations in a stale config dir (Codex: the TOML block; OpenCode: the mcp key in
// each OPENCODE_CONFIG_FILES candidate). Install and uninstall both undo each one the state records; one the
// state does not record is left alone (actions.ts revertEdit).
export function retiredRegistrations(harness: Movable, dir: string): Action[] {
    return MOVABLE[harness].files.map((rel): Action => {
        const file = path.join(dir, ...rel)
        if (harness === 'codex') return { kind: 'retire', path: file, what: CODEX_WHAT, revert: removeTomlBlock }
        const what = OPENCODE_KEY.join('.')
        return { kind: 'retire', path: file, what, revert: (t, orig) => removeJsonKey(t, OPENCODE_KEY, orig, file) }
    })
}
