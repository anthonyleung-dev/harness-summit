// A path install owns that the user replaced with the other type (a file where install made a dir, a dir
// where it wrote a file) is the user's now (inTheWay.ts): install and uninstall keep it, report it once (the
// shallowest blocker), forget its record and finish every other action. Uninstall also goes on past an action
// that fails, reports it as a `fail` line, keeps its record, and the CLI then exits 1.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import type { Harness } from '../../src/core/schemas.js'
import { doctorReport } from '../../src/install/doctor.js'
import { runInstall, runUninstall } from '../../src/install/install.js'
import { loadState, stateFile } from '../../src/install/state.js'
import { recordingExec, runCli, seededHome, snapshot, tmpDir } from '../helpers/env.js'
import { TEST_LAUNCH } from '../helpers/install.js'

// Purpose: run install or uninstall of one harness in `home` with a recording exec.
function run(fn: typeof runInstall, home: string, harness: Harness) {
    return fn({ harnesses: [harness], home, dryRun: false, exec: recordingExec(), launch: TEST_LAUNCH })
}

// Purpose: the files of `home` (snapshot) without the install state file, which a kept dir record keeps.
function userFiles(home: string): Record<string, string> {
    const { [STATE_REL]: _state, ...rest } = snapshot(home).files
    return rest
}

const STATE_REL = '.local/share/harness-summit/install-state.json'

// Purpose: the report lines that start with `prefix`.
function linesOf(lines: string[], prefix: string): string[] {
    return lines.filter((l) => l.startsWith(prefix))
}

describe('a skill dir the user replaced with a file (4a)', () => {
    it('install keeps it once and goes on; doctor counts it missing; uninstall finishes', async () => {
        const home = seededHome()
        const original = snapshot(home)
        await run(runInstall, home, 'codex')
        const sj = path.join(home, '.codex', 'skills', 'sj')
        fs.rmSync(sj, { recursive: true })
        fs.writeFileSync(sj, 'u\n')
        const lines = await run(runInstall, home, 'codex')
        expect(linesOf(lines, 'keep')).toEqual([`keep    ${sj} (user's file in the way)`])
        expect(fs.readFileSync(sj, 'utf8')).toBe('u\n')
        expect((await loadState(home)).files[path.join(sj, 'SKILL.md')]).toBeUndefined()
        expect((await doctorReport(home)).find((l) => l.startsWith('codex'))).toContain('commands=9/10')
        const un = await run(runUninstall, home, 'codex')
        expect(linesOf(un, 'fail')).toEqual([])
        // Only the dir install created that now holds the user's file stays recorded (removed once empty).
        expect(await loadState(home)).toMatchObject({ files: {}, edits: {}, execs: {}, dirs: [path.dirname(sj)] })
        expect(userFiles(home)).toEqual({ ...original.files, '.codex/skills/sj': 'u\n' })
    })
})

describe('the whole skills/ dir replaced with a file', () => {
    it('install and uninstall report it once (not once per skill) and finish the registration', async () => {
        const home = seededHome()
        await run(runInstall, home, 'codex')
        const skills = path.join(home, '.codex', 'skills')
        fs.rmSync(skills, { recursive: true })
        fs.writeFileSync(skills, 'mine\n')
        const keep = `keep    ${skills} (user's file in the way)`
        expect(linesOf(await run(runInstall, home, 'codex'), 'keep')).toEqual([keep])
        const un = await run(runUninstall, home, 'codex')
        expect(linesOf(un, 'keep')).toEqual([keep])
        expect(linesOf(un, 'fail')).toEqual([])
        expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).not.toContain('harness-summit')
        expect(fs.readFileSync(skills, 'utf8')).toBe('mine\n')
        expect(fs.existsSync(stateFile(home))).toBe(false)
    })
})

describe('an opencode command file the user replaced with a dir (4b)', () => {
    // Purpose: an opencode install whose sg.md is now a dir.
    async function replaced(): Promise<{ home: string; sg: string; original: ReturnType<typeof snapshot> }> {
        const home = seededHome()
        const original = snapshot(home)
        await run(runInstall, home, 'opencode')
        const sg = path.join(home, '.config', 'opencode', 'commands', 'sg.md')
        fs.rmSync(sg)
        fs.mkdirSync(sg)
        return { home, sg, original }
    }

    it('uninstall keeps the dir, removes everything else, and records only the dir that holds it', async () => {
        const { home, sg, original } = await replaced()
        const un = await run(runUninstall, home, 'opencode')
        expect(linesOf(un, 'keep')).toEqual([`keep    ${sg} (user's dir in the way)`])
        expect(linesOf(un, 'fail')).toEqual([])
        const commands = path.dirname(sg)
        expect(await loadState(home)).toMatchObject({ files: {}, edits: {}, execs: {}, dirs: [commands] })
        expect(userFiles(home)).toEqual(original.files)
        expect(fs.statSync(sg).isDirectory()).toBe(true)
    })

    it('install keeps the dir and goes on; a second uninstall run has nothing left to do', async () => {
        const { home, sg } = await replaced()
        const lines = await run(runInstall, home, 'opencode')
        expect(linesOf(lines, 'keep')).toEqual([`keep    ${sg} (user's dir in the way)`])
        expect(fs.statSync(sg).isDirectory()).toBe(true)
        await run(runUninstall, home, 'opencode')
        expect(await run(runUninstall, home, 'opencode')).toEqual([])
    })
})

// chmod does not stop the owner on Windows, nor root anywhere.
const canDenyRead = process.platform !== 'win32' && process.getuid?.() !== 0

describe.skipIf(!canDenyRead)('uninstall when one action fails', () => {
    it('runs every other action, reports the failure, keeps its record, exits 1; a re-run finishes', async () => {
        const home = seededHome()
        const env = { HARNESS_SUMMIT_HOME: tmpDir('root'), HARNESS_SUMMIT_EXEC_LOG: path.join(tmpDir('x'), 'l') }
        expect((await runCli(['install', '--harness', 'codex', '--home', home], { env })).code).toBe(0)
        const locked = path.join(home, '.codex', 'skills', 'sg', 'SKILL.md')
        fs.chmodSync(locked, 0o000)
        const un = await runCli(['uninstall', '--harness', 'codex', '--home', home], { env })
        fs.chmodSync(locked, 0o644)
        expect(un.code).toBe(1)
        expect(un.stdout).toContain(`fail    ${locked}: SUMMIT_IO: cannot read ${locked}`)
        expect(fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).not.toContain('harness-summit')
        expect(fs.existsSync(path.join(home, '.codex', 'skills', 'sj'))).toBe(false)
        const state = await loadState(home)
        expect(Object.keys(state.files)).toEqual([locked])
        expect(state.edits).toEqual({})
        const again = await runCli(['uninstall', '--harness', 'codex', '--home', home], { env })
        expect(again.code).toBe(0)
        expect(fs.existsSync(stateFile(home))).toBe(false)
    })
})
