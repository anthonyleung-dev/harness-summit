// Shared test helpers for the on-disk summit state: read and tamper with agent.json, host records and
// name maps, and find where an agent folder lives. Paths come from src/core/paths.ts (one door).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { vi } from 'vitest'

import { formatLockOwner } from '../../src/core/lock.js'
import { agentDir, aliveFile, groupDir, hostFile, membersFile, sessionFile } from '../../src/core/paths.js'

// Purpose: run `action` once, at the first read of a group's members.json: a parallel call that lands
// while a flow reads the name map under its lock. Undo with vi.restoreAllMocks().
export function onMapRead(root: string, groupKey: string, action: () => unknown): void {
    const realRead = fsp.readFile
    let fired = false
    vi.spyOn(fsp, 'readFile').mockImplementation(async (file, opts) => {
        if (!fired && String(file) === membersFile(root, groupKey)) {
            fired = true
            await action()
        }
        return await realRead(file, opts)
    })
}

// Purpose: move an agent folder to `to` the way a parallel summit_group does (one rename).
export function moveFolder(from: string, to: string): void {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
}

// Purpose: the parsed content of one JSON file.
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test data of any shape
export function readJson(file: string): Record<string, any> {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
}

// Purpose: agent.json of the agent folder `folder`.
export function agentJson(folder: string) {
    return readJson(path.join(folder, 'agent.json'))
}

// Purpose: overwrite fields of agent.json in `folder` (simulates another process or an old record).
export function patchAgentJson(folder: string, patch: Record<string, unknown>): void {
    fs.writeFileSync(path.join(folder, 'agent.json'), JSON.stringify({ ...agentJson(folder), ...patch }))
}

// Purpose: the host record of `hostKey`, or null when there is none.
export function hostJson(root: string, hostKey: string) {
    const file = hostFile(root, hostKey)
    return fs.existsSync(file) ? readJson(file) : null
}

// Purpose: overwrite fields of the host record of `hostKey`.
export function patchHostJson(root: string, hostKey: string, patch: Record<string, unknown>): void {
    fs.writeFileSync(hostFile(root, hostKey), JSON.stringify({ ...hostJson(root, hostKey), ...patch }))
}

// Purpose: the name map of a group as a plain object ({} when the group has no members.json).
export function mapOf(root: string, groupKey: string): Record<string, string> {
    const file = membersFile(root, groupKey)
    return fs.existsSync(file) ? readJson(file).members : {}
}

// Purpose: write the name map of a group directly (simulates a crash that left an entry behind).
export function writeMap(root: string, groupKey: string, members: Record<string, string>): void {
    fs.mkdirSync(groupDir(root, groupKey), { recursive: true })
    fs.writeFileSync(membersFile(root, groupKey), JSON.stringify({ version: 1, members }))
}

// Purpose: the groups that hold a folder for `uuid`.
export function foldersOf(root: string, uuid: string): string[] {
    return fs.readdirSync(root).filter((g) => !g.startsWith('.') && fs.existsSync(agentDir(root, g, uuid)))
}

// How a test lock file looks: its age (mtime moved into the past) and, with `legacy`, the owner line
// of an older server (`round2`: `<token> <pid> <ISO time>`; `round3`: `<token> <pid> <start> <ISO time>`).
export interface LockLineOptions {
    ageMs?: number
    legacy?: 'round2' | 'round3'
}

// Purpose: the owner line of a lock held by another holder (formatLockOwner, the one format), or an older
// server's line.
export function lockLine(token: string, opts: LockLineOptions = {}): string {
    const at = new Date('2026-10-10T00:00:00.000Z')
    if (opts.legacy === 'round2') return `${token} 4242 ${at.toISOString()}\n`
    if (opts.legacy === 'round3') return `${token} 4242 9001 ${at.toISOString()}\n`
    return formatLockOwner(token, at)
}

// Purpose: write a lock file left by another holder (lockLine), its mtime moved `opts.ageMs` into the
// past (a lock nobody refreshed for that long). Returns the content.
export function writeLockFile(file: string, token: string, opts: LockLineOptions = {}): string {
    const content = lockLine(token, opts)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    if ((opts.ageMs ?? 0) > 0) ageFile(file, opts.ageMs ?? 0)
    return content
}

// Purpose: make the heartbeat of `hostKey` `ageMs` old (its server stopped beating that long ago: the
// session ended). Creates the heartbeat file when it is missing.
export function ageBeat(root: string, hostKey: string, ageMs: number): void {
    const file = aliveFile(root, hostKey)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (!fs.existsSync(file)) fs.writeFileSync(file, '{}')
    ageFile(file, ageMs)
}

// Purpose: record that host process `pid` of `harness` runs session `sessionId` now, as the Claude
// SessionStart hook or the OMP extension does (src/core/sessions.ts format).
export function writeSessionFile(root: string, harness: string, pid: number, sessionId: string): void {
    const file = sessionFile(root, harness, pid)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ sessionId, at: new Date().toISOString() }))
}

// Purpose: age in ms of the file at `file` (time since its mtime).
export function fileAge(file: string): number {
    return Date.now() - fs.statSync(file).mtimeMs
}

// Purpose: move the mtime of `file` `ageMs` into the past.
export function ageFile(file: string, ageMs: number): void {
    const when = (Date.now() - ageMs) / 1000
    fs.utimesSync(file, when, when)
}
