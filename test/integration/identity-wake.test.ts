// Acceptance 3 and 5 at process level: per-call host keys (OpenCode, Codex) and the wake commands a
// real server spawns (recorded through HARNESS_SUMMIT_EXEC_LOG, so no harness CLI runs).
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildNotice } from '../../src/core/notice.js'
import { codexMeta, opencodeMeta, tmpDir } from '../helpers/env.js'
import { McpProc } from '../helpers/mcp.js'

// Purpose: commands recorded by the servers' exec door.
function recorded(file: string): { mode: string; cmd: string; args: string[] }[] {
    if (!fs.existsSync(file)) return []
    return fs
        .readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
}

describe('per-call identity and wake commands', () => {
    const root = tmpDir('idw')
    const execLog = path.join(root, 'exec.log')
    const env = { HARNESS_SUMMIT_EXEC_LOG: execLog }
    let oc: McpProc
    let cx: McpProc

    beforeAll(async () => {
        oc = McpProc.start({ harness: 'opencode', root, env })
        cx = McpProc.start({ harness: 'codex', root, env })
        await oc.initialize()
        await cx.initialize()
    })
    afterAll(async () => {
        await oc.close()
        await cx.close()
    })

    it('one OpenCode process, two sessionIDs → two agents', async () => {
        const s1 = await oc.call('summit_join', {}, opencodeMeta('ses_one'))
        const s2 = await oc.call('summit_join', {}, opencodeMeta('ses_two'))
        expect(s1.hostKey).toBe('opencode-ses_one')
        expect(s2.hostKey).toBe('opencode-ses_two')
        expect(s1.uuid).not.toBe(s2.uuid)
        expect((await oc.call('summit_whoami', {}, opencodeMeta('ses_one'))).uuid).toBe(s1.uuid)
        const agent = JSON.parse(fs.readFileSync(path.join(s1.folder, 'agent.json'), 'utf8'))
        expect(agent).toMatchObject({ pid: null, wake: { type: 'opencode-prompt', sessionID: 'ses_one' } })
    })

    it('a Codex call without _meta.threadId fails with SUMMIT_NO_HOST_KEY', async () => {
        expect((await cx.call('summit_join')).error.code).toBe('SUMMIT_NO_HOST_KEY')
        expect((await cx.call('summit_whoami', {}, { progressToken: 1 })).error.code).toBe('SUMMIT_NO_HOST_KEY')
    })

    it('wakes codex and opencode receivers with the exact SPEC §6 argv, then debounces', async () => {
        fs.rmSync(execLog, { force: true })
        const cxJoin = await cx.call('summit_join', {}, codexMeta('thread-123', process.cwd()))
        expect(cxJoin.hostKey).toBe('codex-thread-123')
        const agent = JSON.parse(fs.readFileSync(path.join(cxJoin.folder, 'agent.json'), 'utf8'))
        expect(agent).toMatchObject({
            pid: cx.child.pid,
            cwdSource: 'codex-workspaces',
            wake: { type: 'codex-queue', threadId: 'thread-123' },
        })

        await oc.call('summit_rename', { name: 'oc1' }, opencodeMeta('ses_one'))
        await cx.call('summit_rename', { name: 'cx' }, codexMeta('thread-123'))
        fs.rmSync(execLog, { force: true })

        const toCodex = await oc.call('summit_send', { to: '@cx', message: 'hi codex' }, opencodeMeta('ses_one'))
        expect(toCodex.wake).toBe('sent')
        const toOc = await cx.call('summit_send', { to: '@oc1', message: 'hi oc' }, codexMeta('thread-123'))
        expect(toOc.wake).toBe('sent')

        const notice1 = buildNotice([{ from: 'oc1' }])
        const notice2 = buildNotice([{ from: 'cx' }])
        expect(recorded(execLog)).toEqual([
            { mode: 'capture', cmd: 'codex', args: ['queue', '--thread', 'thread-123', '--message', notice1] },
            {
                mode: 'capture',
                cmd: 'opencode',
                args: [
                    'api',
                    'session.prompt',
                    '--param',
                    'sessionID=ses_one',
                    '-d',
                    JSON.stringify({ text: notice2, delivery: 'queue' }),
                ],
            },
        ])

        // Receiver already has unread mail and was woken < 10 s ago: skipped, no new command.
        const again = await oc.call('summit_send', { to: '@cx', message: 'second' }, opencodeMeta('ses_one'))
        expect(again.wake).toBe('skipped')
        expect(recorded(execLog)).toHaveLength(2)

        // After a read, the next send wakes again even inside 10 s.
        expect((await cx.call('summit_read', {}, codexMeta('thread-123'))).count).toBe(2)
        expect((await oc.call('summit_send', { to: '@cx', message: 'third' }, opencodeMeta('ses_one'))).wake).toBe(
            'sent',
        )
        expect(recorded(execLog)).toHaveLength(3)
    })
})
