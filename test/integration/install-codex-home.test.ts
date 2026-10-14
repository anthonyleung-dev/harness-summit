// Install, doctor and uninstall with $CODEX_HOME (homes.ts codexDir, SPEC §8). For the real home (a temp dir
// made the real home with fakeRealHome) Codex's config.toml and skills go to $CODEX_HOME; for any other
// --home, nothing install writes leaves --home. An install recorded in another Codex home (a 1.0.1 install in
// ~/.codex, before the user set CODEX_HOME) is retired by install and removed by uninstall.
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { isInsideDir } from '../../src/core/project.js'
import { HARNESSES, type Harness } from '../../src/core/schemas.js'
import { doctorReport } from '../../src/install/doctor.js'
import { runInstall, runUninstall } from '../../src/install/install.js'
import { renderCommands } from '../../src/install/render.js'
import { loadState } from '../../src/install/state.js'
import { errorCode, fakeRealHome, recordingExec, seededHome, setEnv, snapshot, tmpDir } from '../helpers/env.js'
import { TEST_LAUNCH } from '../helpers/install.js'

const launch = TEST_LAUNCH
const SKILLS = renderCommands('codex').map((f) => f.rel)

let undo: (() => void)[] = []
afterEach(() => {
    for (const u of undo.reverse()) u()
    undo = []
})

// Purpose: a seeded temp home that counts as the real home, with $CODEX_HOME set to `codexHome` (or unset).
function realHome(codexHome: string | undefined): string {
    const home = seededHome()
    undo.push(fakeRealHome(home), setEnv({ CODEX_HOME: codexHome }))
    return home
}

// Purpose: a path as a literal regex part.
function escape(p: string): string {
    return p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Purpose: run install or uninstall of `harnesses` with a recording exec.
function run(fn: typeof runInstall, home: string, harnesses: Harness[] = ['codex']) {
    return fn({ harnesses: [...harnesses], home, dryRun: false, exec: recordingExec(), launch })
}

describe('real home with $CODEX_HOME set', () => {
    it('install writes config.toml and skills there, doctor sees them, uninstall removes them', async () => {
        const x = path.join(tmpDir('codex-home'), 'codex')
        const home = realHome(x)
        const before = snapshot(path.join(home, '.codex'))
        await run(runInstall, home)
        expect(fs.readFileSync(path.join(x, 'config.toml'), 'utf8')).toContain('[mcp_servers.harness-summit]')
        for (const rel of SKILLS) expect(fs.existsSync(path.join(x, 'skills', rel)), rel).toBe(true)
        expect(snapshot(path.join(home, '.codex'))).toEqual(before)
        const doctor = (await doctorReport(home)).find((l) => l.startsWith('codex '))
        expect(doctor).toContain(`registered=yes commands=${SKILLS.length}/${SKILLS.length}`)
        await run(runUninstall, home)
        expect(fs.existsSync(x)).toBe(false)
        expect(snapshot(path.join(home, '.codex'))).toEqual(before)
        expect((await doctorReport(home)).find((l) => l.startsWith('codex '))).toContain('registered=no  commands=0/')
    })

    it('unset or empty: install writes to <home>/.codex', async () => {
        for (const value of [undefined, '']) {
            const home = realHome(value)
            await run(runInstall, home)
            expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toContain('harness-summit')
            expect(fs.existsSync(path.join(home, '.codex', 'skills', SKILLS[0]!))).toBe(true)
        }
    })

    it('a relative $CODEX_HOME: install refuses and writes nothing, doctor reports it', async () => {
        const home = realHome('rel/codex')
        const before = snapshot(home)
        expect(await errorCode(run(runInstall, home))).toBe('SUMMIT_BAD_INPUT')
        expect(snapshot(home)).toEqual(before)
        const doctor = (await doctorReport(home)).find((l) => l.startsWith('codex '))
        expect(doctor).toMatch(/^codex +error=SUMMIT_BAD_INPUT: CODEX_HOME is relative/)
        expect(doctor).toContain('Install and uninstall of codex both need it fixed')
        expect(doctor).toContain('leave codex out of --harness')
    })

    it('a relative $CODEX_HOME blocks only codex: claude installs and uninstalls, doctor errors on codex only', async () => {
        const home = realHome('rel/codex')
        const others = HARNESSES.filter((h) => h !== 'codex')
        await run(runInstall, home, others)
        const lines = await doctorReport(home)
        const errors = lines.filter((l) => l.includes('error='))
        expect(errors.map((l) => l.split(' ')[0])).toEqual(['codex'])
        expect(lines.find((l) => l.startsWith('claude'))).toMatch(/registered=yes/)
        await run(runUninstall, home, others)
        expect(await loadState(home)).toMatchObject({ files: {}, edits: {}, execs: {} })
    })

    it('doctor names the Codex dir it checked', async () => {
        const x = path.join(tmpDir('codex-home'), 'codex')
        const home = realHome(x)
        expect((await doctorReport(home)).find((l) => l.startsWith('codex '))).toMatch(new RegExp(` dir=${escape(x)}$`))
    })
})

describe('another --home with the caller $CODEX_HOME set', () => {
    it('every path install writes or records is under --home; the caller dir stays empty', async () => {
        const caller = tmpDir('caller-codex')
        undo.push(setEnv({ CODEX_HOME: caller }))
        const home = seededHome()
        await run(runInstall, home, [...HARNESSES])
        const state = await loadState(home)
        const paths = [...Object.keys(state.files), ...Object.keys(state.edits), ...state.dirs]
        expect(paths.length).toBeGreaterThan(0)
        for (const p of paths) expect(isInsideDir(p, home), p).toBe(true)
        expect(Object.keys(state.edits)).toContain(path.join(home, '.codex', 'config.toml'))
        expect(fs.readdirSync(caller)).toEqual([])
    })
})

describe('an install recorded in ~/.codex, then $CODEX_HOME set', () => {
    // Purpose: a real home with a codex install in ~/.codex (as 1.0.1 did), then CODEX_HOME pointed at `x`.
    async function oldInstall(x: string) {
        const home = realHome(undefined)
        const original = snapshot(path.join(home, '.codex'))
        await run(runInstall, home)
        undo.push(setEnv({ CODEX_HOME: x }))
        return { home, original }
    }

    it('uninstall removes the recorded old files and restores the old config.toml', async () => {
        const x = path.join(tmpDir('codex-home'), 'codex')
        const { home, original } = await oldInstall(x)
        const lines = await run(runUninstall, home)
        expect(lines).toContain(`remove  ${path.join(home, '.codex', 'skills', SKILLS[0]!)}`)
        expect(snapshot(path.join(home, '.codex'))).toEqual(original)
        expect(fs.existsSync(x)).toBe(false)
        const state = await loadState(home)
        expect(state.files).toEqual({})
        expect(state.edits).toEqual({})
    })

    it('install moves the registration: the old files go, the new ones land in $CODEX_HOME', async () => {
        const x = path.join(tmpDir('codex-home'), 'codex')
        const { home, original } = await oldInstall(x)
        await run(runInstall, home)
        expect(snapshot(path.join(home, '.codex'))).toEqual(original)
        expect(fs.readFileSync(path.join(x, 'config.toml'), 'utf8')).toContain('[mcp_servers.harness-summit]')
        const state = await loadState(home)
        expect(Object.keys(state.edits)).toEqual([path.join(x, 'config.toml')])
        for (const f of Object.keys(state.files)) expect(isInsideDir(f, x), f).toBe(true)
    })
})
