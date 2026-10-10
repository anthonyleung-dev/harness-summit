// Shared test helpers that build agents through the real flows.
import { join } from '../../src/flows/join.js'
import { rename } from '../../src/flows/rename.js'
import { callFor, codexMeta, deadPid } from './env.js'

// Purpose: a Codex agent named `name` that joined through an MCP server that has exited, and the call
// of the same thread resumed under a new server (`codex resume`: same thread id, new server pid).
export async function resumedCodex(root: string, name: string, threadId = 'T-cx') {
    const oldServer = await deadPid()
    const before = { ...callFor(root, 'codex', { meta: codexMeta(threadId) }), pid: oldServer }
    const joined = await join(before)
    await rename(before, name)
    return { joined, oldServer, resumed: callFor(root, 'codex', { meta: codexMeta(threadId) }) }
}
