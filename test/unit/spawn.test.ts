// Unit tests for the spawn door on Windows (XPLAT-AUDIT B4, D12-D15), run on every OS: PATHEXT lookup,
// the cmd.exe line for a `.cmd` shim with the OpenCode JSON payload, and a real spawn of a fake CLI
// through the door (on Windows that is a `.cmd` shim, so the cmd.exe path runs for real in CI).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { defaultExec, findOnPath, isExecutable, resolveCommand, spawnPlan } from '../../src/core/exec.js'
import { wakeCommand } from '../../src/core/wake.js'
import { batchCommandLine, cmdArgs, escapeCmdArg } from '../../src/core/winCmd.js'
import { fakeBin, tmpDir } from '../helpers/env.js'
import { argvThroughShim } from '../helpers/wincmd.js'

const WIN_ENV = { PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }
const NOTICE =
    '[harness-summit] 2 unread message(s) from alice, bob-2 in your summit group. Call the summit_read tool to read them.'

// Arguments that are hard for cmd.exe and the C runtime parser, none of them refused.
const HARD = ['a "quoted" word', 'back\\slash\\', 'tail\\"', '& | < > ( ) ^ ;, * ?', '']

// Purpose: the opencode wake argv of SPEC §6 for one notice.
const opencodeArgs = (notice: string) => wakeCommand({ type: 'opencode-prompt', sessionID: 'ses_A1' }, notice, {})!.args

describe('PATHEXT lookup (win32 rules, any OS)', () => {
    it('finds codex.cmd and opencode.exe for bare names; a file without a PATHEXT extension is not executable', () => {
        const dir = tmpDir('pathext')
        for (const f of ['codex.cmd', 'opencode.exe', 'git']) fs.writeFileSync(path.join(dir, f), '')
        const env = { ...WIN_ENV, PATH: `C:\\nowhere;${dir}` }
        expect(findOnPath('codex', env.PATH, 'win32', env)).toBe(path.join(dir, 'codex.cmd'))
        expect(findOnPath('opencode', env.PATH, 'win32', env)).toBe(path.join(dir, 'opencode.exe'))
        expect(findOnPath('git', env.PATH, 'win32', env)).toBeNull()
        expect(isExecutable(path.join(dir, 'git'), 'win32', env)).toBe(false)
        expect(isExecutable(path.join(dir, 'codex.cmd'), 'win32', env)).toBe(true)
        expect(resolveCommand('codex', env, 'win32')).toBe(path.join(dir, 'codex.cmd'))
        // A recorded path without its extension (SUMMIT_CODEX_BIN=...\codex) still finds the shim.
        expect(resolveCommand(path.join(dir, 'codex'), env, 'win32')).toBe(path.join(dir, 'codex.cmd'))
    })
})

