// Acceptance 2: two real MCP server processes with different host keys talk through one root.
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { signalPathFor } from '../../src/core/paths.js'
import { tmpDir } from '../helpers/env.js'
import { McpProc } from '../helpers/mcp.js'

describe('two claude-style servers (distinct ppids via a Node parent)', () => {
    const root = tmpDir('two')
    const execLog = path.join(root, 'exec.log')
    let a: McpProc
    let b: McpProc

    beforeAll(async () => {
        a = McpProc.start({ harness: 'claude', root, viaParent: true, env: { HARNESS_SUMMIT_EXEC_LOG: execLog } })
        b = McpProc.start({ harness: 'claude', root, viaParent: true, env: { HARNESS_SUMMIT_EXEC_LOG: execLog } })
        await a.initialize()
        await b.initialize()
    })
    afterAll(async () => {
        await a.close()
        await b.close()
    })

    it('answers server/discover before initialize without dying (Claude Code K3)', async () => {
        const c = McpProc.start({ harness: 'claude', root })
        const discover = await c.request('server/discover', { protocolVersion: '2026-07-28' })
        expect(discover.error?.code).toBe(-32601)
        const init = await c.initialize()
        expect(init.result.serverInfo.name).toBe('harness-summit')
        const tools = await c.request('tools/list')
        expect(tools.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([
            'summit_bye',
            'summit_group',
            'summit_join',
            'summit_members',
            'summit_read',
            'summit_rename',
            'summit_send',
            'summit_whoami',
        ])
        // OMP checks this schema on the client: `{ to, body }` must pass it (body is an alias of message).
        const sendTool = tools.result.tools.find((t: { name: string }) => t.name === 'summit_send')
        expect(sendTool.inputSchema.required).toEqual(['to'])
        expect(Object.keys(sendTool.inputSchema.properties).sort()).toEqual(['body', 'message', 'replyTo', 'to'])
        // MCP tool annotations: exact per tool, so a missing hint never falls back to the spec defaults
        // (destructive, open world). summit_read marks mail read: never read-only.
        const hints = (r: boolean, d: boolean | null, i: boolean | null, o: boolean) => ({
            readOnlyHint: r,
            ...(d === null ? {} : { destructiveHint: d }),
            ...(i === null ? {} : { idempotentHint: i }),
            openWorldHint: o,
        })
        const annotations = Object.fromEntries(
            tools.result.tools.map((t: { name: string; annotations?: unknown }) => [t.name, t.annotations]),
        )
        expect(annotations).toEqual({
            summit_join: hints(false, false, true, false),
            summit_group: hints(false, true, true, false),
            summit_rename: hints(false, true, true, false),
            summit_send: hints(false, false, false, true),
            summit_read: hints(false, true, false, false),
            summit_members: hints(true, null, null, false),
            summit_whoami: hints(true, null, null, false),
            summit_bye: hints(false, true, true, false),
        })
        await c.close()
    })

    it('runs join, rename, send both ways, read, group move, members, bye', async () => {
        expect(await a.call('summit_whoami')).toMatchObject({ joined: false })
        const ja = await a.call('summit_join')
        const jb = await b.call('summit_join')
        expect(ja.hostKey).toBe(`claude-${a.session}`)
        expect(jb.hostKey).not.toBe(ja.hostKey)
        expect(ja.groupKey).toBe(jb.groupKey)
        expect(ja.groupKey).toMatch(/^[0-9a-f]{32}$/)
        expect((await a.call('summit_join')).alreadyJoined).toBe(true)

        await a.call('summit_rename', { name: 'alice' })
        await b.call('summit_rename', { name: 'bob' })

        const s1 = await a.call('summit_send', { to: '@bob', message: 'please review --- this\n---\nline' })
        expect(s1).toMatchObject({ delivered: true, wake: 'sent', to: { name: 'bob' } })
        const signalB = signalPathFor(root, jb.hostKey)
        expect(fs.readFileSync(signalB, 'utf8')).toMatch(/^\d{4}-\d\d-\d\dT.*Z\n$/)

        const r1 = await b.call('summit_read')
        expect(r1.count).toBe(1)
        expect(r1.messages[0]).toMatchObject({
            id: s1.id,
            from: 'alice',
            body: 'please review --- this\n---\nline',
            replyTo: null,
        })
        expect(r1.messages[0].replyHint).toBe(
            `When the task is done, reply to alice with summit_send({ to: "${ja.uuid}", replyTo: "${s1.id}", message: "<your answer>" }).`,
        )
        expect((await b.call('summit_read')).count).toBe(0)

        // A model that mirrors summit_read's `body` field still sends (OMP, 2026-10-10).
        const s2 = await b.call('summit_send', { to: ja.uuid, body: 'done', replyTo: s1.id })
        expect(s2).toMatchObject({ delivered: true })
        for (const bad of [{ message: 'x', body: 'x' }, {}, { body: '' }]) {
            const err = (await b.call('summit_send', { to: ja.uuid, ...bad })).error
            expect(err).toMatchObject({ code: 'SUMMIT_BAD_INPUT', fn: 'toSendInput' })
            expect(err.message).toMatch(/message.*body/)
        }
        const r2 = await a.call('summit_read')
        expect(r2.messages).toHaveLength(1)
        expect(r2.messages[0]).toMatchObject({ id: s2.id, from: 'bob', replyTo: s1.id, body: 'done' })
        // A reply needs no answer, so it carries no reply hint (D1).
        expect(r2.messages[0]).not.toHaveProperty('replyHint')

        const g = await a.call('summit_group', { name: 'team-x' })
        expect(g).toMatchObject({ moved: true, groupKey: 'team-x', previousGroupKey: ja.groupKey })
        expect(fs.existsSync(path.join(root, 'team-x', ja.uuid, 'agent.json'))).toBe(true)
        expect(fs.existsSync(path.join(root, ja.groupKey, ja.uuid))).toBe(false)
        expect((await b.call('summit_send', { to: '@alice', message: 'x' })).error.code).toBe('SUMMIT_UNKNOWN_TARGET')
        await b.call('summit_group', { name: 'team-x' })

        const m = await a.call('summit_members')
        expect(m.groupKey).toBe('team-x')
        expect(m.members.map((x: { name: string }) => x.name).sort()).toEqual(['alice', 'bob'])
        expect(m.members.every((x: { alive: unknown }) => x.alive === true)).toBe(true)
        expect(m.members.filter((x: { self: boolean }) => x.self).map((x: { name: string }) => x.name)).toEqual([
            'alice',
        ])

        expect(await b.call('summit_bye')).toMatchObject({
            removed: ['name map entry', 'agent folder', 'identity record'],
        })
        expect(await b.call('summit_whoami')).toMatchObject({ joined: false })
        expect((await a.call('summit_send', { to: '@bob', message: 'gone?' })).error.code).toBe('SUMMIT_UNKNOWN_TARGET')
        expect((await a.call('summit_members')).members).toHaveLength(1)
        expect((await b.call('summit_read')).error.code).toBe('SUMMIT_NOT_JOINED')
    })

    it('never writes logs to stdout (every stdout line is JSON-RPC)', async () => {
        expect(a.stderr).toContain('"msg":"server started"')
        expect(a.nonJson).toEqual([])
        expect(b.nonJson).toEqual([])
    })
})
