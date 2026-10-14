// Install, doctor and uninstall with $XDG_CONFIG_HOME and $OPENCODE_CONFIG_DIR (homes.ts opencodeDir, SPEC §8).
// OpenCode 2.0.26 keeps its global config in $OPENCODE_CONFIG_DIR, else $XDG_CONFIG_HOME/opencode, and
// `opencode mcp add --global` writes there. For the real home (a temp dir made the real home with fakeRealHome) install records the registration
// there, writes the commands there, doctor reads there and uninstall removes there; for any other --home
// nothing leaves --home. The stubbed `opencode` writes its key where the real one would (its env decides).
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { ExecRequest } from '../../src/core/exec.js'
import { readTextFile } from '../../src/core/fsx.js'
import { HARNESSES, type Harness } from '../../src/core/schemas.js'
import { doctorReport } from '../../src/install/doctor.js'
import { setJsonKey } from '../../src/install/edits.js'
import { runInstall, runUninstall } from '../../src/install/install.js'
import { renderCommands } from '../../src/install/render.js'
import { loadState } from '../../src/install/state.js'
import { errorCode, fakeRealHome, recordingExec, seededHome, setEnv, snapshot, tmpDir } from '../helpers/env.js'
import { TEST_LAUNCH } from '../helpers/install.js'

const COMMANDS = renderCommands('opencode').map((f) => f.rel)
const KEY = ['mcp', 'servers', 'harness-summit']

let undo: (() => void)[] = []
afterEach(() => {
    for (const u of undo.reverse()) u()
    undo = []
})

// Purpose: a seeded temp home that counts as the real home, with $XDG_CONFIG_HOME set to `xdg` (or unset).
function realHome(xdg: string | undefined): string {
    const home = seededHome()
    undo.push(fakeRealHome(home), setEnv({ XDG_CONFIG_HOME: xdg }))
    return home
}

// Purpose: what `opencode mcp add --global` does, from the env install gives it (OpenCode 2.0.26, read from
// the binary): the config dir is $OPENCODE_CONFIG_DIR when set, else $XDG_CONFIG_HOME/opencode, else
// $HOME/.config/opencode; in it, the first of opencode.json, opencode.jsonc, .opencode/opencode.json and
// .opencode/opencode.jsonc that is a file gets the key, else a new opencode.json.
function fakeOpencode(req: ExecRequest) {
    if (req.cmd === 'opencode') {
        const env = req.env ?? {}
        const dir =
            env.OPENCODE_CONFIG_DIR ||
            path.join(env.XDG_CONFIG_HOME || path.join(env.HOME ?? '', '.config'), 'opencode')
        const candidates = ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']
        const files = candidates.map((c) => path.join(dir, c))
        const file = files.find((f) => fs.existsSync(f) && fs.statSync(f).isFile()) ?? files[0]!
        const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}\n'
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, setJsonKey(text, KEY, { type: 'local' }, file))
    }
    return { code: 0, stdout: '', stderr: '' }
}

// Purpose: run install or uninstall of `harnesses` with the fake opencode.
function run(fn: typeof runInstall, home: string, harnesses: Harness[] = ['opencode']) {
    return fn({ harnesses, home, dryRun: false, exec: recordingExec(fakeOpencode), launch: TEST_LAUNCH })
}

// Purpose: the doctor line of opencode.
async function doctorLine(home: string): Promise<string | undefined> {
    return (await doctorReport(home)).find((l) => l.startsWith('opencode'))
}

