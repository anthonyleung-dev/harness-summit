// Acceptance 4: the Claude Code hook commands, fed stdin shaped like probes/claude.md, give the exact
// stdout / stderr / exit codes of SPEC §6, and SessionStart records the session the claude process runs
// now, which its MCP server reads (SPEC §3).
import fs from 'node:fs'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildNotice } from '../../src/core/notice.js'
import { signalPathFor } from '../../src/core/paths.js'
import { readSession, writeSessionSync } from '../../src/core/sessions.js'
import { join } from '../../src/flows/join.js'
import { whoami } from '../../src/flows/query.js'
import { read } from '../../src/flows/read.js'
import { rename } from '../../src/flows/rename.js'
import { send } from '../../src/flows/send.js'
import { callFor, errorCode, runCli, tmpRoot } from '../helpers/env.js'

// The hook's parent: runCli starts the CLI straight from this test process, as claude starts an
// exec-form hook (no shell), so this process plays the claude process.
const CLAUDE_PID = process.pid
const SID = '1bf60fec-35ac-496b-9fc6-915711f7e85f'
const notice = buildNotice([{ from: 'alice' }])

// Shapes copied from probes/claude.md (ready-*.txt line 3) and the FileChanged docs.
const sessionStartInput = (source: string, sessionId = SID) =>
    JSON.stringify({
        session_id: sessionId,
        transcript_path: '/home/x/.claude/projects/p/1bf60fec-35ac-496b-9fc6-915711f7e85f.jsonl',
        cwd: '/tmp/proj',
        hook_event_name: 'SessionStart',
        source,
        model: 'claude-opus-5-5',
    })
// FileChanged stdin carries the session the claude process runs NOW (common input field `session_id`).
const fileChangedInput = (filePath: string, event = 'change', sessionId = SID) =>
    JSON.stringify({
        session_id: sessionId,
        transcript_path: '/home/x/.claude/projects/p/1bf60fec-35ac-496b-9fc6-915711f7e85f.jsonl',
        cwd: '/tmp/proj',
        hook_event_name: 'FileChanged',
        file_path: filePath,
        event,
    })

