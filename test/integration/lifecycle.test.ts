// SPEC §7: the server exits 0 on SIGTERM, SIGHUP and stdin end, and never deletes folders on exit. The
// signal cases run off Windows only: there `child.kill(signal)` terminates the process at once, with no
// handler (Node docs, subprocess.kill), so only the stdin-end path can drain (XPLAT-AUDIT D21).
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

import { sleep } from '../../src/core/freshness.js'
import { codexMeta, fakeBin, tmpDir } from '../helpers/env.js'
import { McpProc } from '../helpers/mcp.js'

const POSIX = process.platform !== 'win32'

// Why a case does not run on Windows (written reason per case; every skipped case has one):
// - SIGHUP: Windows has no SIGHUP, and the server does not listen for it there (exitSignals).
// - SIGTERM: on Windows `child.kill('SIGTERM')` terminates the child at once (TerminateProcess), with no
//   handler, so there is nothing to drain; the hard kill is covered by the Windows-only case below.
// The stdin-end cases run on every OS: that is the path a harness uses to stop a server on Windows (the
// MCP SDK client ends stdin first and kills 2 s later).
const runsHere = (how: 'SIGTERM' | 'SIGHUP' | 'stdin end') => POSIX || how === 'stdin end'

describe('server exit', () => {
    for (const how of ['SIGTERM', 'SIGHUP', 'stdin end'] as const) {
        it.runIf(runsHere(how))(`exits 0 on ${how} and keeps the agent folder`, async () => {
            const root = tmpDir('exit')
            const p = McpProc.start({ harness: 'claude', root })
            await p.initialize()
            const j = await p.call('summit_join')
            if (how === 'stdin end') p.child.stdin.end()
            else p.child.kill(how)
            expect(await p.exited).toEqual({ code: 0, signal: null })
            expect(fs.existsSync(j.folder)).toBe(true)
            expect(p.stderr).toContain(`"why":"${how}"`)
        })
    }

    it.runIf(!POSIX)('Windows: SIGTERM is a hard kill; nothing drains, and the agent folder stays', async () => {
        const root = tmpDir('hardkill')
        const p = McpProc.start({ harness: 'claude', root })
        await p.initialize()
        const j = await p.call('summit_join')
        p.child.kill('SIGTERM')
        await p.exited
        expect(p.stderr).not.toContain('"msg":"exiting"')
        expect(fs.existsSync(j.folder)).toBe(true)
    })
})

describe('shutdown during a tool call (REVIEW m7)', () => {
    for (const how of ['SIGTERM', 'stdin end'] as const) {
        it.runIf(runsHere(how))(`answers the running call before it exits on ${how}`, async () => {
            const root = tmpDir('drain')
            // A fake `codex` that takes 1 s to exit: the send's wake waits for it.
            const bin = fakeBin(root, 'slow-codex', 'setTimeout(() => process.exit(0), 1000)')
            const p = McpProc.start({ harness: 'codex', root, env: { SUMMIT_CODEX_BIN: bin } })
            await p.initialize()
            const rx = await p.call('summit_join', {}, codexMeta('rx'))
            await p.call('summit_join', {}, codexMeta('tx'))
            const sending = p.call('summit_send', { to: rx.uuid, message: 'hi' }, codexMeta('tx'))
            await sleep(300)
            if (how === 'stdin end') p.child.stdin.end()
            else p.child.kill(how)
            expect(await sending).toMatchObject({ delivered: true, wake: 'sent' })
            expect(await p.exited).toEqual({ code: 0, signal: null })
            expect(p.stderr).toContain('"drained":true')
        })
    }
})
