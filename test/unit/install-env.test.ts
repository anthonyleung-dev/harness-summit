// The env of every harness CLI install runs (homes.ts execEnv): for a --home that is not the real home, no
// config, data or cache location of the caller may reach the CLI (HOME_BOUND_ENV); for the real home the
// caller's own values pass through unchanged.
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { HARNESSES } from '../../src/core/schemas.js'
import { execEnv, HOME_BOUND_ENV } from '../../src/install/homes.js'
import { runInstall } from '../../src/install/install.js'
import { claudeRequest } from '../../src/install/plan.js'
import { recordingExec, seededHome, tmpDir } from '../helpers/env.js'
import { TEST_LAUNCH } from '../helpers/install.js'

const launch = TEST_LAUNCH

// Purpose: a caller env where every home-bound var points at a "real" dir outside any temp home.
function callerEnv(real: string): Record<string, string> {
    return Object.fromEntries(Object.keys(HOME_BOUND_ENV).map((k) => [k, path.join(real, k)]))
}

// Purpose: tell whether `p` lies inside `home` (or is it).
function under(p: string, home: string): boolean {
    const rel = path.relative(home, p)
    return !rel.startsWith('..') && !path.isAbsolute(rel)
}

describe('execEnv for a temp --home', () => {
    it('points each home-bound var below --home or removes it', () => {
        const home = tmpDir('envhome')
        const env = execEnv(home, { ...callerEnv('/real'), PATH: '/bin', CLAUDE_CODE_TMPDIR: '/t' })
        expect(env.HOME).toBe(home)
        expect(env.USERPROFILE).toBe(home)
        expect(env.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude'))
        expect(env.CODEX_HOME).toBe(path.join(home, '.codex'))
        expect(env.XDG_CONFIG_HOME).toBe(path.join(home, '.config'))
        expect(env.XDG_DATA_HOME).toBe(path.join(home, '.local', 'share'))
        for (const [k, rel] of Object.entries(HOME_BOUND_ENV)) {
            if (rel === null) expect(env[k], k).toBeUndefined()
            else expect(under(env[k]!, home), k).toBe(true)
        }
        // Vars that move no config location pass through.
        expect(env.PATH).toBe('/bin')
        expect(env.CLAUDE_CODE_TMPDIR).toBe('/t')
    })

    it('passes the caller values through unchanged for the real home', () => {
        const base = { ...callerEnv('/real'), PATH: '/bin' }
        const env = execEnv(os.homedir(), base)
        expect(env).toEqual({ ...base, HOME: os.homedir(), USERPROFILE: os.homedir() })
        expect(claudeRequest(os.homedir(), ['plugin', 'list']).env?.CLAUDE_CONFIG_DIR).toBe(
            process.env.CLAUDE_CONFIG_DIR,
        )
    })
})

describe('install --home <tmp> with a caller env aimed at a real config', () => {
    const saved = { ...process.env }
    const real = tmpDir('real-config')
    beforeEach(() => Object.assign(process.env, callerEnv(real)))
    afterEach(() => {
        for (const k of Object.keys(HOME_BOUND_ENV)) delete process.env[k]
        Object.assign(process.env, saved)
    })

    it('gives every harness CLI only values under the temp home', async () => {
        const home = seededHome()
        const exec = recordingExec()
        await runInstall({ harnesses: [...HARNESSES], home, dryRun: false, exec, launch })
        expect(exec.calls.map((c) => c.req.cmd)).toEqual(['claude', 'claude', 'claude', 'opencode'])
        for (const { req } of exec.calls) {
            for (const k of Object.keys(HOME_BOUND_ENV)) {
                const v = req.env?.[k]
                if (v !== undefined) expect(under(v, home), `${req.cmd} ${k}=${v}`).toBe(true)
                if (v !== undefined) expect(under(v, real), `${req.cmd} ${k}=${v}`).toBe(false)
            }
            expect(req.env?.CLAUDE_CONFIG_DIR).toBe(path.join(home, '.claude'))
        }
    })
})