describe('claude hooks', () => {
    const root = tmpRoot()
    const env = { HARNESS_SUMMIT_HOME: root, CLAUDE_PID: '' }
    const signal = signalPathFor(root, `claude-${SID}`)
    const receiver = callFor(root, 'claude', { hostPid: CLAUDE_PID, session: SID })
    const sender = callFor(root, 'claude')

    beforeAll(async () => {
        await join(receiver)
        await join(sender)
        await rename(sender, 'alice')
    })

    it('SessionStart records the session, arms its signal and prints only watchPaths when nothing is unread', async () => {
        const r = await runCli(['hook', 'claude-session-start'], { env, stdin: sessionStartInput('startup') })
        expect(r.code).toBe(0)
        expect(r.stderr).toBe('')
        expect(r.stdout).toBe(
            `{"hookSpecificOutput":{"hookEventName":"SessionStart","watchPaths":["${JSON.stringify(signal).slice(1, -1)}"]}}\n`,
        )
        expect(fs.existsSync(signal)).toBe(true)
        expect(await readSession(root, 'claude', CLAUDE_PID)).toBe(SID)
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
        // The same file written another way (Windows: forward slashes and a lower-case drive letter;
        // elsewhere: a `..` segment) is still our signal: both sides go through the one path normalizer.
        const other =
            process.platform === 'win32'
                ? signal[0]!.toLowerCase() + signal.slice(1).replace(/\\/g, '/')
                : `${path.dirname(signal)}/../.wake/${path.basename(signal)}`
        const again = await runCli(['hook', 'claude-file-changed'], { env, stdin: fileChangedInput(other) })
        expect(again.code).toBe(2)
    })

    it('SessionStart on resume re-arms the same path without truncating, and adds the unread notice', async () => {
        const before = fs.readFileSync(signal, 'utf8')
        expect(before.length).toBeGreaterThan(0)
        const r = await runCli(['hook', 'claude-session-start'], { env, stdin: sessionStartInput('resume') })
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

    it('keys the session by the hook parent pid; an inherited CLAUDE_PID that differs is ignored', async () => {
        const r = await runCli(['hook', 'claude-session-start'], {
            env: { HARNESS_SUMMIT_HOME: root, CLAUDE_PID: '424242' },
            stdin: sessionStartInput('startup', 'S-parent'),
            viaParent: true,
        })
        expect(JSON.parse(r.stdout).hookSpecificOutput.watchPaths).toEqual([signalPathFor(root, 'claude-S-parent')])
        expect(await readSession(root, 'claude', r.parentPid as number)).toBe('S-parent')
        expect(await readSession(root, 'claude', 424242)).toBeNull()
    })

    it('SessionStart without a session id arms nothing and never fails the session', async () => {
        const r = await runCli(['hook', 'claude-session-start'], { env, stdin: '{"source":"startup"}' })
        expect(r).toEqual({ code: 0, stdout: '', stderr: '' })
        expect(await readSession(root, 'claude', CLAUDE_PID)).toBe(SID)
    })

    it('notice CLI prints the notice for a host key, nothing when not joined', async () => {
        await send(sender, { to: (await join(receiver)).uuid, message: 'again' })
        const r = await runCli(['notice', '--host-key', `claude-${SID}`], { env })
        expect(r.stdout).toBe(notice + '\n')
        expect((await runCli(['notice', '--host-key', 'claude-1'], { env })).stdout).toBe('')
    })

    it('SessionStart on /clear (new session id) moves the server to a new agent; the old one stays', async () => {
        const r = await runCli(['hook', 'claude-session-start'], {
            env,
            stdin: sessionStartInput('clear', 'S-cleared'),
        })
        expect(JSON.parse(r.stdout).hookSpecificOutput).toEqual({
            hookEventName: 'SessionStart',
            watchPaths: [signalPathFor(root, 'claude-S-cleared')],
        })
        // The same claude process (same pid) now runs session S-cleared: its server sees a new host key.
        expect(await whoami(receiver)).toEqual({ joined: false, hostKey: 'claude-S-cleared' })
        expect((await runCli(['notice', '--host-key', `claude-${SID}`], { env })).stdout).toBe(notice + '\n')
        // FileChanged on the old session's signal (claude now runs S-cleared) is not ours any more.
        const old = await runCli(['hook', 'claude-file-changed'], {
            env,
            stdin: fileChangedInput(signal, 'change', 'S-cleared'),
        })
        expect(old).toEqual({ code: 0, stdout: '', stderr: '' })
    })
})

describe('session refresh by UserPromptSubmit and FileChanged (a server reconnected with /mcp)', () => {
    const root = tmpRoot()
    const env = { HARNESS_SUMMIT_HOME: root, CLAUDE_PID: '' }
    const sid = 'S-reconnect'
    // The server was reconnected now; SessionStart wrote the session file two minutes ago.
    const reconnected = () => ({ ...callFor(root, 'claude', { hostPid: CLAUDE_PID, session: sid }) })
    const sessionStartedLongAgo = () =>
        writeSessionSync(root, 'claude', CLAUDE_PID, sid, new Date(Date.now() - 2 * 60 * 1000))

    it('the reconnected server distrusts the old file, and trusts it after the next prompt', async () => {
        const call = reconnected()
        sessionStartedLongAgo()
        expect(await errorCode(whoami(call))).toBe('SUMMIT_NO_HOST_KEY')
        const r = await runCli(['hook', 'claude-prompt-submit'], {
            env,
            stdin: JSON.stringify({ session_id: sid, hook_event_name: 'UserPromptSubmit', prompt: 'hi' }),
        })
        // Prints nothing: stdout of UserPromptSubmit would become model context.
        expect(r).toEqual({ code: 0, stdout: '', stderr: '' })
        expect(await whoami(call)).toEqual({ joined: false, hostKey: `claude-${sid}` })
    })

    it('a wake (FileChanged) refreshes it too; an event without session_id writes nothing', async () => {
        const call = reconnected()
        sessionStartedLongAgo()
        const noId = await runCli(['hook', 'claude-prompt-submit'], { env, stdin: '{"prompt":"hi"}' })
        expect(noId).toEqual({ code: 0, stdout: '', stderr: '' })
        expect(await errorCode(whoami(call))).toBe('SUMMIT_NO_HOST_KEY')
        const wake = await runCli(['hook', 'claude-file-changed'], {
            env,
            stdin: JSON.stringify({
                session_id: sid,
                file_path: signalPathFor(root, `claude-${sid}`),
                event: 'change',
            }),
        })
        expect(wake.code).toBe(0)
        expect(await whoami(call)).toEqual({ joined: false, hostKey: `claude-${sid}` })
    })
})

describe('FileChanged never switches the session (team review R2)', () => {
    it('SessionStart S1, SessionStart clear S2, a late FileChanged for S1: the server still resolves S2', async () => {
        const root = tmpRoot()
        const env = { HARNESS_SUMMIT_HOME: root, CLAUDE_PID: '' }
        const start = (sid: string, source: string) =>
            runCli(['hook', 'claude-session-start'], { env, stdin: sessionStartInput(source, sid) })
        await start('S1', 'startup')
        const call = callFor(root, 'claude', { hostPid: CLAUDE_PID, session: 'S1' })
        await start('S2', 'clear')
        // A wake hook that began before /clear finishes now, with the old session id in its stdin.
        const late = await runCli(['hook', 'claude-file-changed'], {
            env,
            stdin: fileChangedInput(signalPathFor(root, 'claude-S1'), 'change', 'S1'),
        })
        expect(late.code).toBe(0)
        expect(await readSession(root, 'claude', CLAUDE_PID)).toBe('S2')
        expect(await whoami(call)).toEqual({ joined: false, hostKey: 'claude-S2' })
    })
})
