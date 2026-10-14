// Small file helpers with structured errors: validated JSON read, atomic JSON write, text read,
// existence checks. Every other module reads and writes files through these (one door each).
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { z } from 'zod'

import { hasErrno, summitError } from './errors.js'
import { sleep } from './freshness.js'
import { log } from './log.js'
import { DIR_MODE, FILE_MODE } from './paths.js'

// Purpose: read a text file, or null when it does not exist. Other read errors are SUMMIT_IO.
export async function readTextFile(file: string): Promise<string | null> {
    try {
        return await fs.readFile(file, 'utf8')
    } catch (err) {
        if (hasErrno(err, 'ENOENT') || hasErrno(err, 'ENOTDIR')) return null
        log('warn', 'readTextFile', 'read failed', { file, error: String(err) })
        throw summitError('SUMMIT_IO', `cannot read ${file}`, 'readTextFile', { file }, err)
    }
}

// Purpose: read and validate a JSON file. Returns null when the file does not exist.
export async function readJsonFile<S extends z.ZodType>(file: string, schema: S): Promise<z.infer<S> | null> {
    const text = await readTextFile(file)
    if (text === null) return null
    let raw: unknown
    try {
        raw = JSON.parse(text)
    } catch (err) {
        log('warn', 'readJsonFile', 'invalid JSON', { file })
        throw summitError('SUMMIT_CORRUPT_FILE', `invalid JSON in ${file}`, 'readJsonFile', { file }, err)
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
        log('warn', 'readJsonFile', 'schema mismatch', { file, issues: parsed.error.issues })
        throw summitError('SUMMIT_CORRUPT_FILE', `unexpected content in ${file}`, 'readJsonFile', { file })
    }
    return parsed.data
}

// Purpose: the one JSON text form of the project: pretty JSON plus a final newline.
export function jsonText(value: unknown, indent = 2): string {
    return JSON.stringify(value, null, indent) + '\n'
}

// Purpose: write JSON through a uniquely named temp file and a rename, so readers never see half a
// file. With `mkdir: false` a missing parent dir is an error (used where creating the dir would
// resurrect a folder that moved or was removed).
export async function writeJsonAtomic(file: string, data: unknown, opts: { mkdir?: boolean } = {}): Promise<void> {
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
    try {
        if (opts.mkdir !== false) await fs.mkdir(path.dirname(file), { recursive: true, mode: DIR_MODE })
        await fs.writeFile(tmp, jsonText(data), { mode: FILE_MODE })
        await renameRetry(tmp, file)
    } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
        log('warn', 'writeJsonAtomic', 'write failed', { file, error: String(err) })
        throw summitError('SUMMIT_IO', `cannot write ${file}`, 'writeJsonAtomic', { file }, err)
    }
}

// Errno codes of a file operation that another program blocks for a moment on Windows (an antivirus,
// an indexer or an editor holds the file open; a name still "delete pending"). Linux and macOS do not
// raise them for a busy file; there they mean a real refusal.
const BUSY_CODES = ['EPERM', 'EBUSY', 'EACCES']

// Purpose: tell whether an error is one of the "busy on Windows" codes (the one definition).
export function isBusyErrno(err: unknown): boolean {
    return BUSY_CODES.some((c) => hasErrno(err, c))
}
// Backoff of renameRetry: 6 tries, about 1 s in total.
const RENAME_DELAYS_MS = [20, 50, 100, 200, 300, 400]

// Purpose: the one rename door (XPLAT-AUDIT D5, D6, D7): rename `from` to `to`, and retry with backoff
// while the error is EPERM, EBUSY or EACCES. A rename that still fails after the retries throws the last
// error; it never counts as done. Any other error (ENOENT, EXDEV, ...) throws at once.
export async function renameRetry(from: string, to: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await fs.rename(from, to)
            return
        } catch (err) {
            const delay = RENAME_DELAYS_MS[attempt]
            if (delay === undefined || !isBusyErrno(err)) throw err
            log('warn', 'renameRetry', 'rename blocked; retrying', { from, to, attempt, error: String(err) })
            await sleep(delay)
        }
    }
}

// Purpose: what is at a path (following symlinks): 'file', 'dir', 'other', or null when nothing is there (also
// when a parent is not a dir). Other stat errors are SUMMIT_IO with the path.
export async function pathKind(p: string): Promise<'file' | 'dir' | 'other' | null> {
    try {
        const st = await fs.stat(p)
        return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
    } catch (err) {
        if (hasErrno(err, 'ENOENT') || hasErrno(err, 'ENOTDIR')) return null
        log('warn', 'pathKind', 'stat failed', { path: p, error: String(err) })
        throw summitError('SUMMIT_IO', `cannot stat ${p}`, 'pathKind', { path: p }, err)
    }
}

// Purpose: tell whether a path exists; with `kind: 'dir'` or `'file'`, whether it is one.
export async function pathExists(p: string, kind: 'any' | 'dir' | 'file' = 'any'): Promise<boolean> {
    try {
        const st = await fs.stat(p)
        return kind === 'any' || (kind === 'dir' ? st.isDirectory() : st.isFile())
    } catch {
        return false
    }
}