describe('real home with $XDG_CONFIG_HOME set', () => {
    it('install records and writes in $XDG_CONFIG_HOME/opencode, doctor reads there, uninstall removes', async () => {
        const xdg = tmpDir('xdg')
        const home = realHome(xdg)
        const dir = path.join(xdg, 'opencode')
        const before = snapshot(path.join(home, '.config'))
        await run(runInstall, home)
        const state = await loadState(home)
        expect(Object.keys(state.edits)).toEqual([path.join(dir, 'opencode.json')])
        for (const rel of COMMANDS) expect(fs.existsSync(path.join(dir, 'commands', rel)), rel).toBe(true)
        expect(snapshot(path.join(home, '.config'))).toEqual(before)
        const line = await doctorLine(home)
        expect(line).toContain(`registered=yes commands=${COMMANDS.length}/${COMMANDS.length}`)
        expect(line).toMatch(new RegExp(` dir=${dir.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`))
        await run(runUninstall, home)
        expect(fs.existsSync(path.join(dir, 'commands'))).toBe(false)
        expect(await readTextFile(path.join(dir, 'opencode.json'))).toBeNull()
        expect(snapshot(path.join(home, '.config'))).toEqual(before)
        expect(await doctorLine(home)).toContain('registered=no  commands=0/')
    })

    it('unset or empty: install writes to <home>/.config/opencode', async () => {
        for (const value of [undefined, '']) {
            const home = realHome(value)
            await run(runInstall, home)
            const dir = path.join(home, '.config', 'opencode')
            expect(Object.keys((await loadState(home)).edits)).toEqual([path.join(dir, 'opencode.jsonc')])
            expect(fs.existsSync(path.join(dir, 'commands', COMMANDS[0]!))).toBe(true)
        }
    })

    it('a relative $XDG_CONFIG_HOME blocks only opencode; doctor errors on the opencode line only', async () => {
        const home = realHome('rel/config')
        const before = snapshot(home)
        expect(await errorCode(run(runInstall, home))).toBe('SUMMIT_BAD_INPUT')
        expect(snapshot(home)).toEqual(before)
        const others = HARNESSES.filter((h) => h !== 'opencode')
        await run(runInstall, home, others)
        const lines = await doctorReport(home)
        expect(lines.filter((l) => l.includes('error=')).map((l) => l.split(' ')[0])).toEqual(['opencode'])
        expect(await doctorLine(home)).toMatch(
            /error=SUMMIT_BAD_INPUT: XDG_CONFIG_HOME is relative.*Install and uninstall/,
        )
        await run(runUninstall, home, others)
        expect(await loadState(home)).toMatchObject({ files: {}, edits: {}, execs: {} })
    })
})

describe('another --home with the caller $XDG_CONFIG_HOME set', () => {
    it('OpenCode paths stay under <home>/.config/opencode; the caller dir stays empty', async () => {
        const caller = tmpDir('caller-xdg')
        undo.push(setEnv({ XDG_CONFIG_HOME: caller }))
        const home = seededHome()
        await run(runInstall, home)
        const dir = path.join(home, '.config', 'opencode')
        expect(Object.keys((await loadState(home)).edits)).toEqual([path.join(dir, 'opencode.jsonc')])
        expect(fs.existsSync(path.join(dir, 'commands', COMMANDS[0]!))).toBe(true)
        expect(fs.readdirSync(caller)).toEqual([])
    })
})

describe('an install recorded in ~/.config/opencode, then $XDG_CONFIG_HOME set', () => {
    // Purpose: a real home with an opencode install in ~/.config/opencode, then XDG_CONFIG_HOME set to `xdg`.
    async function oldInstall(xdg: string) {
        const home = realHome(undefined)
        const original = snapshot(path.join(home, '.config'))
        await run(runInstall, home)
        undo.push(setEnv({ XDG_CONFIG_HOME: xdg }))
        return { home, original }
    }

    it('uninstall removes the old commands and the old registration', async () => {
        const xdg = tmpDir('xdg')
        const { home, original } = await oldInstall(xdg)
        const lines = await run(runUninstall, home)
        expect(lines).toContain(`remove  ${path.join(home, '.config', 'opencode', 'commands', COMMANDS[0]!)}`)
        expect(snapshot(path.join(home, '.config'))).toEqual(original)
        expect(fs.readdirSync(xdg)).toEqual([])
        expect(await loadState(home)).toMatchObject({ files: {}, edits: {} })
    })

    it('install moves the registration: the old files go, the new ones land in $XDG_CONFIG_HOME/opencode', async () => {
        const xdg = tmpDir('xdg')
        const { home, original } = await oldInstall(xdg)
        await run(runInstall, home)
        expect(snapshot(path.join(home, '.config'))).toEqual(original)
        const state = await loadState(home)
        expect(Object.keys(state.edits)).toEqual([path.join(xdg, 'opencode', 'opencode.json')])
        expect(fs.existsSync(path.join(xdg, 'opencode', 'commands', COMMANDS[0]!))).toBe(true)
    })
})

