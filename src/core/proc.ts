// Process identity: a pid plus its start time names one process, even after the pid is reused
// (REVIEW m8). Linux only (`/proc`); elsewhere the start time is unknown and callers fall back to the pid.
//
// Only ENOENT (no /proc entry) and ESRCH (no such process) mean "the process is gone", and ENOENT only
// while /proc itself is readable (`/proc/self/stat`): a reader without /proc (not mounted, another
// mount namespace) cannot tell, so it reads "unknown" (DELTA-REVIEW-3 E2). Any other error (EACCES,
// EMFILE) also means "unknown": a caller must never delete state on it (DELTA-REVIEW-1 F9). A zombie
// (state `Z` or `X`: killed, not yet reaped) is gone (E1): `kill(pid, 0)` still succeeds on it.
import fs from 'node:fs'

import { hasErrno } from './errors.js'
import { log } from './log.js'

// Result of one start-time read: the start time, 'gone' (the pid names no process) or 'unknown'.
export type ProcStart = number | 'gone' | 'unknown'

// The fields of one `/proc/<pid>/stat` line that liveness reads.
export interface ProcStat {
    state: string
    start: number
}

// Process states of a process that has exited (zombie, dead): it holds nothing any more.
const EXITED_STATES = new Set(['Z', 'X', 'x'])

// Purpose: tell whether an errno says the process does not exist.
export function isGoneErrno(err: unknown): boolean {
    return hasErrno(err, 'ENOENT') || hasErrno(err, 'ESRCH')
}

// Purpose: field 3 (state) and field 22 (start time in clock ticks since boot) of one
// `/proc/<pid>/stat` line, or null when the line does not have them. Field 2 (comm) is in parentheses
// and may hold spaces or ')', so the fields are counted from the last ')'; the first field after it
// is field 3.
export function parseStat(stat: string): ProcStat | null {
    const close = stat.lastIndexOf(')')
    if (close < 0) return null
    const rest = stat.slice(close + 2).split(' ')
    const state = rest[0] ?? ''
    const start = Number(rest[22 - 3])
    return /^[A-Za-z]$/.test(state) && Number.isInteger(start) && start >= 0 ? { state, start } : null
}

// Purpose: tell whether this process can read /proc at all (E2). Without it, a missing
// `/proc/<pid>/stat` says nothing about `pid`.
function procReadable(): boolean {
    try {
        fs.readFileSync('/proc/self/stat', 'utf8')
        return true
    } catch {
        return false
    }
}

// Purpose: read the start time of `pid` from /proc. 'gone' on ESRCH, on ENOENT while /proc is
// readable, and for a zombie; every other failure (and an unparsable line) is 'unknown'.
export function readProcessStart(pid: number): ProcStart {
    if (!Number.isInteger(pid) || pid <= 0) return 'gone'
    let line: string
    try {
        line = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
    } catch (err) {
        if (isGoneErrno(err) && procReadable()) return 'gone'
        log('warn', 'readProcessStart', 'cannot read /proc stat; liveness unknown', { pid, error: String(err) })
        return 'unknown'
    }
    const stat = parseStat(line)
    if (stat === null) {
        log('warn', 'readProcessStart', 'unparsable /proc stat line; liveness unknown', { pid })
        return 'unknown'
    }
    if (EXITED_STATES.has(stat.state)) {
        log('debug', 'readProcessStart', 'process has exited (not reaped yet); gone', { pid, state: stat.state })
        return 'gone'
    }
    return stat.start
}

// Purpose: start time of `pid` to record in a file, or null when it cannot be read (gone or unknown).
export function processStartTime(pid: number): number | null {
    const start = readProcessStart(pid)
    return typeof start === 'number' ? start : null
}

// Purpose: compare one /proc read with a recorded start time: 'unknown' when /proc could not tell,
// else whether it is the same process ('gone' never is).
function matchesStart(now: ProcStart, start: number): boolean | 'unknown' {
    return now === 'unknown' ? 'unknown' : now === start
}

// Purpose: the one "same process" predicate (DELTA-REVIEW-1 N1): true when `pid` still is the process
// that had start time `start`, false when it is gone or now names another process, 'unknown' when
// /proc cannot tell. A null or missing recorded start time cannot be checked and counts as a match
// (a host record written before start times existed is accepted, SPEC §3).
export function isSameProcess(pid: number, start: number | null | undefined): boolean | 'unknown' {
    if (start === null || start === undefined) return true
    return matchesStart(readProcessStart(pid), start)
}

// Purpose: the one process liveness probe (SPEC §5, §7): true when `pid` runs and still is the process
// that had start time `start` (a null start is not checked); false when it is gone (ESRCH/ENOENT, a
// zombie) or the pid was reused; 'unknown' when the probe fails in any other way (F9, E2). Used by
// agent liveness (src/core/agents.ts isAlive) and by lock staleness (src/core/lock.ts): only a
// definite false may take a name over or break a lock by owner death.
export function isProcessAlive(pid: number, start: number | null | undefined): boolean | 'unknown' {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try {
        process.kill(pid, 0)
    } catch (err) {
        if (isGoneErrno(err)) return false
        if (!hasErrno(err, 'EPERM')) {
            log('warn', 'isProcessAlive', 'liveness probe failed; unknown', { pid, error: String(err) })
            return 'unknown'
        }
    }
    // Read /proc also without a start time: a zombie answers kill(pid, 0) like a live process (E1).
    const now = readProcessStart(pid)
    if (now === 'gone') return false
    return start === null || start === undefined ? true : matchesStart(now, start)
}