describe('cmd.exe line for a .cmd shim', () => {
    it('builds the exact /d /v:off /s /c line with an absolute cmd.exe and runs .exe files directly', () => {
        const dir = tmpDir('plan')
        const shim = path.join(dir, 'opencode.cmd')
        fs.writeFileSync(shim, '')
        const plan = spawnPlan(shim, ['api', '-d', '{"text":"a b"}'], WIN_ENV, 'win32')
        expect(plan).toEqual({
            file: WIN_ENV.ComSpec,
            args: [
                '/d',
                '/v:off',
                '/s',
                '/c',
                `""${shim}" ^^^"api^^^" ^^^"-d^^^" ^^^"{\\^^^"text\\^^^":\\^^^"a^^^ b\\^^^"}^^^""`,
            ],
            verbatim: true,
        })
        const exe = path.join(dir, 'opencode.exe')
        fs.writeFileSync(exe, '')
        expect(spawnPlan(exe, ['x'], WIN_ENV, 'win32')).toEqual({ file: exe, args: ['x'], verbatim: false })
        // No usable ComSpec: the absolute cmd.exe under SystemRoot, never the bare name.
        const noComspec = { PATHEXT: WIN_ENV.PATHEXT, ComSpec: 'cmd.exe', SystemRoot: 'D:\\Win' }
        expect(spawnPlan(shim, ['x'], noComspec, 'win32').file).toBe('D:\\Win\\System32\\cmd.exe')
    })

    it('never hands a bare name to libuv: not found is a structured ENOENT; relative PATH entries are skipped', () => {
        const dir = tmpDir('rel')
        fs.writeFileSync(path.join(dir, 'git.exe'), '')
        const cwd = process.cwd()
        process.chdir(dir)
        try {
            const env = { ...WIN_ENV, PATH: '.;bin' }
            expect(resolveCommand('git', env, 'win32')).toBeNull()
            expect(() => spawnPlan('git', ['rev-parse'], env, 'win32')).toThrow(
                expect.objectContaining({ code: 'SUMMIT_EXEC_FAILED', message: expect.stringContaining('not found') }),
            )
            // On this OS too: a relative PATH entry is skipped, an absolute one is searched.
            const tool = fakeBin(dir, 'tool')
            expect(findOnPath('tool', `.${path.delimiter}bin`)).toBeNull()
            expect(findOnPath('tool', dir)).toBe(tool)
        } finally {
            process.chdir(cwd)
        }
    })

    it('the opencode JSON payload and the codex notice reach the program behind the shim unchanged', () => {
        // `%` and `!` are refused (next test): cmd.exe expands them before any escape applies.
        const cases = [
            opencodeArgs(NOTICE),
            ['queue', '--thread', 'T-1', '--message', NOTICE],
            ['api', '-d', JSON.stringify({ text: HARD.join(' '), delivery: 'queue' })],
            HARD,
        ]
        for (const args of cases) {
            expect(argvThroughShim(cmdArgs('C:\\npm\\opencode.cmd', args))).toEqual(args)
        }
    })

    it('refuses what cmd.exe cannot carry: %, !, a line break, a quote or % in the shim path', () => {
        for (const bad of ['a\nb', '%PATH%', '%PATH:C=Z%', '!USERNAME!', 'x!y', '50%'])
            expect(() => escapeCmdArg(bad)).toThrow(expect.objectContaining({ code: 'SUMMIT_BAD_INPUT' }))
        expect(() => batchCommandLine('C:\\%TEMP%\\x.cmd', [])).toThrow(
            expect.objectContaining({ code: 'SUMMIT_BAD_INPUT' }),
        )
        expect(() => batchCommandLine('C:\\a!b\\x.cmd', [])).toThrow(
            expect.objectContaining({ code: 'SUMMIT_BAD_INPUT' }),
        )
        expect(() => batchCommandLine('C:\\x"y.cmd', [])).toThrow(expect.objectContaining({ code: 'SUMMIT_BAD_INPUT' }))
    })
})

describe('real spawn through the door (a .cmd shim through the real cmd.exe on Windows)', () => {
    const bin = fakeBin(tmpDir('echo'), 'echo-args', 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')

    for (const [what, args] of [
        ['the opencode wake argv', opencodeArgs(NOTICE)],
        ['the codex wake argv', ['queue', '--thread', 'T-1', '--message', NOTICE]],
        ['a JSON payload of hard text', ['api', '-d', JSON.stringify({ text: HARD.join(' '), delivery: 'queue' })]],
        ['hard arguments', HARD],
    ] as const) {
        it(`a fake CLI receives ${what} byte for byte`, async () => {
            const res = await defaultExec.capture({ cmd: bin, args: [...args] }, 15_000)
            expect(res.code).toBe(0)
            expect(JSON.parse(res.stdout)).toEqual(args)
        })
    }

    it('a refused argument (Windows) or a missing CLI (every OS) fails as SUMMIT_EXEC_FAILED or SUMMIT_BAD_INPUT, never runs', async () => {
        const missing = defaultExec.capture({ cmd: 'harness-summit-no-such-cli', args: [] }, 5_000)
        await expect(missing).rejects.toMatchObject({ code: 'SUMMIT_EXEC_FAILED' })
        if (process.platform === 'win32') {
            await expect(defaultExec.capture({ cmd: bin, args: ['%PATH%'] }, 5_000)).rejects.toMatchObject({
                code: 'SUMMIT_BAD_INPUT',
            })
        }
    })
})
