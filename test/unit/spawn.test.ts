// Unit tests for the spawn door on Windows (XPLAT-AUDIT B4, D12-D15), run on every OS: PATHEXT lookup,
// the cmd.exe line for a `.cmd` shim with the OpenCode JSON payload, and a real spawn of a fake CLI
// through the door (on Windows that is a `.cmd` shim, so the cmd.exe path runs for real in CI).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { defaultExec, findOnPath, isExecutable, resolveCommand, spawnPlan } from '../../src/core/exec.js'
import { wakeCommand } from '../../src/core/wake.js'
import { batchCommandLine, escapeCmdArg } from '../../src/core/winCmd.js'
import { fakeBin, tmpDir } from '../helpers/env.js'
import { argvThroughShim } from '../helpers/wincmd.js'

const WIN_ENV = { PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\system32\\cmd.exe' }
const NOTICE =
    '[harness-summit] 2 unread message(s) from alice, bob-2 in your summit group. Call the summit_read tool to read them.'

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
    it('builds the exact /d /s /c line and runs .exe files directly', () => {
        const dir = tmpDir('plan')
        const shim = path.join(dir, 'opencode.cmd')
        fs.writeFileSync(shim, '')
        const plan = spawnPlan(shim, ['api', '-d', '{"text":"a b"}'], WIN_ENV, 'win32')
        expect(plan).toEqual({
            file: WIN_ENV.ComSpec,
            args: [
                '/d',
                '/s',
                '/c',
                `""${shim}" ^^^"api^^^" ^^^"-d^^^" ^^^"{\\^^^"text\\^^^":\\^^^"a^^^ b\\^^^"}^^^""`,
            ],
            verbatim: true,
        })
        const exe = path.join(dir, 'opencode.exe')
        fs.writeFileSync(exe, '')
        expect(spawnPlan(exe, ['x'], WIN_ENV, 'win32')).toEqual({ file: exe, args: ['x'], verbatim: false })
        expect(spawnPlan(shim, ['x'], WIN_ENV, 'linux')).toEqual({ file: shim, args: ['x'], verbatim: false })
    })

    it('the opencode JSON payload and the codex notice reach the program behind the shim unchanged', () => {
        // `%` and `!` are left out: cmd.exe may expand them, a documented limit (src/core/winCmd.ts).
        const hard = ['a "quoted" word', 'back\\slash\\', 'tail\\"', '& | < > ( ) ^ ;, * ?', '']
        const cases = [
            opencodeArgs(NOTICE),
            ['queue', '--thread', 'T-1', '--message', NOTICE],
            ['api', '-d', JSON.stringify({ text: hard.join(' '), delivery: 'queue' })],
            hard,
        ]
        for (const args of cases) {
            const line = spawnPlan('C:\\npm\\opencode.cmd', args, WIN_ENV, 'win32').args
            expect(argvThroughShim(line)).toEqual(args)
        }
    })

    it('refuses what cmd.exe cannot carry: a line break in an argument, a quote in the shim path', () => {
        expect(() => escapeCmdArg('a\nb')).toThrow(expect.objectContaining({ code: 'SUMMIT_BAD_INPUT' }))
        expect(() => batchCommandLine('C:\\x"y.cmd', [])).toThrow(expect.objectContaining({ code: 'SUMMIT_BAD_INPUT' }))
    })
})

describe('real spawn through the door', () => {
    it('a fake CLI receives the opencode argv byte for byte (a .cmd shim on Windows)', async () => {
        const bin = fakeBin(tmpDir('echo'), 'echo-args', 'process.stdout.write(JSON.stringify(process.argv.slice(2)))')
        const args = opencodeArgs(NOTICE)
        const res = await defaultExec.capture({ cmd: bin, args }, 15_000)
        expect(res.code).toBe(0)
        expect(JSON.parse(res.stdout)).toEqual(args)
    })
})
