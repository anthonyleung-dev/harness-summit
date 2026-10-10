// Session cwd, project root and group key (SPEC §4).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { z } from 'zod'

import { summitError } from './errors.js'
import { cliBin, type Exec } from './exec.js'
import { pathExists } from './fsx.js'
import { CODEX_TURN_META_KEY, opencodeSessionId, type RequestMeta } from './hostKey.js'
import { log } from './log.js'
import type { CwdSource, Harness } from './schemas.js'

export const GROUP_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/
const HEX32 = /^[0-9a-f]{32}$/

// Purpose: first existing workspace directory named in Codex turn metadata.
async function codexWorkspace(meta: RequestMeta): Promise<string | undefined> {
    const turn = meta?.[CODEX_TURN_META_KEY]
    if (typeof turn !== 'object' || turn === null) return undefined
    const ws = (turn as Record<string, unknown>).workspaces
    if (typeof ws !== 'object' || ws === null) return undefined
    for (const dir of Object.keys(ws)) if (await pathExists(dir, 'dir')) return dir
    log('debug', 'codexWorkspace', 'no workspace directory exists', { workspaces: Object.keys(ws) })
    return undefined
}

// `opencode api session.get` answer (OpenAPI `Session.Info` inside `data`; the directory is
// `data.location.directory`, DEMO D3).
const OpencodeSessionGet = z.looseObject({
    data: z.looseObject({ location: z.looseObject({ directory: z.string().min(1) }) }),
})

// Purpose: the OpenCode session's directory from `opencode api session.get`, if the CLI answers.
async function opencodeDirectory(meta: RequestMeta, exec: Exec): Promise<string | undefined> {
    const sessionID = opencodeSessionId(meta)
    if (sessionID === undefined) return undefined
    try {
        const res = await exec.capture(
            { cmd: cliBin('opencode'), args: ['api', 'session.get', '--param', `sessionID=${sessionID}`] },
            3000,
        )
        if (res.code !== 0) {
            log('info', 'opencodeDirectory', 'session.get failed, using process.cwd', { code: res.code })
            return undefined
        }
        const parsed = OpencodeSessionGet.safeParse(JSON.parse(res.stdout))
        if (!parsed.success) {
            log('warn', 'opencodeDirectory', 'unexpected session.get shape, using process.cwd', {
                issues: parsed.error.issues.map((i) => i.path.join('.')),
            })
            return undefined
        }
        const dir = parsed.data.data.location.directory
        return (await pathExists(dir, 'dir')) ? dir : undefined
    } catch (err) {
        log('info', 'opencodeDirectory', 'session lookup failed, using process.cwd', { error: String(err) })
        return undefined
    }
}

// Purpose: find the session cwd and say where it came from.
export async function resolveCwd(
    harness: Harness,
    meta: RequestMeta,
    exec: Exec,
): Promise<{ cwd: string; cwdSource: CwdSource }> {
    if (harness === 'codex') {
        const ws = await codexWorkspace(meta)
        if (ws !== undefined) return { cwd: ws, cwdSource: 'codex-workspaces' }
    }
    if (harness === 'opencode') {
        const dir = await opencodeDirectory(meta, exec)
        if (dir !== undefined) return { cwd: dir, cwdSource: 'opencode-session' }
    }
    log('debug', 'resolveCwd', 'using process.cwd', { harness })
    return { cwd: process.cwd(), cwdSource: 'process.cwd' }
}

// Purpose: git top level of cwd when inside a work tree, else the realpath of cwd.
export function projectRootOf(cwd: string): string {
    try {
        const out = execFileSync('git', ['rev-parse', '--show-toplevel'], {
            cwd,
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 5000,
        })
        const top = out.toString().trim()
        if (top !== '') return fs.realpathSync(top)
    } catch {
        log('debug', 'projectRootOf', 'not a git work tree; using the realpath', { cwd })
    }
    try {
        return fs.realpathSync(cwd)
    } catch (err) {
        throw summitError('SUMMIT_IO', `cannot resolve cwd ${cwd}`, 'projectRootOf', { cwd }, err)
    }
}

// Purpose: default group key = md5 hex of the project root.
export function defaultGroupKey(projectRoot: string): string {
    return createHash('md5').update(projectRoot).digest('hex')
}

// Purpose: validate a named group (SPEC §4) and return it as the group key.
export function namedGroupKey(name: string): string {
    if (!GROUP_NAME_PATTERN.test(name) || HEX32.test(name)) {
        throw summitError(
            'SUMMIT_BAD_GROUP',
            'group name must match ^[a-z0-9][a-z0-9-]{0,31}$ and not be 32 hex characters',
            'namedGroupKey',
            { name },
        )
    }
    return name
}
