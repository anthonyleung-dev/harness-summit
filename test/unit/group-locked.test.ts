// Unit tests for the group move under the new group's lock (DELTA-REVIEW-1 F6, F7, F11): a leftover map
// entry is free, a failed move gives a taken-over name back, every failure undoes the folder move, and
// nobody outside the lock ever sees a claim without its folder. A rename in the old group never leaves
// agent.json and the new map with different names (DELTA-REVIEW-4, pre-existing race).
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { readHost } from '../../src/core/identity.js'
import { LOCK_STALE_MS, sleep, withLock } from '../../src/core/lock.js'
import { agentDir, cursorLock, hostsDir, membersLock } from '../../src/core/paths.js'
import { group } from '../../src/flows/group.js'
import { join } from '../../src/flows/join.js'
import { members, whoami } from '../../src/flows/query.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { callFor, errorCode, killLivePid, livePid, tmpRoot, until } from '../helpers/env.js'
import { ageFile, agentJson, foldersOf, mapOf, onMapRead, patchAgentJson, writeMap } from '../helpers/state.js'

// Purpose: check `bad` between every I/O step of `run` (setImmediate runs once per event-loop turn);
// returns the result of `run` and every state `bad` reported.
async function watch<T>(run: Promise<T>, bad: () => string | null): Promise<{ out: T; seen: string[] }> {
    const seen: string[] = []
    let on = true
    const tick = () => {
        const b = bad()
        if (b !== null) seen.push(b)
        if (on) setImmediate(tick)
    }
    setImmediate(tick)
    try {
        return { out: await run, seen }
    } finally {
        on = false
    }
}

