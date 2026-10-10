// summit_bye (SPEC §7): remove the map entry, the agent folder and the host record. Messages this
// agent sent to others stay in their folders.
import fs from 'node:fs/promises'

import { summitError } from '../core/errors.js'
import { deleteHost } from '../core/identity.js'
import { log } from '../core/log.js'
import { updateMembers, withoutUuid } from '../core/members.js'
import { mailboxOf } from '../core/paths.js'
import { pipe, step } from '../core/pipe.js'
import { hostKeyStep, need, requireHostStep, type CallContext, type WithHost } from './context.js'

export interface ByeResult {
    uuid: string
    groupKey: string
    removed: true
}

// Step: drop this agent's name from the group map.
const leaveMap = step<WithHost>('leaveMap', async (ctx) => {
    const host = need(ctx.host, 'host')
    await updateMembers(ctx.call.root, host.groupKey, (m) => withoutUuid(m, host.uuid))
    return ctx
})

// Step: remove the agent folder (its inbox).
const removeFolder = step<WithHost>('removeFolder', async (ctx) => {
    const folder = mailboxOf(ctx.call.root, need(ctx.host, 'host'))
    try {
        await fs.rm(folder, { recursive: true, force: true })
    } catch (err) {
        throw summitError('SUMMIT_IO', `cannot remove ${folder}`, 'removeFolder', { folder }, err)
    }
    return ctx
})

// Step: remove the host record last, so a failure before it can be retried by the same host.
const removeHost = step<WithHost>('removeHost', async (ctx) => {
    await deleteHost(ctx.call.root, need(ctx.hostKey, 'hostKey'))
    return ctx
})

// Purpose: run the bye flow.
export async function bye(call: CallContext): Promise<ByeResult> {
    const ctx = await pipe<WithHost>('bye', { call }, [
        hostKeyStep(),
        requireHostStep(),
        leaveMap,
        removeFolder,
        removeHost,
    ])
    const host = need(ctx.host, 'host')
    log('info', 'bye', 'left', { uuid: host.uuid, groupKey: host.groupKey })
    return { uuid: host.uuid, groupKey: host.groupKey, removed: true }
}
