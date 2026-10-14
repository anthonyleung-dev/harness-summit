// Where install's targets live for one --home: the env of the harness CLIs install runs (execEnv) and the
// config dirs an env var can move (codexDir, opencodeDir). All follow one rule: for the real home the
// caller's own env counts (it is the user's setup); for any other home, only paths below --home count, so a
// temp install never reaches the caller's real config.
import os from 'node:os'
import path from 'node:path'

import { summitError } from '../core/errors.js'
import { log } from '../core/log.js'
import { samePath } from '../core/project.js'

// Env vars that move a config, data or cache location of a harness CLI away from HOME (from each CLI's
// --help and docs: Claude Code env-vars reference, OpenCode config docs, pi/omp --help, Codex docs). For a
// --home that is not the real home, each is pointed below --home (a relative path) or removed (null), so a
// command install runs can never reach the caller's real config. Removed: the ones with no single home-based
// default (OpenCode's overrides are extra layers; pi and omp read PI_CODING_AGENT_DIR with different defaults).
export const HOME_BOUND_ENV: Readonly<Record<string, readonly string[] | null>> = {
    XDG_CONFIG_HOME: ['.config'],
    XDG_DATA_HOME: ['.local', 'share'],
    XDG_STATE_HOME: ['.local', 'state'],
    XDG_CACHE_HOME: ['.cache'],
    CLAUDE_CONFIG_DIR: ['.claude'],
    CODEX_HOME: ['.codex'],
    CLAUDE_CODE_PLUGIN_CACHE_DIR: null,
    CLAUDE_CODE_PLUGIN_SEED_DIR: null,
    CLAUDE_CODE_PLUGIN_DIRS: null,
    CLAUDE_CODE_DEBUG_LOGS_DIR: null,
    OPENCODE_CONFIG: null,
    OPENCODE_CONFIG_DIR: null,
    OPENCODE_CONFIG_CONTENT: null,
    OPENCODE_TUI_CONFIG: null,
    PI_CODING_AGENT_DIR: null,
    PI_CODING_AGENT_SESSION_DIR: null,
}

// Purpose: tell whether --home is the real home (os.homedir()): only then does the caller's env count.
// Through samePath, so `C:\users\bob` is the real home `C:\Users\Bob` on Windows.
export function isRealHome(
    home: string,
    platform: NodeJS.Platform = process.platform,
    real: string = os.homedir(),
): boolean {
    return samePath(home, real, platform)
}

// Purpose: env for external commands, pointed at the chosen home. Windows programs find the home through
// USERPROFILE, not HOME (XPLAT-AUDIT D22), so both are set. For the real home, the caller's other values pass
// through unchanged (they are the user's own setup); for any other home, HOME_BOUND_ENV applies.
export function execEnv(home: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = { ...base, HOME: home, USERPROFILE: home }
    if (isRealHome(home)) return env
    for (const [name, rel] of Object.entries(HOME_BOUND_ENV)) {
        if (rel === null) delete env[name]
        else env[name] = path.join(home, ...rel)
    }
    return env
}

// A harness config dir that env vars can move: the vars in the order the harness reads them (the first one
// set and non-empty wins), each with the part below its dir; the dir below the home when none is set (or for
// a --home that is not the real home); and what the error and the log name.
interface MovableDir {
    sources: { variable: 'CODEX_HOME' | 'XDG_CONFIG_HOME' | 'OPENCODE_CONFIG_DIR'; below: string[] }[]
    fallback: readonly string[]
    harness: 'codex' | 'opencode'
    fn: string
}

const CODEX_DIR: MovableDir = {
    sources: [{ variable: 'CODEX_HOME', below: [] }],
    fallback: HOME_BOUND_ENV.CODEX_HOME ?? [],
    harness: 'codex',
    fn: 'codexDir',
}
const OPENCODE_DIR: MovableDir = {
    sources: [
        { variable: 'OPENCODE_CONFIG_DIR', below: [] },
        { variable: 'XDG_CONFIG_HOME', below: ['opencode'] },
    ],
    fallback: [...(HOME_BOUND_ENV.XDG_CONFIG_HOME ?? []), 'opencode'],
    harness: 'opencode',
    fn: 'opencodeDir',
}

// Purpose: the one resolver for a movable config dir. For the real home: <$VAR>/<below> of the first source
// var that is set and non-empty, else <home>/<fallback>; for any other home always <home>/<fallback>, the
// value execEnv gives the CLIs (it points or removes every source var). A relative value is refused: the
// harness resolves it against its own working directory, which differs per launch, so no single dir is the
// one it reads. Only the harness that uses the dir calls this (plan.ts resolves one harness at a time), so a
// bad value blocks only that harness.
function movableDir(home: string, d: MovableDir, env: NodeJS.ProcessEnv): string {
    const source = isRealHome(home) ? d.sources.find((s) => (env[s.variable] ?? '') !== '') : undefined
    if (source === undefined) return path.join(home, ...d.fallback)
    const { variable, below } = source
    const value = env[variable] as string
    if (!path.isAbsolute(value)) {
        log('warn', d.fn, `relative ${variable} refused`, { home, variable, value })
        throw summitError(
            'SUMMIT_BAD_INPUT',
            `${variable} is relative (${JSON.stringify(value)}); ${d.harness} resolves it against its own working directory, so no single dir is the one it reads. Install and uninstall of ${d.harness} both need it fixed: set it to an absolute path or unset it, then run them again; or leave ${d.harness} out of --harness`,
            d.fn,
            { home, harness: d.harness, variable, value },
        )
    }
    log('debug', d.fn, `using ${variable}`, { home, value })
    return path.join(path.resolve(value), ...below)
}

// Purpose: the Codex home: the dir that holds Codex's user config.toml and its user skills/ (Codex 0.162.1:
// `find_codex_home` in codex-rs/utils/home-dir, the User layer's skills root in codex-rs/ext/skills). Real
// home: $CODEX_HOME when set, else <home>/.codex (movableDir).
export function codexDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
    return movableDir(home, CODEX_DIR, env)
}

// Purpose: OpenCode's global config dir: it holds the config file `opencode mcp add --global` writes
// (OPENCODE_CONFIG_FILES) and commands/. Read from the OpenCode 2.0.26 binary: its Global path module sets
// `u=process.env.XDG_CONFIG_HOME||(n?t.join(n,".config"):void 0)` and `config:t.join(u,"opencode")`, and the
// CLI replaces it with `Ca.replace(TT(process.env.OPENCODE_CONFIG_DIR?{config:process.env.OPENCODE_CONFIG_DIR}:{}))`.
// Real home: $OPENCODE_CONFIG_DIR when set and non-empty, else $XDG_CONFIG_HOME/opencode, else
// <home>/.config/opencode (movableDir).
export function opencodeDir(home: string, env: NodeJS.ProcessEnv = process.env): string {
    return movableDir(home, OPENCODE_DIR, env)
}

// The config files `opencode mcp add --global` looks for in the config dir, in its order: it writes the first
// that is a file, else creates the first. OpenCode 2.0.26: `async function yw(e){let o=[a.join(e,"opencode.json"),
// a.join(e,"opencode.jsonc"),a.join(e,".opencode","opencode.json"),a.join(e,".opencode","opencode.jsonc")];for(let n
// of o)if(await u(n).then((r)=>r.isFile(),()=>!1))return n;return o[0]}`, called as `yw(e.global?m.config:...)`.
export const OPENCODE_CONFIG_FILES: readonly string[][] = [
    ['opencode.json'],
    ['opencode.jsonc'],
    ['.opencode', 'opencode.json'],
    ['.opencode', 'opencode.jsonc'],
]
