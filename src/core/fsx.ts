// Small file helpers with structured errors: validated JSON read, atomic JSON write, text read,
// existence checks. Every other module reads and writes files through these (one door each).
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { z } from 'zod'

import { hasErrno, summitError } from './errors.js'
import { log } from './log.js'

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
        if (opts.mkdir !== false) await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(tmp, jsonText(data))
        await fs.rename(tmp, file)
    } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => undefined)
        log('warn', 'writeJsonAtomic', 'write failed', { file, error: String(err) })
        throw summitError('SUMMIT_IO', `cannot write ${file}`, 'writeJsonAtomic', { file }, err)
    }
}

// Purpose: tell whether a path exists; with `kind: 'dir'`, whether it is a directory.
export async function pathExists(p: string, kind: 'any' | 'dir' = 'any'): Promise<boolean> {
    try {
        const st = await fs.stat(p)
        return kind === 'any' || st.isDirectory()
    } catch {
        return false
    }
}