describe('group move under the group lock', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })
    afterEach(() => {
        vi.restoreAllMocks()
        if (fs.existsSync(hostsDir(root))) fs.chmodSync(hostsDir(root), 0o755)
    })

    // Purpose: the name agent.json holds after a move to `groupKey`, checked against the new map, the
    // group result and whoami (they must all agree).
    async function agreedName(
        a: ReturnType<typeof callFor>,
        uuid: string,
        groupKey: string,
        result: { name: string | null },
    ) {
        const name = agentJson(agentDir(root, groupKey, uuid)).name as string
        expect(mapOf(root, groupKey)).toEqual({ [name]: uuid })
        expect(result.name).toBe(name)
        expect(await whoami(a)).toMatchObject({ name })
        return name
    }

    it('a rename that lands while the move claims the name waits for the move, then finds the folder gone', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        await rename(a, 'a')
        let renaming: Promise<string | undefined> | undefined
        // summit_group has read the name (loadAgent) and now claims it in g2; the rename starts here.
        onMapRead(root, 'g2', async () => {
            renaming = errorCode(rename(a, 'x'))
            await sleep(300)
        })
        const moved = await group(a, 'g2')
        const renamed = await renaming
        expect(await agreedName(a, ja.uuid, 'g2', moved)).toBe('a')
        expect(renamed).toBe('SUMMIT_TARGET_GONE')
        expect(mapOf(root, ja.groupKey)).toEqual({})
    })

    it('two moves in opposite directions both finish: both groups are locked in key order', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const b = callFor(root, 'claude', { ppid: livePid() })
        const [ja, jb] = [await join(a), await join(b)]
        await group(a, 'ga')
        await group(b, 'gb')
        const started = Date.now()
        await Promise.all([group(a, 'gb'), group(b, 'ga')])
        expect(Date.now() - started).toBeLessThan(5_000)
        expect([foldersOf(root, ja.uuid), foldersOf(root, jb.uuid)]).toEqual([['gb'], ['ga']])
    })

    it('a rename that ends after the move read the name, before its locks, is the name the move claims', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        await rename(a, 'a')
        let moving: Promise<{ name: string | null }> | undefined
        await withLock(membersLock(root, ja.groupKey), async () => {
            moving = group(a, 'g2')
            await sleep(300)
            // What a rename to x writes under the old group's lock (held here, so the move waits).
            patchAgentJson(ja.folder, { name: 'x' })
            writeMap(root, ja.groupKey, { x: ja.uuid })
        })
        expect(await agreedName(a, ja.uuid, 'g2', await moving!)).toBe('x')
    })

    it('a leftover entry in the old map does not block the name there, and the claim drops it (F6)', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const b = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        await rename(a, 'al')
        await join(b)
        await group(a, 'ga')
        // leaveOldMap is best effort: simulate that it failed.
        writeMap(root, ja.groupKey, { al: ja.uuid })
        expect(await rename(b, 'al')).toMatchObject({ name: 'al', takeover: null })
        expect(Object.values(mapOf(root, ja.groupKey))).not.toContain(ja.uuid)
    })

    it('a crash after the claim (map names the mover, folder never moved) frees the name (F6)', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const c = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        await rename(a, 'al')
        writeMap(root, 'gx', { al: ja.uuid, ghost: '99999999-9999-4999-8999-999999999999' })
        const jc = await join(c)
        await group(c, 'gx')
        expect(await rename(c, 'al')).toMatchObject({ name: 'al' })
        expect(mapOf(root, 'gx')).toEqual({ al: jc.uuid })
    })

    it('a failed move gives a taken-over name and map entry back to the holder (F7)', async () => {
        const holderPid = livePid()
        const h = callFor(root, 'claude', { ppid: holderPid })
        const jh = await join(h)
        await group(h, 'g9')
        await rename(h, 'bob')
        const b = callFor(root, 'claude', { ppid: livePid() })
        const jb = await join(b)
        await rename(b, 'bob')
        await killLivePid(holderPid)
        fs.mkdirSync(path.join(agentDir(root, 'g9', jb.uuid), 'x'), { recursive: true }) // moveFolder refuses
        expect(await errorCode(group(b, 'g9'))).toBe('SUMMIT_IO')
        expect(mapOf(root, 'g9')).toEqual({ bob: jh.uuid })
        expect(agentJson(agentDir(root, 'g9', jh.uuid)).name).toBe('bob')
        expect(mapOf(root, jb.groupKey)).toEqual({ bob: jb.uuid })
    })

    it('a failure after the folder moved (host record write) moves it back and drops the claim', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const s = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        await join(s)
        await rename(a, 'mover')
        await send(s, { to: '@mover', message: 'kept' })
        fs.chmodSync(hostsDir(root), 0o555) // updateHost cannot write
        expect(await errorCode(group(a, 'g6'))).toBe('SUMMIT_IO')
        fs.chmodSync(hostsDir(root), 0o755)
        expect(foldersOf(root, ja.uuid)).toEqual([ja.groupKey])
        expect(mapOf(root, 'g6')).toEqual({})
        expect(mapOf(root, ja.groupKey)).toEqual({ mover: ja.uuid })
        expect(await readHost(root, ja.hostKey)).toMatchObject({ groupKey: ja.groupKey })
        expect((await read(a)).messages.map((m) => m.body)).toEqual(['kept'])
    })

    it('outside the lock, the new map never names the mover while its folder is elsewhere', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        await rename(a, 'walker')
        const { seen } = await watch(group(a, 'g7'), () =>
            mapOf(root, 'g7').walker === ja.uuid &&
            !fs.existsSync(agentDir(root, 'g7', ja.uuid)) &&
            !fs.existsSync(membersLock(root, 'g7'))
                ? 'claim without folder, lock free'
                : null,
        )
        expect(seen).toEqual([])
        expect(foldersOf(root, ja.uuid)).toEqual(['g7'])
    })

    it('a refused claim never moves the folder, not even for a moment', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const b = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        await join(b)
        await group(b, 'g8')
        await rename(b, 'same')
        await rename(a, 'same')
        const { out, seen } = await watch(errorCode(group(a, 'g8')), () =>
            fs.existsSync(agentDir(root, 'g8', ja.uuid)) ? 'folder in g8' : null,
        )
        expect(out).toBe('SUMMIT_NAME_TAKEN')
        expect(seen).toEqual([])
        expect((await members(a)).groupKey).toBe(ja.groupKey)
    })

    it('a move that waits for a read keeps the group lock however long it waits; its name stays its own (D4)', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const b = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        const jb = await join(b)
        await rename(a, 'x')
        await group(b, 'g2')
        let moving: Promise<unknown> | undefined
        let renaming: Promise<string | undefined> | undefined
        await withLock(
            cursorLock(ja.folder),
            async () => {
                moving = group(a, 'g2')
                await until(() => fs.existsSync(membersLock(root, 'g2')))
                // The move has held the lock for a minute: age alone never makes it stale.
                ageFile(membersLock(root, 'g2'), LOCK_STALE_MS * 6)
                renaming = errorCode(rename(b, 'x'))
                await sleep(300)
                expect(agentJson(agentDir(root, 'g2', jb.uuid)).name).toBeNull()
            },
            { mkdir: false },
        )
        await moving
        expect(await renaming).toBe('SUMMIT_NAME_TAKEN')
        expect(mapOf(root, 'g2')).toEqual({ x: ja.uuid })
        expect(agentJson(agentDir(root, 'g2', ja.uuid)).name).toBe('x')
    })

    it('a move waits for a read in progress; the read lock never stays behind in the moved folder', async () => {
        const a = callFor(root, 'claude', { ppid: livePid() })
        const ja = await join(a)
        let moving: Promise<unknown> | undefined
        await withLock(
            cursorLock(ja.folder),
            async () => {
                moving = group(a, 'g4')
                await sleep(150)
                expect(foldersOf(root, ja.uuid)).toEqual([ja.groupKey])
            },
            { mkdir: false },
        )
        await moving
        expect(foldersOf(root, ja.uuid)).toEqual(['g4'])
        expect(fs.existsSync(cursorLock(agentDir(root, 'g4', ja.uuid)))).toBe(false)
        const started = Date.now()
        expect((await read(a)).count).toBe(0)
        expect(Date.now() - started).toBeLessThan(2_000)
    })
})
