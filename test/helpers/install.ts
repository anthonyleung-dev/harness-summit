// Shared fixtures of the install tests: the launch they render with and a stubbed exec that answers the
// read-only Claude checks (claudeMarket.ts) the way an installed Claude Code does. The one copy of each
// (test/unit/test-doors.test.ts fails on a second launch literal).
import type { CaptureResult, ExecRequest } from '../../src/core/exec.js'
import { PLUGIN_ID } from '../../src/core/fixText.js'
import type { Launch } from '../../src/install/render.js'
import { recordingExec, type RecordingExec } from './env.js'

// The launch install tests render with: fixed paths that exist nowhere, so a rendered file never depends on
// the machine.
export const TEST_LAUNCH: Launch = { node: '/usr/bin/node', cli: '/opt/harness-summit/dist/cli.js' }

// Purpose: TEST_LAUNCH with some fields replaced (another CLI path for an "old" release, a launch env).
export function testLaunch(over: Partial<Launch> = {}): Launch {
    return { ...TEST_LAUNCH, ...over }
}

// The argv of the read-only check that the plugin is still installed (checkClaudePlugin).
export const LIST_PLUGINS = ['claude', 'plugin', 'list', '--json']

const OK: CaptureResult = { code: 0, stdout: '', stderr: '' }

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
