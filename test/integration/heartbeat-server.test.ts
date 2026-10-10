// A real MCP server process keeps the heartbeat of the agent it serves fresh with its own timer (SPEC §7),
// with no tool call in between, and the agent reads alive to a second server.
import { describe, expect, it } from 'vitest'

import { BEAT_MS, STALE_MS } from '../../src/core/freshness.js'
import { beatTime } from '../../src/core/heartbeat.js'
import { tmpDir, until } from '../helpers/env.js'
import { McpProc } from '../helpers/mcp.js'
import { ageBeat } from '../helpers/state.js'

describe('server heartbeat timer', () => {
    it('beats its joined agent every few seconds without any tool call', async () => {
        const root = tmpDir('hb')
        const a = McpProc.start({ harness: 'claude', root, viaParent: true })
        const b = McpProc.start({ harness: 'claude', root, viaParent: true })
        try {
            await a.initialize()
            await b.initialize()
            const ja = await a.call('summit_join')
            await b.call('summit_join')
            ageBeat(root, ja.hostKey, STALE_MS * 4)
            const aliveOfA = async () =>
                (await b.call('summit_members')).members.find((m: { uuid: string }) => m.uuid === ja.uuid).alive
            expect(await aliveOfA()).toBe(false)
            await until(async () => Date.now() - ((await beatTime(root, ja.hostKey)) ?? 0) < STALE_MS, BEAT_MS * 3)
            expect(await aliveOfA()).toBe(true)
        } finally {
            await a.close()
            await b.close()
        }
    })
})
