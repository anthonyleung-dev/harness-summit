// Lease refresh of a held lock file (SPEC §5, XPLAT-AUDIT §H). While a holder runs its critical section,
// a timer sets the lock file's mtime to now every LEASE_REFRESH_MS. A waiter treats a lock as stale only
// when its mtime is older than STALE_MS and a second look confirms it (src/core/lock.ts), so a live
// holder keeps its lock while it works (a group move that waits for a `.cursor.lock`), and a holder that
// died stops refreshing and loses it. The timer stops after LOCK_MAX_HOLD_MS, so a holder that hangs while
// its timer still runs loses its lock about STALE_MS later instead of blocking everyone forever. No
// OS process inspection: the file's mtime is the only signal, on every OS.
import fs from 'node:fs/promises'

import { hasErrno } from './errors.js'
import { BEAT_MS } from './freshness.js'
import { readTextFile } from './fsx.js'
import { log } from './log.js'

// How often a holder refreshes its lock (the heartbeat period). Five refreshes fit in one STALE_MS.
export const LEASE_REFRESH_MS = BEAT_MS
// The longest a holder keeps refreshing. The longest legal hold is a group move that waits up to the
// 15 s lock timeout for a `.cursor.lock`; 60 s is four times that.
export const LOCK_MAX_HOLD_MS = 60_000

// The outcome of one lease refresh.
export type LeaseState = 'refreshed' | 'gone' | 'lost' | 'failed'

// Purpose: refresh the lease once: set the mtime of `lockPath` to now when the file still holds
// `token`. Returns 'refreshed'; 'gone' (no file: released, or moved with its folder); 'lost' (another
// holder's token: a waiter broke this lock); or 'failed' (any other error, logged; the next tick tries
// again).
export async function refreshLease(lockPath: string, token: string, now = new Date()): Promise<LeaseState> {
    try {
        const content = await readTextFile(lockPath)
        if (content === null) return 'gone'
        if (!content.startsWith(token + ' ')) return 'lost'
        await fs.utimes(lockPath, now, now)
        return 'refreshed'
    } catch (err) {
        if (hasErrno(err, 'ENOENT')) return 'gone'
        log('warn', 'refreshLease', 'lease refresh failed; next tick retries', { lockPath, error: String(err) })
        return 'failed'
    }
}

// Purpose: start refreshing the lease of `lockPath` (held with `token`) every `everyMs`, for at most
// `maxHoldMs` (no defaults: withLock passes LEASE_REFRESH_MS and LOCK_MAX_HOLD_MS explicitly). Returns
// the stop function. The timer is unref'd, so it never keeps a process alive, and two refreshes never
// overlap. A lost lease is logged once as an error: the holder kept running past
// STALE_MS without a refresh (an event-loop stall, a suspend, or a hold past LOCK_MAX_HOLD_MS), and a
// waiter took the lock.
export function startLease(lockPath: string, token: string, everyMs: number, maxHoldMs: number): () => void {
    let busy = false
    let reported = false
    const until = Date.now() + maxHoldMs
    const timer = setInterval(() => {
        if (Date.now() > until) {
            clearInterval(timer)
            log('error', 'startLease', 'held longer than LOCK_MAX_HOLD_MS; lease no longer refreshed', { lockPath })
            return
        }
        if (busy) return
        busy = true
        refreshLease(lockPath, token)
            .then((state) => {
                if (state === 'lost' && !reported) {
                    reported = true
                    log('error', 'startLease', 'lease lost: another holder took this lock', { lockPath })
                }
            })
            .finally(() => (busy = false))
    }, everyMs)
    timer.unref()
    return () => clearInterval(timer)
}
