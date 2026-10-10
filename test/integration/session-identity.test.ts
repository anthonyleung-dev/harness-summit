// Identity follows the harness session across real server processes (SPEC §3): a session resumed in a new
// claude process gets its agent back; pi takes its session from the env its extension set; a server whose
// host recorded no session fails with SUMMIT_NO_HOST_KEY.
import { describe, expect, it } from 'vitest'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import { writeSessionSync } from '../../src/core/sessions.js'
import { createSummitServer } from '../../src/server/server.js'
import { fakePid, tmpDir } from '../helpers/env.js'
import { McpProc } from '../helpers/mcp.js'

describe('session identity across server processes', () => {
    it('claude: a new host process that resumes the session gets the same agent', async () => {
        const root = tmpDir('resume')
        const first = McpProc.start({ harness: 'claude', root, viaParent: true, session: 'S-resume' })
        await first.initialize()
        const joined = await first.call('summit_join')
        await first.call('summit_rename', { name: 'keeper' })
        await first.close()
        const second = McpProc.start({ harness: 'claude', root, viaParent: true, session: 'S-resume' })
        await second.initialize()
        expect(await second.call('summit_whoami')).toMatchObject({ joined: true, uuid: joined.uuid, name: 'keeper' })
        await second.close()
    })

    it('claude: every call uses the parent pid captured when the server started, never process.ppid now', async () => {
        const root = tmpDir('captured')
        // The host recorded its session under its pid; this test process is not that host.
        const hostPid = fakePid()
        writeSessionSync(root, 'claude', hostPid, 'S-captured')
        const server = createSummitServer({ harness: 'claude', root, hostPid })
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
        await server.connect(serverSide)
        const client = new Client({ name: 'test', version: '0' })
        await client.connect(clientSide)
        const res = await client.callTool({ name: 'summit_join', arguments: {} })
        expect(res.structuredContent).toMatchObject({ hostKey: 'claude-S-captured' })
        await client.close()
    })

    it('pi: the session comes from SUMMIT_SESSION_ID; without it every call says why it failed', async () => {
        const root = tmpDir('pi-env')
        const pi = McpProc.start({ harness: 'pi', root, session: 'S-pi-env' })
        await pi.initialize()
        expect(await pi.call('summit_join')).toMatchObject({ hostKey: 'pi-S-pi-env' })
        await pi.close()
        const bare = McpProc.start({ harness: 'pi', root, env: { SUMMIT_SESSION_ID: '' }, session: '' })
        await bare.initialize()
        const err = (await bare.call('summit_whoami')).error
        expect(err).toMatchObject({ code: 'SUMMIT_NO_HOST_KEY', message: expect.stringContaining('pi extension') })
        await bare.close()
    })
})
