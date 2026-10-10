// Unit tests for trust in the session file (team review R1, A; SPEC §3): a server accepts a session file
// only when it was written after the server started (30 s tolerance), so a new process with a reused pid
// never takes the dead session's identity, and its timer never beats that key. Old session files of
// ended sessions are cleaned up; a live session's file stays however old.
import fs from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { CLEANUP_AGE_MS, sleep, STALE_MS } from '../../src/core/freshness.js'
import { beat, beatTime } from '../../src/core/heartbeat.js'
import { sessionFile } from '../../src/core/paths.js'
import { cleanupSessions, SESSION_CLOCK_TOLERANCE_MS, writeSessionSync } from '../../src/core/sessions.js'
import { join } from '../../src/flows/join.js'
import { whoami } from '../../src/flows/query.js'
import { startServing } from '../../src/server/server.js'
import { callFor, errorCode, fakePid, tmpRoot } from '../helpers/env.js'
import { ageBeat } from '../helpers/state.js'

describe('session file trust', () => {
    let root: string
    let stop: (() => void) | undefined
    beforeEach(() => {
        root = tmpRoot()
    })
    afterEach(() => {
        stop?.()
        stop = undefined
    })

    it('a file written before this server started (beyond 30 s) is not trusted: SUMMIT_NO_HOST_KEY, no beat', async () => {
        expect(SESSION_CLOCK_TOLERANCE_MS).toBe(30_000)
        const pid = fakePid()
        // The dead claude that had this pid joined as session S-OLD an hour ago.
        const dead = callFor(root, 'claude', { hostPid: pid, session: 'S-OLD' })
        const old = await join(dead)
        ageBeat(root, old.hostKey, STALE_MS * 2)
        writeSessionSync(root, 'claude', pid, 'S-OLD', new Date(Date.now() - 60 * 60 * 1000))
        // A new claude got the pid; its hook has not run. Its server started now.
        const reborn = { ...dead, startedAt: Date.now() }
        const err = await whoami(reborn).catch((e: { code: string; message: string }) => e)
        expect(err).toMatchObject({ code: 'SUMMIT_NO_HOST_KEY', message: expect.stringContaining('hooks did not run') })
        stop = await startServing(root, reborn)
        await sleep(300)
        expect(Date.now() - ((await beatTime(root, old.hostKey)) ?? 0)).toBeGreaterThan(STALE_MS)
    })

    it('a file written up to 30 s before the server started (hook first, server second) is trusted', async () => {
        const pid = fakePid()
        writeSessionSync(root, 'omp', pid, 'S-early', new Date(Date.now() - 20_000))
        const call = { ...callFor(root, 'omp', { hostPid: fakePid() }), hostPid: pid, startedAt: Date.now() }
        expect(await whoami(call)).toEqual({ joined: false, hostKey: 'omp-S-early' })
        writeSessionSync(root, 'omp', pid, 'S-early', new Date(Date.now() - 40_000))
        expect(await errorCode(whoami(call))).toBe('SUMMIT_NO_HOST_KEY')
    })

    it('cleanup deletes session files older than 24 h whose session nobody beats, and keeps the rest', async () => {
        const day = CLEANUP_AGE_MS + 60_000
        writeSessionSync(root, 'claude', 101, 'S-ended', new Date(Date.now() - day))
        writeSessionSync(root, 'claude', 102, 'S-live', new Date(Date.now() - day))
        await beat(root, 'claude-S-live', 'claude')
        writeSessionSync(root, 'omp', 103, 'S-young', new Date(Date.now() - 60_000))
        await cleanupSessions(root)
        expect(fs.existsSync(sessionFile(root, 'claude', 101))).toBe(false)
        expect(fs.existsSync(sessionFile(root, 'claude', 102))).toBe(true)
        expect(fs.existsSync(sessionFile(root, 'omp', 103))).toBe(true)
    })
})
