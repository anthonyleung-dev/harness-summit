// Sender-side wake of a receiver (SPEC §6): per-harness action, debounce, best effort.
//
// Every decision is taken on the receiver's state AFTER the append (REVIEW m2, m3): the notice is
// built from what is unread now, nothing unread means no wake, and the debounce skips only while
// mail that the last wake already announced is still unread.
//
// The decision runs under the receiver's read lock (`.cursor.lock`, the lock summit_read holds while
// it scans and moves its cursor), so a read in progress finishes before a sender decides (F4). The
// sender stamps its claim in `.lastwake` under that lock BEFORE it runs the wake command, so a second
// sender during a slow `codex queue` sees the claim and skips (F5). A failed wake removes its own
// claim (Pipe undo), and only its own.
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'

import type { Alive } from './agents.js'
import { summitError, toSummitError } from './errors.js'
import { cliBin, type Exec, type ExecRequest } from './exec.js'
import { readJsonFile, writeJsonAtomic } from './fsx.js'
import { withLock } from './lock.js'
import { log } from './log.js'
import { scanUnread } from './mailbox.js'
import { buildNotice, queuedNote } from './notice.js'
import { cursorLock, lastWakeFile } from './paths.js'
import { pipe, step } from './pipe.js'
import { LastWakeSchema, type LastWake, type MessageRecord, type Wake } from './schemas.js'
import { ringSignal } from './signal.js'

export const WAKE_DEBOUNCE_MS = 10_000
// How long a sender waits for `codex queue` / `opencode api session.prompt` to exit (REVIEW m10).
export const WAKE_TIMEOUT_MS = 15_000
const STDERR_EXCERPT = 300

export type WakeOutcome =
    { wake: 'sent' | 'skipped' } | { wake: 'failed'; wakeError: string } | { wake: 'queued'; note: string }

// Purpose: the external command that wakes a codex or opencode receiver; null for signal hosts.
// The binary comes from SUMMIT_CODEX_BIN / SUMMIT_OPENCODE_BIN when install recorded it.
export function wakeCommand(wake: Wake, notice: string, env: NodeJS.ProcessEnv = process.env): ExecRequest | null {
    switch (wake.type) {
        case 'codex-queue':
            return { cmd: cliBin('codex', env), args: ['queue', '--thread', wake.threadId, '--message', notice] }
        case 'opencode-prompt':
            return {
                cmd: cliBin('opencode', env),
                args: [
                    'api',
                    'session.prompt',
                    '--param',
                    `sessionID=${wake.sessionID}`,
                    '-d',
                    JSON.stringify({ text: notice, delivery: 'queue' }),
                ],
            }
        case 'signal':
            return null
    }
}

// Purpose: run the wake action once and wait for it to exit. No retry: `codex queue` can accept
// before a failed receipt. Exit code non-zero (or a timeout) is a failure with a stderr excerpt.
export async function performWake(wake: Wake, notice: string, exec: Exec): Promise<void> {
    const cmd = wakeCommand(wake, notice)
    if (cmd === null) {
        if (wake.type === 'signal') await ringSignal(wake.path)
        return
    }
    const res = await exec.capture(cmd, WAKE_TIMEOUT_MS)
    if (res.code !== 0) {
        const excerpt = res.stderr.trim().slice(-STDERR_EXCERPT)
        throw summitError('SUMMIT_EXEC_FAILED', `${cmd.cmd} exited ${res.code}: ${excerpt}`, 'performWake', {
            cmd: cmd.cmd,
            type: wake.type,
        })
    }
    log('debug', 'performWake', 'wake command exited 0', { cmd: cmd.cmd, type: wake.type })
}

// Purpose: the receiver's last wake claim, or null. A file that does not match the schema (an older
// plain-number `.lastwake`, a torn write) counts as no claim: a wake too many, never one too few.
async function readLastWake(folder: string): Promise<LastWake | null> {
    try {
        return await readJsonFile(lastWakeFile(folder), LastWakeSchema)
    } catch (err) {
        log('warn', 'readLastWake', 'unreadable .lastwake; treated as none', { folder, error: String(err) })
        return null
    }
}

