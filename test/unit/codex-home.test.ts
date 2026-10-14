// The Codex home (homes.ts codexDir): $CODEX_HOME counts only for the real home, and only when set, non-empty
// and absolute; every Codex path install, doctor and uninstall use comes from it (plan.ts).
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { SummitError } from '../../src/core/errors.js'
import { codexDir, isRealHome, opencodeDir } from '../../src/install/homes.js'
import { commandDirFor, registrationFor } from '../../src/install/plan.js'
import { fakeRealHome, REPO, setEnv, sourceFiles, tmpDir } from '../helpers/env.js'

let restore: (() => void) | undefined
afterEach(() => {
    restore?.()
    restore = undefined
})

describe('codexDir', () => {
    it('real home: $CODEX_HOME when set, else <home>/.codex (unset or empty)', () => {
        const home = tmpDir('real')
        restore = fakeRealHome(home)
        const x = path.join(tmpDir('x'), 'codex')
        expect(codexDir(home, { CODEX_HOME: x })).toBe(x)
        expect(codexDir(home, {})).toBe(path.join(home, '.codex'))
        expect(codexDir(home, { CODEX_HOME: '' })).toBe(path.join(home, '.codex'))
    })

    it('another --home: always <home>/.codex, whatever the caller env says', () => {
        const home = tmpDir('temp')
        expect(codexDir(home, { CODEX_HOME: path.join(tmpDir('caller'), 'codex') })).toBe(path.join(home, '.codex'))
    })

    it('real home: a relative $CODEX_HOME is refused with a structured error', () => {
        const home = tmpDir('real')
        restore = fakeRealHome(home)
        let err: unknown
        try {
            codexDir(home, { CODEX_HOME: 'rel/codex' })
        } catch (e) {
            err = e
        }
        expect(err).toBeInstanceOf(SummitError)
        expect((err as SummitError).code).toBe('SUMMIT_BAD_INPUT')
        expect((err as SummitError).fn).toBe('codexDir')
        expect((err as SummitError).inputs).toEqual({
            home,
            harness: 'codex',
            variable: 'CODEX_HOME',
            value: 'rel/codex',
        })
    })

    it('the config file and the skills dir of the plan both follow it', () => {
        const home = tmpDir('real')
        restore = fakeRealHome(home)
        const x = path.join(tmpDir('x'), 'codex')
        const undo = setEnv({ CODEX_HOME: x })
        try {
            expect(registrationFor(home, 'codex', '').file).toBe(path.join(x, 'config.toml'))
            expect(commandDirFor(home, 'codex')).toBe(path.join(x, 'skills'))
        } finally {
            undo()
        }
    })
})

describe('opencodeDir', () => {
    it('real home: $XDG_CONFIG_HOME/opencode when set, else <home>/.config/opencode (unset or empty)', () => {
        const home = tmpDir('real')
        restore = fakeRealHome(home)
        const x = tmpDir('xdg')
        expect(opencodeDir(home, { XDG_CONFIG_HOME: x })).toBe(path.join(x, 'opencode'))
        expect(opencodeDir(home, {})).toBe(path.join(home, '.config', 'opencode'))
        expect(opencodeDir(home, { XDG_CONFIG_HOME: '' })).toBe(path.join(home, '.config', 'opencode'))
    })

    it('real home: $OPENCODE_CONFIG_DIR wins over $XDG_CONFIG_HOME when set and non-empty', () => {
        const home = tmpDir('real')
        restore = fakeRealHome(home)
        const oc = tmpDir('oc')
        const xdg = tmpDir('xdg')
        expect(opencodeDir(home, { OPENCODE_CONFIG_DIR: oc, XDG_CONFIG_HOME: xdg })).toBe(oc)
        expect(opencodeDir(home, { OPENCODE_CONFIG_DIR: '', XDG_CONFIG_HOME: xdg })).toBe(path.join(xdg, 'opencode'))
        expect(() => opencodeDir(home, { OPENCODE_CONFIG_DIR: 'rel', XDG_CONFIG_HOME: xdg })).toThrow(
            expect.objectContaining({
                code: 'SUMMIT_BAD_INPUT',
                inputs: expect.objectContaining({ variable: 'OPENCODE_CONFIG_DIR' }),
            }),
        )
        // A relative XDG_CONFIG_HOME does not matter when OPENCODE_CONFIG_DIR decides.
        expect(opencodeDir(home, { OPENCODE_CONFIG_DIR: oc, XDG_CONFIG_HOME: 'rel' })).toBe(oc)
        expect(opencodeDir(tmpDir('temp'), { OPENCODE_CONFIG_DIR: oc })).not.toBe(oc)
    })

    it('another --home: always <home>/.config/opencode', () => {
        const home = tmpDir('temp')
        expect(opencodeDir(home, { XDG_CONFIG_HOME: tmpDir('caller') })).toBe(path.join(home, '.config', 'opencode'))
    })

    it('real home: a relative $XDG_CONFIG_HOME is refused for opencode only', () => {
        const home = tmpDir('real')
        restore = fakeRealHome(home)
        const undoEnv = setEnv({ XDG_CONFIG_HOME: 'rel/config', CODEX_HOME: 'rel/codex' })
        try {
            expect(() => opencodeDir(home)).toThrow(
                expect.objectContaining({ code: 'SUMMIT_BAD_INPUT', fn: 'opencodeDir' }),
            )
            expect(() => commandDirFor(home, 'opencode')).toThrow(/XDG_CONFIG_HOME is relative/)
            expect(() => commandDirFor(home, 'codex')).toThrow(/CODEX_HOME is relative/)
            for (const h of ['claude', 'pi', 'omp'] as const) expect(commandDirFor(home, h)).toContain(home)
            expect(registrationFor(home, 'omp').file).toBe(path.join(home, '.omp', 'agent', 'mcp.json'))
        } finally {
            undoEnv()
        }
    })
})

describe('isRealHome', () => {
    it('compares through samePath: letter case does not count on Windows, does on Linux', () => {
        expect(isRealHome('C:\\users\\bob', 'win32', 'C:\\Users\\Bob')).toBe(true)
        expect(isRealHome('c:/Users/Bob/', 'win32', 'C:\\Users\\Bob')).toBe(true)
        expect(isRealHome('/home/Bob', 'linux', '/home/bob')).toBe(false)
        expect(isRealHome('/home/bob/', 'linux', '/home/bob')).toBe(true)
    })
})

describe('one door for the Codex and OpenCode config dirs', () => {
    it('no source file but homes.ts names the .codex or .config dir or reads CODEX_HOME, XDG_CONFIG_HOME or OPENCODE_CONFIG_DIR', () => {
        const src = path.join(REPO, 'src')
        const raw =
            /['"`]\.(codex|config)['"`/\\]|env\.(CODEX_HOME|XDG_CONFIG_HOME|OPENCODE_CONFIG_DIR)|env\[['"](CODEX_HOME|XDG_CONFIG_HOME|OPENCODE_CONFIG_DIR)['"]\]/
        const hits = sourceFiles(src).filter((f) => f !== path.join(src, 'install', 'homes.ts'))
        expect(hits.filter((f) => raw.test(fs.readFileSync(f, 'utf8')))).toEqual([])
        expect(raw.test(fs.readFileSync(path.join(src, 'install', 'homes.ts'), 'utf8'))).toBe(true)
    })
})
