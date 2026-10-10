// Unit tests for the wake decision under concurrency (DELTA-REVIEW-1 F4, F5): the sender decides under
// the receiver's read lock, and it stamps its debounce claim before the wake command runs.
import { beforeEach, describe, expect, it } from 'vitest'

import { sleep } from '../../src/core/freshness.js'
import { withLock } from '../../src/core/lock.js'
import { scanUnread, writeCursor } from '../../src/core/mailbox.js'
import { cursorLock, lastWakeFile } from '../../src/core/paths.js'
import { join } from '../../src/flows/join.js'
import { read } from '../../src/flows/read.js'
import { send } from '../../src/flows/send.js'
import { callFor, codexMeta, recordingExec, tmpRoot } from '../helpers/env.js'
import { readJson } from '../helpers/state.js'

describe('wake decision under concurrency', () => {
    let root: string
    beforeEach(() => {
        root = tmpRoot()
    })

    it('a send during a read in progress waits for the read, then wakes for the mail the read missed (F4)', async () => {
        const rx = callFor(root, 'codex', { meta: codexMeta('T-rx') })
        const tx = callFor(root, 'claude')
        const jr = await join(rx)
        await join(tx)
        expect((await send(tx, { to: jr.uuid, message: 'm1' })).wake).toBe('sent')
        let second: ReturnType<typeof send> | undefined
        // The receiver's summit_read, step by step: it scans m1, a sender appends m2, it moves its cursor.
        await withLock(
            cursorLock(jr.folder),
            async () => {
                const scan = await scanUnread(jr.folder)
                expect(scan.records.map((r) => r.body)).toEqual(['m1'])
                second = send(tx, { to: jr.uuid, message: 'm2' })
                await sleep(150)
                await writeCursor(jr.folder, scan.nextCursor)
            },
            { mkdir: false },
        )
        expect((await second!).wake).toBe('sent')
        expect((await read(rx)).messages.map((m) => m.body)).toEqual(['m2'])
    })

    it('a second sender during a slow wake command sees the claim and skips: one paid turn (F5)', async () => {
        const slow = recordingExec(undefined, false, 400)
        const rx = callFor(root, 'codex', { meta: codexMeta('T-rx') })
        const a = callFor(root, 'claude', { exec: slow })
        const b = callFor(root, 'claude', { exec: slow })
        const jr = await join(rx)
        await join(a)
        await join(b)
        const first = send(a, { to: jr.uuid, message: 'from a' })
        await sleep(150)
        const second = await send(b, { to: jr.uuid, message: 'from b' })
        expect([(await first).wake, second.wake]).toEqual(['sent', 'skipped'])
        expect(slow.calls).toHaveLength(1)
    })

    it('a failed wake removes its own claim and never a later claim of another sender (F5)', async () => {
        const failing = recordingExec({ code: 1, stdout: '', stderr: 'boom' }, false, 400)
        const rx = callFor(root, 'codex', { meta: codexMeta('T-rx') })
        const a = callFor(root, 'claude', { exec: failing })
        const b = callFor(root, 'claude')
        const jr = await join(rx)
        await join(a)
        await join(b)
        const first = send(a, { to: jr.uuid, message: 'from a' })
        await sleep(150)
        // The receiver reads what a's wake announced; b's mail is new, so b claims and wakes.
        expect((await read(rx)).count).toBe(1)
        expect((await send(b, { to: jr.uuid, message: 'from b' })).wake).toBe('sent')
        const bClaim = readJson(lastWakeFile(jr.folder))
        expect((await first).wake).toBe('failed')
        expect(readJson(lastWakeFile(jr.folder))).toEqual(bClaim)
    })
})