// Purpose: debounce rule on the post-append state: skip only when the last wake is under 10 s old
// AND some record that wake announced is still unread (the receiver was told and has not read yet,
// so it will see the new mail in the same read). Matching by record id, not by time, means a record
// stamped before the wake but appended after its scan is never taken as announced.
export function shouldSkipWake(unread: Pick<MessageRecord, 'id'>[], last: LastWake | null, now: number): boolean {
    if (last === null || now - last.at < 0 || now - last.at >= WAKE_DEBOUNCE_MS) return false
    const announced = new Set(last.announced)
    return unread.some((r) => announced.has(r.id))
}

interface WakeCtx {
    folder: string
    wake: Wake
    exec: Exec
    now?: number
    notice?: string
    claim?: LastWake
    skipped?: 'nothing unread' | 'debounce'
}

// Purpose: under the receiver's read lock, decide on the current unread state and, when a wake is
// due, write this sender's claim to `.lastwake`.
async function decideAndClaim(ctx: WakeCtx): Promise<WakeCtx> {
    const { records } = await scanUnread(ctx.folder)
    // Taken after the scan: every record the notice announces was appended before this time.
    const now = ctx.now ?? Date.now()
    const notice = buildNotice(records)
    if (notice === null) return { ...ctx, skipped: 'nothing unread' }
    if (shouldSkipWake(records, await readLastWake(ctx.folder), now)) return { ...ctx, skipped: 'debounce' }
    const claim: LastWake = { at: now, claim: randomUUID(), announced: records.map((r) => r.id) }
    await writeJsonAtomic(lastWakeFile(ctx.folder), claim, { mkdir: false })
    return { ...ctx, notice, claim }
}

// Purpose: remove `.lastwake` only while it still holds this sender's claim (under the read lock).
async function releaseClaim(folder: string, claim: LastWake): Promise<void> {
    await withLock(
        cursorLock(folder),
        async () => {
            const current = await readLastWake(folder)
            if (current?.claim !== claim.claim) return
            await fs.rm(lastWakeFile(folder), { force: true })
            log('info', 'releaseClaim', 'failed wake: claim removed', { folder })
        },
        { mkdir: false },
    )
}

// Step: decide and claim under the receiver's read lock (never creates the folder). Undo: a later
// failure (the wake command) removes this claim, so it does not suppress the next wake.
const decide = step<WakeCtx>(
    'decideAndClaim',
    async (ctx) => await withLock(cursorLock(ctx.folder), () => decideAndClaim(ctx), { mkdir: false }),
    async (ctx) => {
        if (ctx.claim !== undefined) await releaseClaim(ctx.folder, ctx.claim)
    },
)

// Step: run the wake command when the decision asked for one (outside the lock: it can take 15 s).
const perform = step<WakeCtx>('performWake', async (ctx) => {
    if (ctx.skipped !== undefined || ctx.notice === undefined) return ctx
    await performWake(ctx.wake, ctx.notice, ctx.exec)
    return ctx
})

// Purpose: wake one receiver after an append, unless it is not alive (then `queued`). Never throws: a
// failed wake never fails the send.
export async function wakeReceiver(input: {
    folder: string
    wake: Wake
    exec: Exec
    now?: number
    // The receiver's liveness (src/core/agents.ts isAlive). A receiver that is not alive (false: its
    // session ended or was cleared) gets no wake: no ring nobody watches, no paid `codex queue` or
    // `opencode` turn for nobody. Its mail waits; a resume reports it (SessionStart additionalContext,
    // the extension's arm). `label` names it in the note.
    alive?: Alive
    label?: string
}): Promise<WakeOutcome> {
    if (input.alive === false) {
        log('info', 'wakeReceiver', 'receiver not active; mail queued, no wake', { folder: input.folder })
        return { wake: 'queued', note: queuedNote(input.label ?? 'the receiver') }
    }
    try {
        const ctx = await pipe<WakeCtx>('wake', { ...input }, [decide, perform])
        if (ctx.skipped !== undefined) {
            log('info', 'wakeReceiver', `wake skipped (${ctx.skipped})`, { folder: input.folder })
            return { wake: 'skipped' }
        }
        log('info', 'wakeReceiver', 'wake sent', { folder: input.folder, type: input.wake.type })
        return { wake: 'sent' }
    } catch (err) {
        const e = toSummitError(err, 'wakeReceiver', { folder: input.folder, type: input.wake.type })
        log('warn', 'wakeReceiver', 'wake failed', { error: e.toJSON() })
        return { wake: 'failed', wakeError: `${e.code}: ${e.message}` }
    }
}
