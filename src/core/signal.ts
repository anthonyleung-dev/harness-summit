// Signal-file protocol for claude/pi/omp hosts (SPEC §6). The receiver side arms the file without
// truncating it (a truncation fires a change event); the sender side overwrites it with a timestamp.
import fs from 'node:fs/promises'
import path from 'node:path'

import { summitError } from './errors.js'
import { log } from './log.js'
import { DIR_MODE, FILE_MODE } from './paths.js'

// Purpose: make sure the signal file exists without changing its content (receiver side, arm).
export async function ensureSignal(signalPath: string): Promise<void> {
    try {
        await fs.mkdir(path.dirname(signalPath), { recursive: true, mode: DIR_MODE })
        const fh = await fs.open(signalPath, 'a', FILE_MODE)
        await fh.close()
    } catch (err) {
        throw summitError('SUMMIT_IO', `cannot arm ${signalPath}`, 'ensureSignal', { signalPath }, err)
    }
    log('debug', 'ensureSignal', 'signal armed', { signalPath })
}

// Purpose: ring the signal: overwrite it with one timestamp line (sender side).
export async function ringSignal(signalPath: string, now: Date = new Date()): Promise<void> {
    try {
        await fs.mkdir(path.dirname(signalPath), { recursive: true, mode: DIR_MODE })
        await fs.writeFile(signalPath, `${now.toISOString()}\n`, { mode: FILE_MODE })
    } catch (err) {
        throw summitError('SUMMIT_IO', `cannot write ${signalPath}`, 'ringSignal', { signalPath }, err)
    }
    log('info', 'ringSignal', 'signal written', { signalPath })
}
