// The pi/OMP extension end to end with a fake extension API: pi registers the MCP server with its session
// id, OMP records its session for its server, both arm the session's signal via the CLI, wake on a real
// send, and deliver in the pi parent-wake shape (with dedupe and busy followUp) and the OMP followUp shape.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import harnessSummit, { parseArmed } from '../../adapters/pi-omp/harness-summit.js'
import { sleep } from '../../src/core/freshness.js'
import { buildNotice } from '../../src/core/notice.js'
import { join } from '../../src/flows/join.js'
import { whoami } from '../../src/flows/query.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { callFor, tmpRoot, until } from '../helpers/env.js'

type Call = [string, ...unknown[]]

// Purpose: a fake pi/OMP extension API that records handlers and deliveries.
function fakeApi(withRegisterMcp: boolean) {
    const handlers: Record<string, (e: unknown, c: unknown) => unknown> = {}
    const calls: Call[] = []
    const registered: unknown[][] = []
    const api: Record<string, unknown> = {
        on: (name: string, fn: (e: unknown, c: unknown) => unknown) => (handlers[name] = fn),
        sendMessage: (...a: unknown[]) => calls.push(['sendMessage', ...a]),
        sendUserMessage: (...a: unknown[]) => calls.push(['sendUserMessage', ...a]),
        ...(withRegisterMcp ? { registerMcpServer: (...a: unknown[]) => registered.push(a) } : {}),
    }
    return { api, handlers, calls, registered }
}

const notice = buildNotice([{ from: 'alice' }])

describe('pi/OMP extension', () => {
    const root = tmpRoot()
    const sender = callFor(root, 'claude')
    const piHost = callFor(root, 'pi', { session: 'S-pi-ext' })
    // OMP's server is a child of the OMP process: here the extension runs in this process.
    const ompOld = callFor(root, 'omp', { hostPid: process.pid, session: 'S-omp-old' })
    const pi = fakeApi(true)
    const omp = fakeApi(false)
    let idle = true
    // Purpose: a fake extension context for one session.
    const ctxOf = (sessionId: string) => ({
        hasUI: true,
        isIdle: () => idle,
        sessionManager: { getSessionId: () => sessionId },
    })
    const ctx = ctxOf('S-pi-ext')

    beforeAll(async () => {
        await join(sender)
        await rename(sender, 'alice')
        await join(piHost)
        await join(ompOld)
        harnessSummit(pi.api)
        harnessSummit(omp.api)
        expect(omp.handlers.session_switch).toBeDefined()
        expect(pi.handlers.session_switch).toBeUndefined()
        await pi.handlers.session_start!({}, ctx)
        await omp.handlers.session_switch!({}, ctxOf('S-omp'))
    })
    afterAll(() => {
        pi.handlers.session_shutdown!({}, ctx)
        omp.handlers.session_shutdown!({}, ctx)
    })

    it('pi registers the MCP server for the session; OMP records its session for its server', async () => {
        expect(pi.registered).toEqual([
            [
                'harness-summit',
                {
                    command: 'node',
                    args: [expect.stringMatching(/cli\.js$/), 'mcp', '--harness', 'pi'],
                    env: { SUMMIT_SESSION_ID: 'S-pi-ext' },
                    exposure: 'direct',
                },
            ],
        ])
        expect(omp.registered).toEqual([])
        // session_switch (OMP /new) recorded S-omp for this process: its server now serves a new agent.
        expect(await whoami(ompOld)).toEqual({ joined: false, hostKey: 'omp-S-omp' })
    })

    it('pi idle: custom message without a turn, then a steer wake line', async () => {
        await send(sender, { to: (await join(piHost)).uuid, message: 'body stays out of the notice' })
        await until(() => pi.calls.length >= 2)
        expect(pi.calls).toEqual([
            ['sendMessage', { customType: 'harness-summit', content: notice, display: true }, { triggerTurn: false }],
            ['sendUserMessage', 'harness-summit mail above. Call summit_read.', { deliverAs: 'steer' }],
        ])
    })

    it('pi dedupes the steer wake for 10 s, and uses followUp when busy', async () => {
        await read(piHost)
        await send(sender, { to: (await join(piHost)).uuid, message: 'two' })
        await until(() => pi.calls.length >= 3)
        await sleep(400)
        expect(pi.calls.slice(2)).toEqual([
            ['sendMessage', { customType: 'harness-summit', content: notice, display: true }, { triggerTurn: false }],
        ])

        idle = false
        await read(piHost)
        await send(sender, { to: (await join(piHost)).uuid, message: 'three' })
        await until(() => pi.calls.length >= 4)
        expect(pi.calls[3]).toEqual([
            'sendMessage',
            { customType: 'harness-summit', content: notice, display: true },
            { triggerTurn: true, deliverAs: 'followUp' },
        ])
        idle = true
    })

    it('OMP: one followUp call with triggerTurn', async () => {
        await send(sender, { to: (await join(ompOld)).uuid, message: 'omp' })
        await until(() => omp.calls.length >= 1)
        expect(omp.calls).toEqual([
            [
                'sendMessage',
                { customType: 'harness-summit', content: notice, display: true },
                { triggerTurn: true, deliverAs: 'followUp' },
            ],
        ])
    })

    it('validates the ext-arm output before it watches anything', () => {
        expect(parseArmed('{"hostKey":"pi-1","signalPath":"/s","logFile":"/l"}')).toEqual({
            hostKey: 'pi-1',
            signalPath: '/s',
            logFile: '/l',
        })
        expect(() => parseArmed('{"hostKey":"pi-1"}')).toThrow(expect.objectContaining({ code: 'SUMMIT_BAD_INPUT' }))
    })

    it('without a UI: registers the pi server but arms and wakes nothing', async () => {
        const sub = fakeApi(true)
        harnessSummit(sub.api)
        await sub.handlers.session_start!({}, { ...ctxOf('S-headless'), hasUI: false })
        // pi still gets its MCP server (pi -p uses the tools too); nothing is armed without a UI.
        expect(sub.registered).toHaveLength(1)
        await read(piHost)
        await send(sender, { to: (await join(piHost)).uuid, message: 'four' })
        await until(() => pi.calls.length >= 5)
        expect(sub.calls).toEqual([])
    })
})
