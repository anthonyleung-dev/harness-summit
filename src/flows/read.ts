// summit_read (SPEC §5): return every unread record, oldest first, and advance the cursor. The scan and
// the cursor write run under the agent's cursor lock, so two parallel reads never return a record
// twice (REVIEW m13). Damaged inbox content is skipped and reported in `corrupt` (REVIEW M2). Every
// result carries the neutral mail guidance, so the rules arrive with the mail after every wake, also
// after /clear, /new or a compaction dropped the /summit-join text (F2).
import { withLock } from '../core/lock.js'
import { log } from '../core/log.js'
import { scanUnread, writeCursor, type UnreadScan } from '../core/mailbox.js'
import { SUMMIT_GUIDANCE } from '../core/notice.js'
import { cursorLock, mailboxOf } from '../core/paths.js'
import { pipe, step } from '../core/pipe.js'
import type { CorruptSpan } from '../core/schemas.js'
import { hostKeyStep, need, requireHostStep, type CallContext, type WithHost } from './context.js'

export interface ReadMessage {
    id: string
    from: string
    fromId: string
    at: string
    replyTo: string | null
    body: string
    // Only on a message that is not itself a reply (D1): a reply needs no answer.
    replyHint?: string
}

export interface ReadResult {
    count: number
    messages: ReadMessage[]
    corrupt: CorruptSpan[]
    guidance: string
}

interface ReadCtx extends WithHost {
    scan?: UnreadScan
}

// Purpose: the reply convention attached to every record that is not itself a reply (SPEC §5, D1). The
// reply is addressed by the sender's uuid, which never changes hands; the name is there for the
// reader (REVIEW m9).
export function replyHint(fromId: string, from: string, id: string): string {
    return `When the task is done, reply with summit_send to ${fromId} (${from}) with replyTo=${id}.`
}

// Step: collect the unread records.
const scan = step<ReadCtx>('scanUnread', async (ctx) => ({
    ...ctx,
    scan: await scanUnread(mailboxOf(ctx.call.root, need(ctx.host, 'host'))),
}))

// Step: move the cursor past what was collected.
const advance = step<ReadCtx>('advanceCursor', async (ctx) => {
    await writeCursor(mailboxOf(ctx.call.root, need(ctx.host, 'host')), need(ctx.scan, 'scan').nextCursor)
    return ctx
})

// Step: scan and advance as one unit under the cursor lock (never creates the folder).
const readLocked = step<ReadCtx>('readLocked', async (ctx) => {
    const folder = mailboxOf(ctx.call.root, need(ctx.host, 'host'))
    return await withLock(cursorLock(folder), () => pipe<ReadCtx>('read.locked', ctx, [scan, advance]), {
        mkdir: false,
    })
})

// Purpose: run the read flow.
export async function read(call: CallContext): Promise<ReadResult> {
    const ctx = await pipe<ReadCtx>('read', { call }, [hostKeyStep(), requireHostStep(), readLocked])
    const result = need(ctx.scan, 'scan')
    const messages = result.records.map((r) => ({
        id: r.id,
        from: r.from,
        fromId: r.fromId,
        at: r.at,
        replyTo: r.replyTo ?? null,
        body: r.body,
        ...(r.replyTo === undefined ? { replyHint: replyHint(r.fromId, r.from, r.id) } : {}),
    }))
    log('info', 'read', 'read', {
        uuid: need(ctx.host, 'host').uuid,
        count: messages.length,
        corrupt: result.corrupt.length,
    })
    return { count: messages.length, messages, corrupt: result.corrupt, guidance: SUMMIT_GUIDANCE }
}
