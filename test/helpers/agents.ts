// Shared test helpers that build agents through the real flows.
import { STALE_MS } from '../../src/core/freshness.js'
import { join } from '../../src/flows/join.js'
import { rename } from '../../src/flows/rename.js'
import { callFor, codexMeta, fakePid } from './env.js'
import { ageBeat } from './state.js'

// Purpose: a Codex agent named `name` that joined through an MCP server that has exited (no beat for
// longer than STALE_MS), and the call of the same thread resumed under a new server
// (`codex resume`: same thread id, new server pid).
export async function resumedCodex(root: string, name: string, threadId = 'T-cx') {
    const before = { ...callFor(root, 'codex', { meta: codexMeta(threadId) }), pid: fakePid() }
    const joined = await join(before)
    await rename(before, name)
    ageBeat(root, joined.hostKey, STALE_MS + 5_000)
    return { joined, resumed: callFor(root, 'codex', { meta: codexMeta(threadId) }) }
}
