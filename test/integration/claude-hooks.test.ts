// Acceptance 4: the Claude Code hook commands, fed stdin shaped like probes/claude.md, give the exact
// stdout / stderr / exit codes of SPEC §6.
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildNotice } from '../../src/core/notice.js'
import { join } from '../../src/flows/join.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { callFor, runCli, tmpRoot } from '../helpers/env.js'

const CLAUDE_PID = 3009995
const notice = buildNotice([{ from: 'alice' }])

// Shapes copied from probes/claude.md (ready-*.txt line 3) and the FileChanged docs.
const sessionStartInput = (source: string) =>
    JSON.stringify({
        session_id: '1bf60fec-35ac-496b-9fc6-915711f7e85f',
        transcript_path: '/home/x/.claude/projects/p/1bf60fec-35ac-496b-9fc6-915711f7e85f.jsonl',
        cwd: '/tmp/proj',
        hook_event_name: 'SessionStart',
        source,
        model: 'claude-opus-5-5',
    })
const fileChangedInput = (filePath: string, event = 'change') =>
    JSON.stringify({
        session_id: '1bf60fec-35ac-496b-9fc6-915711f7e85f',
        transcript_path: '/home/x/.claude/projects/p/1bf60fec-35ac-496b-9fc6-915711f7e85f.jsonl',
        cwd: '/tmp/proj',
        hook_event_name: 'FileChanged',
        file_path: filePath,
        event,
    })

describe('claude hooks', () => {
    const root = tmpRoot()
    const env = { HARNESS_SUMMIT_HOME: root, CLAUDE_PID: String(CLAUDE_PID) }
    const signal = path.join(root, '.wake', `claude-${CLAUDE_PID}.signal`)
    const receiver = callFor(root, 'claude', { ppid: CLAUDE_PID })
    const sender = callFor(root, 'claude', { ppid: CLAUDE_PID + 1 })

    beforeAll(async () => {
        await join(receiver)
        await join(sender)
        await rename(sender, 'alice')
    })

    it('SessionStart arms the pid-keyed signal and prints only watchPaths when nothing is unread', async () => {
        const r = await runCli(['hook', 'claude-session-start'], { env, stdin: sessionStartInput('startup') })
        expect(r.code).toBe(0)
        expect(r.stderr).toBe('')
        expect(r.stdout).toBe(`{"hookSpecificOutput":{"hookEventName":"SessionStart","watchPaths":["${signal}"]}}\n`)
        expect(fs.existsSync(signal)).toBe(true)
    })

    it('FileChanged exits 0 with no output when nothing is unread', async () => {
        const r = await runCli(['hook', 'claude-file-changed'], { env, stdin: fileChangedInput(signal) })
        expect(r).toEqual({ code: 0, stdout: '', stderr: '' })
    })

    it('FileChanged exits 2 with the notice on stderr after a send; never prints watchPaths', async () => {
        await send(sender, { to: '@' + (await join(receiver)).uuid, message: 'secret body' })
        expect(fs.readFileSync(signal, 'utf8')).toMatch(/Z\n$/)
        const r = await runCli(['hook', 'claude-file-changed'], { env, stdin: fileChangedInput(signal) })
        expect(r).toEqual({ code: 2, stdout: '', stderr: notice + '\n' })
        expect(r.stderr).not.toContain('secret body')
    })

    it('SessionStart on /clear re-arms the same path without truncating, and adds the unread notice', async () => {
        const before = fs.readFileSync(signal, 'utf8')
        expect(before.length).toBeGreaterThan(0)
        const r = await runCli(['hook', 'claude-session-start'], { env, stdin: sessionStartInput('clear') })
        expect(r.code).toBe(0)
        expect(JSON.parse(r.stdout)).toEqual({
            hookSpecificOutput: { hookEventName: 'SessionStart', watchPaths: [signal], additionalContext: notice },
        })
        expect(fs.readFileSync(signal, 'utf8')).toBe(before)
    })

    it('FileChanged ignores other files and unlink events, and goes quiet after summit_read', async () => {
        const other = await runCli(['hook', 'claude-file-changed'], {
            env,
            stdin: fileChangedInput(path.join(root, 'x.signal')),
        })
        expect(other).toEqual({ code: 0, stdout: '', stderr: '' })
        const unlink = await runCli(['hook', 'claude-file-changed'], { env, stdin: fileChangedInput(signal, 'unlink') })
        expect(unlink.code).toBe(0)
        await read(receiver)
        const quiet = await runCli(['hook', 'claude-file-changed'], { env, stdin: fileChangedInput(signal) })
        expect(quiet).toEqual({ code: 0, stdout: '', stderr: '' })
    })

    it('falls back to the hook parent pid when CLAUDE_PID is unset', async () => {
        const r = await runCli(['hook', 'claude-session-start'], {
            env: { HARNESS_SUMMIT_HOME: root, CLAUDE_PID: '' },
            stdin: sessionStartInput('startup'),
            viaShell: true,
        })
        expect(JSON.parse(r.stdout).hookSpecificOutput.watchPaths).toEqual([
            path.join(root, '.wake', `claude-${r.shellPid}.signal`),
        ])
    })

    it('notice CLI prints the notice for a host key, nothing when not joined', async () => {
        await send(sender, { to: (await join(receiver)).uuid, message: 'again' })
        const r = await runCli(['notice', '--host-key', `claude-${CLAUDE_PID}`], { env })
        expect(r.stdout).toBe(notice + '\n')
        expect((await runCli(['notice', '--host-key', 'claude-1'], { env })).stdout).toBe('')
    })
})
