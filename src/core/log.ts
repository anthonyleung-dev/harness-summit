// Logger. Writes JSON lines to <root>/.logs/<date>.log and, when enabled, to stderr. It never writes
// to stdout: in the MCP server stdout is the protocol, and in hooks stdout is the hook result.
import fs from 'node:fs'
import path from 'node:path'

import { DIR_MODE, FILE_MODE, logsDir, summitRoot } from './paths.js'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

interface LogConfig {
    stderr: boolean
    file: boolean
    component: string
}

const config: LogConfig = { stderr: false, file: true, component: 'cli' }

// Purpose: choose the sinks for this process. The MCP server enables stderr; hooks keep it off
// because Claude Code shows hook stderr to the model.
export function configureLog(options: Partial<LogConfig>): void {
    Object.assign(config, options)
}

// Purpose: path of today's log file under the current root.
export function logFilePath(now: Date = new Date()): string {
    return path.join(logsDir(summitRoot()), `${now.toISOString().slice(0, 10)}.log`)
}

// Purpose: write one structured log line. Logging failures are swallowed on purpose: a full disk
// must not break message delivery.
export function log(level: LogLevel, fn: string, msg: string, data: Record<string, unknown> = {}): void {
    const now = new Date()
    const line = JSON.stringify({
        t: now.toISOString(),
        level,
        pid: process.pid,
        c: config.component,
        fn,
        msg,
        ...data,
    })
    if (config.file) writeLogLine(logFilePath(now), line)
    if (config.stderr) {
        try {
            process.stderr.write(line + '\n')
        } catch {
            // ignore: stderr closed
        }
    }
}

// Purpose: append one line to the log file, swallowing errors (see log()).
function writeLogLine(file: string, line: string): void {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: DIR_MODE })
        fs.appendFileSync(file, line + '\n', { mode: FILE_MODE })
    } catch {
        // ignore: see log()
    }
}
