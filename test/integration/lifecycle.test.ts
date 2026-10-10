// SPEC §7: the server exits 0 on SIGTERM, SIGHUP and stdin end, and never deletes folders on exit.
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'

import { sleep } from '../../src/core/lock.js'
import { codexMeta, fakeBin, tmpDir } from '../helpers/env.js'
import { McpProc } from '../helpers/mcp.js'

describe('server exit', () => {
    for (const how of ['SIGTERM', 'SIGHUP', 'stdin end'] as const) {
        it(`exits 0 on ${how} and keeps the agent folder`, async () => {
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
})

describe('shutdown during a tool call (REVIEW m7)', () => {
    it('answers the running call before it exits on SIGTERM', async () => {
        const root = tmpDir('drain')
        // A fake `codex` that takes 1 s to exit: the send's wake waits for it.
        const bin = fakeBin(root, 'slow-codex', 'sleep 1\nexit 0')
        const p = McpProc.start({ harness: 'codex', root, env: { SUMMIT_CODEX_BIN: bin } })
        await p.initialize()
        const rx = await p.call('summit_join', {}, codexMeta('rx'))
        await p.call('summit_join', {}, codexMeta('tx'))
        const sending = p.call('summit_send', { to: rx.uuid, message: 'hi' }, codexMeta('tx'))
        await sleep(300)
        p.child.kill('SIGTERM')
        expect(await sending).toMatchObject({ delivered: true, wake: 'sent' })
        expect(await p.exited).toEqual({ code: 0, signal: null })
        expect(p.stderr).toContain('"drained":true')
    })
})
