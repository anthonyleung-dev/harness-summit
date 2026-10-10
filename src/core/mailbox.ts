// Inbox of one agent folder: append (sender side), unread scan and cursor (owner side). SPEC §5.
import fs from 'node:fs/promises'

import { hasErrno, summitError } from './errors.js'
import { readJsonFile, writeJsonAtomic } from './fsx.js'
import { log } from './log.js'
import { cursorFile, FILE_MODE, inboxFile } from './paths.js'
import { formatRecord, parseRecords } from './records.js'
import {
    CursorSchema,
    NAME_PATTERN,
    UUID_PATTERN,
    type CorruptSpan,
    type Cursor,
    type MessageRecord,
} from './schemas.js'

export interface UnreadScan {
    records: MessageRecord[]
    // Cursor after every complete unread record and every corrupt span.
    nextCursor: Cursor
    // Spans that held no valid record (REVIEW M2). Reported once: the cursor moves past them.
    corrupt: CorruptSpan[]
}

// Purpose: append one record to `<folder>/<senderLabel>.md` with a single appendFile.
export async function appendRecord(folder: string, senderLabel: string, rec: MessageRecord): Promise<void> {
    const file = inboxFile(folder, senderLabel)
    try {
        await fs.appendFile(file, formatRecord(rec), { mode: FILE_MODE })
    } catch (err) {
        throw summitError('SUMMIT_IO', `cannot append to ${file}`, 'appendRecord', { file, id: rec.id }, err)
    }
    log('info', 'appendRecord', 'message appended', { file, id: rec.id })
}

// Purpose: read the owner's cursor (empty when missing).
export async function readCursor(folder: string): Promise<Cursor> {
    return (await readJsonFile(cursorFile(folder), CursorSchema)) ?? {}
}

// Purpose: bytes of `file` from `offset` to the end.
async function readFrom(file: string, offset: number): Promise<Buffer> {
    const fh = await fs.open(file, 'r')
    try {
        const { size } = await fh.stat()
        if (size <= offset) return Buffer.alloc(0)
        const buf = Buffer.alloc(size - offset)
        await fh.read(buf, 0, buf.length, offset)
        return buf
    } finally {
        await fh.close()
    }
}

// Purpose: tell whether a file name is a sender inbox: `<name>.md` or `<uuid>.md`. Any other file in
// the folder (notes a model wrote, editor files) is never parsed.
export function isInboxName(fileName: string): boolean {
    if (!fileName.endsWith('.md')) return false
    const label = fileName.slice(0, -'.md'.length)
    return NAME_PATTERN.test(label) || UUID_PATTERN.test(label)
}

// Purpose: every sender inbox file name in the folder.
async function inboxNames(folder: string): Promise<string[]> {
    try {
        return (await fs.readdir(folder)).filter(isInboxName).sort()
    } catch (err) {
        if (hasErrno(err, 'ENOENT')) return []
        throw summitError('SUMMIT_IO', `cannot list ${folder}`, 'inboxNames', { folder }, err)
    }
}

// Purpose: collect every record past the cursor in every inbox file, oldest first. Damaged content
// never makes this throw; it comes back in `corrupt` and in the log.
export async function scanUnread(folder: string): Promise<UnreadScan> {
    const cursor = await readCursor(folder)
    const nextCursor: Cursor = { ...cursor }
    const records: MessageRecord[] = []
    const corrupt: CorruptSpan[] = []
    for (const name of await inboxNames(folder)) {
        const offset = cursor[name] ?? 0
        const file = inboxFile(folder, name.slice(0, -'.md'.length))
        const parsed = parseRecords(await readFrom(file, offset))
        records.push(...parsed.records)
        for (const s of parsed.corrupt)
            corrupt.push({ file, offset: offset + s.offset, length: s.length, reason: s.reason })
        nextCursor[name] = offset + parsed.consumed
    }
    if (corrupt.length > 0) log('warn', 'scanUnread', 'corrupt inbox content skipped', { folder, corrupt })
    records.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    return { records, nextCursor, corrupt }
}

// Purpose: persist the cursor (only the folder owner calls this). Never creates the folder: a cursor
// write into a folder that moved would leave a ghost folder behind (REVIEW M1).
export async function writeCursor(folder: string, cursor: Cursor): Promise<void> {
    await writeJsonAtomic(cursorFile(folder), cursor, { mkdir: false })
    log('debug', 'writeCursor', 'cursor written', { folder })
}
