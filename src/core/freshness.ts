// Freshness of a file timestamp (SPEC §5, §7; XPLAT-AUDIT §H): the one rule that heartbeats and lock
// leases share. A writer that is alive sets the file's mtime to now (`utimes`) every BEAT_MS. A file is
// stale when its mtime is more than STALE_MS in the past, OR more than STALE_MS in the future: a live
// writer always writes "now", so a mtime far ahead was not written since the clock moved back, or was
// set by hand (`touch -d 2099`); it must not keep a dead agent alive or a dead lock held forever. A
// stale file declares nothing gone by itself: every "gone" decision takes the second look
// (confirmGone), so a clock jump or a laptop sleep never kills a live writer.
import fs from 'node:fs/promises'

import { hasErrno } from './errors.js'
import { log } from './log.js'

// How often a live writer touches its file (heartbeat beats, lock lease refreshes).
export const BEAT_MS = 2_000
// A file not touched for this long (or touched this far in the future) is stale.
export const STALE_MS = 10_000
// Files of sessions that ended this long ago are deleted when a server starts (heartbeats, session files).
export const CLEANUP_AGE_MS = 24 * 60 * 60 * 1000
// One missed beat plus a margin: long enough that a live writer moves the mtime in between.
export const SECOND_LOOK_MS = BEAT_MS + 500

// Purpose: wait `ms` milliseconds on this process's own timer (the one sleep helper).
export function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
}

// Purpose: the mtime of `file` in ms, or null when it does not exist (the one mtime reader).
export async function mtimeOf(file: string): Promise<number | null> {
    try {
        return (await fs.stat(file)).mtimeMs
    } catch (err) {
        if (hasErrno(err, 'ENOENT') || hasErrno(err, 'ENOTDIR')) return null
        throw err
    }
}

// Purpose: tell whether a file last touched at `mtime` is stale at `now`: more than STALE_MS in the
// past, or more than STALE_MS in the future.
export function isStaleMtime(mtime: number, now = Date.now()): boolean {
    return now - mtime > STALE_MS || mtime - now > STALE_MS
}

// Purpose: the second look before a "gone" decision: wait `waitMs`, read the mtime of `file` again, and
// report gone only when it did not move (also when the file is still missing). Shared by agent
// liveness and lock breaks (one door).
export async function confirmGone(file: string, seen: number | null, waitMs = SECOND_LOOK_MS): Promise<boolean> {
    await sleep(waitMs)
    const again = await mtimeOf(file)
    const gone = again === seen
    log('debug', 'confirmGone', gone ? 'still not touched: gone' : 'touched meanwhile: alive', { file })
    return gone
}
