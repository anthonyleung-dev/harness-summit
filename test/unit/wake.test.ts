// Unit tests: notice text, wake argv, and the wake decision on the post-append state (REVIEW m2, m3,
// m10): nothing unread → no wake; debounce only while announced mail is unread; exit code decides.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { cliBin } from '../../src/core/exec.js'
import { appendRecord, writeCursor, scanUnread } from '../../src/core/mailbox.js'
import { buildNotice } from '../../src/core/notice.js'
import { shouldSkipWake, wakeCommand, wakeReceiver, WAKE_TIMEOUT_MS } from '../../src/core/wake.js'
import { fakeBin, recordingExec, sampleRecord, tmpDir } from '../helpers/env.js'

const T0 = Date.parse('2026-10-10T00:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '33333333-3333-4333-8333-333333333333'
const ID_C = '44444444-4444-4444-8444-444444444444'

// Purpose: an agent folder holding one unread record stamped `at`.
async function folderWithUnread(at: number): Promise<string> {
    const folder = tmpDir('wake')
    await appendRecord(folder, 'alice', sampleRecord({ at: iso(at) }))
    return folder
}

describe('notice', () => {
    it('builds the exact notice from unread senders', () => {
        expect(buildNotice([])).toBeNull()
        expect(buildNotice([{ from: 'alice' }, { from: 'bob' }, { from: 'alice' }])).toBe(
            '[harness-summit] 3 unread message(s) from alice, bob in your summit group. Call the summit_read tool to read them.',
        )
    })
})

describe('wake argv', () => {
    it('builds the codex and opencode argv exactly, with the recorded binary when install set it', () => {
        expect(wakeCommand({ type: 'codex-queue', threadId: 'T' }, 'N', {})).toEqual({
            cmd: 'codex',
            args: ['queue', '--thread', 'T', '--message', 'N'],
        })
        expect(wakeCommand({ type: 'opencode-prompt', sessionID: 'S' }, 'say "hi"', {})).toEqual({
            cmd: 'opencode',
            args: [
                'api',
                'session.prompt',
                '--param',
                'sessionID=S',
                '-d',
                '{"text":"say \\"hi\\"","delivery":"queue"}',
            ],
        })
        const dir = tmpDir('bin')
        const env = { SUMMIT_CODEX_BIN: fakeBin(dir, 'codex'), SUMMIT_OPENCODE_BIN: fakeBin(dir, 'opencode') }
        expect(wakeCommand({ type: 'codex-queue', threadId: 'T' }, 'N', env)?.cmd).toBe(env.SUMMIT_CODEX_BIN)
        expect(wakeCommand({ type: 'opencode-prompt', sessionID: 'S' }, 'N', env)?.cmd).toBe(env.SUMMIT_OPENCODE_BIN)
        expect(wakeCommand({ type: 'signal', path: '/x' }, 'N')).toBeNull()
    })

    it('falls back to PATH when the recorded binary is gone or not executable (F12)', () => {
        const dir = tmpDir('bin')
        const notExec = path.join(dir, 'opencode')
        fs.writeFileSync(notExec, 'not a program', { mode: 0o644 })
        const env = { SUMMIT_CODEX_BIN: path.join(dir, 'moved-away', 'codex'), SUMMIT_OPENCODE_BIN: notExec }
        expect(cliBin('codex', env)).toBe('codex')
        expect(cliBin('opencode', env)).toBe('opencode')
        expect(wakeCommand({ type: 'codex-queue', threadId: 'T' }, 'N', env)?.cmd).toBe('codex')
    })
})

describe('wake decision', () => {
    it('debounce: skip only inside 10 s of the last wake AND while a record that wake announced is unread', () => {
        const [a, b] = [ID_A, ID_B]
        const last = { at: T0, claim: ID_C, announced: [a] }
        expect(shouldSkipWake([{ id: a }, { id: b }], last, T0 + 9_999)).toBe(true)
        // Everything announced was read; only new mail is unread → wake again (the lost-wake order),
        // whatever its time stamp: a record stamped before the wake but not announced by it is new.
        expect(shouldSkipWake([{ id: b }], last, T0 + 5_000)).toBe(false)
        expect(shouldSkipWake([{ id: a }], last, T0 + 10_000)).toBe(false)
        expect(shouldSkipWake([{ id: a }], last, T0 - 1)).toBe(false)
        expect(shouldSkipWake([{ id: a }], null, T0)).toBe(false)
    })

    it('never wakes with an empty notice: nothing unread after the append → skipped, no command', async () => {
        const folder = tmpDir('wake')
        const exec = recordingExec()
        expect(await wakeReceiver({ folder, wake: { type: 'codex-queue', threadId: 'T' }, exec })).toEqual({
            wake: 'skipped',
        })
        expect(exec.calls).toEqual([])
    })

    it('rings a signal, then debounces while the announced mail is unread, and wakes again after a read', async () => {
        const folder = await folderWithUnread(T0 - 1000)
        const signal = path.join(folder, 'sig')
        const exec = recordingExec()
        const wake = { type: 'signal' as const, path: signal }
        expect(await wakeReceiver({ folder, wake, exec, now: T0 })).toEqual({ wake: 'sent' })
        expect(fs.readFileSync(signal, 'utf8')).toMatch(/Z\n$/)
        await appendRecord(folder, 'bob', sampleRecord({ id: ID_B, from: 'bob', at: iso(T0 + 100) }))
        expect(await wakeReceiver({ folder, wake, exec, now: T0 + 200 })).toEqual({ wake: 'skipped' })
        await writeCursor(folder, (await scanUnread(folder)).nextCursor)
        // Stamped BEFORE the last wake, yet never announced by it: still a new wake.
        await appendRecord(folder, 'bob', sampleRecord({ id: ID_C, from: 'bob', at: iso(T0 - 5) }))
        expect(await wakeReceiver({ folder, wake, exec, now: T0 + 400 })).toEqual({ wake: 'sent' })
    })

    it('waits for the wake command to exit: sent only on exit 0, else failed with a stderr excerpt', async () => {
        const folder = await folderWithUnread(T0)
        const ok = recordingExec()
        expect(
            await wakeReceiver({ folder, wake: { type: 'codex-queue', threadId: 'T' }, exec: ok, now: T0 + 1 }),
        ).toEqual({ wake: 'sent' })
        expect(ok.calls[0]?.timeoutMs).toBe(WAKE_TIMEOUT_MS)
        expect(ok.calls[0]?.req.args).toEqual(['queue', '--thread', 'T', '--message', buildNotice([{ from: 'alice' }])])
        const folder2 = await folderWithUnread(T0)
        const bad = recordingExec({ code: 1, stdout: '', stderr: 'error: no such thread' })
        const out = await wakeReceiver({ folder: folder2, wake: { type: 'codex-queue', threadId: 'T' }, exec: bad })
        expect(out).toEqual({ wake: 'failed', wakeError: 'SUMMIT_EXEC_FAILED: codex exited 1: error: no such thread' })
        const spawnFail = recordingExec(undefined, true)
        expect(
            (await wakeReceiver({ folder: folder2, wake: { type: 'codex-queue', threadId: 'T' }, exec: spawnFail }))
                .wake,
        ).toBe('failed')
        expect(fs.existsSync(path.join(folder2, '.lastwake'))).toBe(false)
    })
})
