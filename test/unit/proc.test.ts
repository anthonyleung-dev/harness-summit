// Unit tests for process identity (REVIEW m8, DELTA-REVIEW-1 F9, F11, N1, DELTA-REVIEW-3 E1, E2): start
// times are checked against an independent source, and only a definite "gone" ever counts as gone.
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readHost } from '../../src/core/identity.js'
import { isProcessAlive, isSameProcess, parseStat, processStartTime, readProcessStart } from '../../src/core/proc.js'
import { join } from '../../src/flows/join.js'
import { members, whoami } from '../../src/flows/query.js'
import { rename } from '../../src/flows/rename.js'
import { callFor, deadPid, errno, errorCode, failProcReads, livePid, tmpRoot, zombiePid } from '../helpers/env.js'
import { agentJson, hostJson } from '../helpers/state.js'

// A real `/proc/<pid>/stat` line (captured on the build host) with its comm replaced by one that holds
// spaces and ')'. Field 21 is 0 and field 22 (start time) is 28756559.
const STAT_LINE =
    '3730859 (we ird) (x) R 3730858 3730858 3730858 0 -1 4194304 127 0 0 0 0 0 0 0 16 -4 1 0 28756559 7024640 ' +
    '553 18446744073709551615 94133045374976 94133045415425 140723496766256 0 0 0 0 0 0 0 0 0 17 2 0 0 0 0 0\n'

// Purpose: field 22 of /proc/<pid>/stat read by `cut`, an independent source (comm `sleep` has no spaces).
const cutField22 = (pid: number) =>
    Number(execFileSync('cut', ['-d', ' ', '-f22', `/proc/${pid}/stat`], { encoding: 'utf8' }).trim())

describe('process start time', () => {
    it('parses fields 3 and 22 of a real stat line, also when comm holds spaces and parentheses', () => {
        expect(parseStat(STAT_LINE)).toEqual({ state: 'R', start: 28756559 })
        expect(parseStat(STAT_LINE.replace(') R ', ') Z '))).toEqual({ state: 'Z', start: 28756559 })
        expect(parseStat('garbage')).toBeNull()
    })

    it('a zombie (killed, not reaped) is gone for every reader, with or without a start time (E1)', async () => {
        const zombie = await zombiePid()
        const start = cutField22(zombie)
        expect(readProcessStart(zombie)).toBe('gone')
        expect(isSameProcess(zombie, start)).toBe(false)
        expect(isProcessAlive(zombie, start)).toBe(false)
        expect(isProcessAlive(zombie, null)).toBe(false)
    })

    it('matches an independent read of /proc (cut -f22) for a live process', () => {
        const pid = livePid()
        const start = processStartTime(pid)
        expect(start).toBe(cutField22(pid))
        expect(start).toBeGreaterThan(0)
    })

    it('records the host start time on the FIRST join (one /sj joins once)', async () => {
        const root = tmpRoot()
        const pid = livePid()
        const j = await join(callFor(root, 'claude', { ppid: pid }))
        expect(hostJson(root, j.hostKey)?.hostStart).toBe(cutField22(pid))
    })

    it('a dead pid is gone, a reused pid is another process, a null start cannot be checked', async () => {
        const dead = await deadPid()
        expect(readProcessStart(dead)).toBe('gone')
        expect(isSameProcess(dead, 5)).toBe(false)
        const mine = processStartTime(process.pid)!
        expect(isSameProcess(process.pid, mine)).toBe(true)
        expect(isSameProcess(process.pid, mine + 1)).toBe(false)
        expect(isSameProcess(process.pid, null)).toBe(true)
    })
})

describe('a /proc error other than ESRCH, or ENOENT with /proc readable, is unknown, never gone (F9, E2)', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it('EMFILE / EACCES read as unknown; ENOENT reads as gone only while /proc itself is readable (E2)', () => {
        failProcReads('EMFILE')
        expect(readProcessStart(process.pid)).toBe('unknown')
        expect(isSameProcess(process.pid, 123)).toBe('unknown')
        vi.restoreAllMocks()
        failProcReads('ENOENT', `/proc/${process.pid}/`)
        expect(readProcessStart(process.pid)).toBe('gone')
        vi.restoreAllMocks()
        // No /proc at all (not mounted, another mount namespace): a missing entry says nothing.
        failProcReads('ENOENT')
        expect(readProcessStart(process.pid)).toBe('unknown')
        expect(isSameProcess(process.pid, 123)).toBe('unknown')
        expect(isProcessAlive(process.pid, 123)).toBe('unknown')
    })

    it('a reader without /proc keeps the host record of a live session (E2)', async () => {
        const call = callFor(root, 'claude', { ppid: livePid() })
        const j = await join(call)
        failProcReads('ENOENT')
        expect(await readHost(root, j.hostKey)).toMatchObject({ uuid: j.uuid })
    })

    it('keeps the host record of a live session through a transient /proc fault', async () => {
        const call = callFor(root, 'claude', { ppid: livePid() })
        const j = await join(call)
        failProcReads('EACCES')
        expect(await readHost(root, j.hostKey)).toMatchObject({ uuid: j.uuid })
        vi.restoreAllMocks()
        expect(await whoami(call)).toMatchObject({ joined: true, uuid: j.uuid })
    })

    it('the pid refresh never overwrites a good start time with an unreadable one', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        const before = agentJson(ja.folder).pidStart
        expect(before).toEqual(expect.any(Number))
        failProcReads('EACCES')
        await members(a)
        vi.restoreAllMocks()
        expect(agentJson(ja.folder).pidStart).toBe(before)
    })

    it('an unknown holder keeps its name without force', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const b = callFor(root, 'claude', { ppid: livePid() })
        await join(a)
        await join(b)
        await rename(a, 'kept')
        failProcReads('EMFILE')
        expect(isProcessAlive(a.ppid, 1)).toBe('unknown')
        vi.restoreAllMocks()
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw errno('EINVAL')
        })
        expect(isProcessAlive(a.ppid, null)).toBe('unknown')
        expect(await errorCode(rename(b, 'kept'))).toBe('SUMMIT_NAME_TAKEN')
    })
})