describe('real home with $OPENCODE_CONFIG_DIR set', () => {
    it('wins over $XDG_CONFIG_HOME: registration, commands, doctor and uninstall all use it', async () => {
        const home = realHome(tmpDir('xdg'))
        const dir = tmpDir('ocdir')
        undo.push(setEnv({ OPENCODE_CONFIG_DIR: dir }))
        await run(runInstall, home)
        expect(Object.keys((await loadState(home)).edits)).toEqual([path.join(dir, 'opencode.json')])
        expect(fs.existsSync(path.join(dir, 'commands', COMMANDS[0]!))).toBe(true)
        expect(fs.readdirSync(process.env.XDG_CONFIG_HOME!)).toEqual([])
        const line = await doctorLine(home)
        expect(line).toContain(`registered=yes commands=${COMMANDS.length}/${COMMANDS.length}`)
        expect(line?.endsWith(` dir=${dir}`)).toBe(true)
        await run(runUninstall, home)
        expect(fs.readdirSync(dir)).toEqual([])
    })

    it('empty is ignored; relative blocks only opencode', async () => {
        const home = realHome(undefined)
        undo.push(setEnv({ OPENCODE_CONFIG_DIR: '' }))
        await run(runInstall, home)
        expect(Object.keys((await loadState(home)).edits)).toEqual([
            path.join(home, '.config', 'opencode', 'opencode.jsonc'),
        ])
        undo.push(setEnv({ OPENCODE_CONFIG_DIR: 'rel/oc' }))
        expect(await errorCode(run(runInstall, home))).toBe('SUMMIT_BAD_INPUT')
        expect(await doctorLine(home)).toMatch(/error=SUMMIT_BAD_INPUT: OPENCODE_CONFIG_DIR is relative/)
        await run(runInstall, home, ['codex'])
    })

    it('an install in the XDG dir moves to $OPENCODE_CONFIG_DIR; uninstall from there removes both', async () => {
        const home = realHome(undefined)
        const original = snapshot(path.join(home, '.config'))
        await run(runInstall, home)
        const dir = tmpDir('ocdir')
        undo.push(setEnv({ OPENCODE_CONFIG_DIR: dir }))
        await run(runInstall, home)
        expect(snapshot(path.join(home, '.config'))).toEqual(original)
        expect(Object.keys((await loadState(home)).edits)).toEqual([path.join(dir, 'opencode.json')])
        await run(runUninstall, home)
        expect(fs.readdirSync(dir)).toEqual([])
    })

    it('another --home ignores it and the CLI never gets it', async () => {
        const caller = tmpDir('caller-oc')
        undo.push(setEnv({ OPENCODE_CONFIG_DIR: caller }))
        const home = seededHome()
        const exec = recordingExec(fakeOpencode)
        await runInstall({ harnesses: ['opencode'], home, dryRun: false, exec, launch: TEST_LAUNCH })
        expect(exec.calls.every((c) => c.req.env?.OPENCODE_CONFIG_DIR === undefined)).toBe(true)
        expect(fs.readdirSync(caller)).toEqual([])
    })
})

describe('a config in .opencode/ inside the config dir', () => {
    it('is the file mcp add writes when it is the first that exists; a re-run keeps it, uninstall removes the key', async () => {
        const home = realHome(undefined)
        const dir = path.join(home, '.config', 'opencode')
        fs.rmSync(path.join(dir, 'opencode.jsonc'))
        const nested = path.join(dir, '.opencode', 'opencode.json')
        fs.mkdirSync(path.dirname(nested), { recursive: true })
        fs.writeFileSync(nested, '{ "model": "x" }\n')
        await run(runInstall, home)
        expect(Object.keys((await loadState(home)).edits)).toEqual([nested])
        const again = await run(runInstall, home)
        expect(again.every((l) => l.startsWith('ok '))).toBe(true)
        await run(runUninstall, home)
        expect(fs.readFileSync(nested, 'utf8')).toBe('{ "model": "x" }\n')
    })
})
