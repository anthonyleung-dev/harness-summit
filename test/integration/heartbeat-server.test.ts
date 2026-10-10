// A real MCP server process keeps the heartbeat of the agent it serves fresh with its own timer (SPEC §7),
// with no tool call in between, and the agent reads alive to a second server.
import { describe, expect, it } from 'vitest'

import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, heartbeatAge } from '../../src/core/heartbeat.js'
import { tmpDir, until } from '../helpers/env.js'
import { McpProc } from '../helpers/mcp.js'
import { ageHeartbeat } from '../helpers/state.js'

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
            ageHeartbeat(ja.folder, HEARTBEAT_STALE_MS * 4)
            const aliveOfA = async () =>
                (await b.call('summit_members')).members.find((m: { uuid: string }) => m.uuid === ja.uuid).alive
            expect(await aliveOfA()).toBe(false)
            await until(
                async () => ((await heartbeatAge(ja.folder)) ?? Infinity) < HEARTBEAT_STALE_MS,
                HEARTBEAT_INTERVAL_MS * 2,
            )
            expect(await aliveOfA()).toBe(true)
        } finally {
            await a.close()
            await b.close()
        }
    })
})
