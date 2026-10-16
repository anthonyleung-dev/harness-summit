// Shared fixtures of the install tests: the launch they render with and a stubbed exec that answers the
// read-only Claude checks (claudeMarket.ts) the way an installed Claude Code does. The one copy of each
// (test/unit/test-doors.test.ts fails on a second launch literal).
import fs from 'node:fs'
import path from 'node:path'

import type { CaptureResult, ExecRequest } from '../../src/core/exec.js'
import { PLUGIN_ID } from '../../src/core/fixText.js'
import { setJsonKey } from '../../src/install/edits.js'
import { OPENCODE_KEY } from '../../src/install/movable.js'
import type { Launch } from '../../src/install/render.js'
import { recordingExec, type RecordingExec } from './env.js'

// The launch install tests render with: fixed paths that exist nowhere, so a rendered file never depends on
// the machine.
export const TEST_LAUNCH: Launch = { node: '/usr/bin/node', cli: '/opt/harness-summit/dist/cli.js' }

// Purpose: TEST_LAUNCH with some fields replaced (another CLI path for an "old" release, a launch env).
export function testLaunch(over: Partial<Launch> = {}): Launch {
    return { ...TEST_LAUNCH, ...over }
}

// A launch an earlier install used: another node (an old nvm version) and another CLI (a dev checkout).
export const OLD_LAUNCH: Launch = testLaunch({
    node: '/opt/nvm/v22/bin/node',
    cli: '/home/dev/harness-summit/dist/cli.js',
})

// The argv of the read-only check that the plugin is still installed (checkClaudePlugin).
export const LIST_PLUGINS = ['claude', 'plugin', 'list', '--json']

const OK: CaptureResult = { code: 0, stdout: '', stderr: '' }

// Purpose: what `opencode mcp add --global [--env K=V]... <name> -- <command...>` does, from the argv and the env
// install gives it (OpenCode 2.0.26, read from the binary; SPEC §8): the config dir is $OPENCODE_CONFIG_DIR
// when set, else $XDG_CONFIG_HOME/opencode, else $HOME/.config/opencode; in it, the first of opencode.json,
// opencode.jsonc, .opencode/opencode.json and .opencode/opencode.jsonc that is a file gets
// `mcp.servers.<name>` = `{ type: "local", command, environment }` (a second run replaces it), else a new
// opencode.json. Every other command answers exit 0.
export function fakeOpencode(req: ExecRequest): CaptureResult {
    if (req.cmd !== 'opencode') return OK
    const env = req.env ?? {}
    const dir =
        env.OPENCODE_CONFIG_DIR || path.join(env.XDG_CONFIG_HOME || path.join(env.HOME ?? '', '.config'), 'opencode')
    const candidates = ['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc']
    const files = candidates.map((c) => path.join(dir, c))
    const file = files.find((f) => fs.existsSync(f) && fs.statSync(f).isFile()) ?? files[0]!
    const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '{}\n'
    const at = req.args.indexOf('--')
    const flags = req.args.slice(0, at)
    const pairs = flags.flatMap((f, i) =>
        flags[i - 1] === '--env' ? [[f.slice(0, f.indexOf('=')), f.slice(f.indexOf('=') + 1)]] : [],
    )
    const server = {
        type: 'local',
        command: req.args.slice(at + 1),
        ...(pairs.length > 0 ? { environment: Object.fromEntries(pairs) } : {}),
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, setJsonKey(text, OPENCODE_KEY, server, file))
    return OK
}

// Purpose: a recording exec where `claude plugin list --json` lists the plugin (`installed`, default true) and
// `claude plugin marketplace list --json` lists no marketplace; every other command answers `other(req)`
// (default: exit 0, no output).
export function claudeExec(other: (req: ExecRequest) => CaptureResult = () => OK, installed = true): RecordingExec {
    return recordingExec((req) => {
        const line = [req.cmd, ...req.args].join(' ')
        if (line === LIST_PLUGINS.join(' ')) {
            return { ...OK, stdout: JSON.stringify(installed ? [{ id: PLUGIN_ID, version: '1.0.1' }] : []) + '\n' }
        }
        if (line === 'claude plugin marketplace list --json') return { ...OK, stdout: '[]\n' }
        return other(req)
    })
}

// Purpose: the argv of each recorded call, without the read-only `--json` list checks.
export function changingArgv(exec: RecordingExec): string[][] {
    return exec.calls.map((c) => [c.req.cmd, ...c.req.args]).filter((a) => a.at(-1) !== '--json')
}
