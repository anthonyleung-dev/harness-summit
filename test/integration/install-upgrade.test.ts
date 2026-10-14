// Upgrade paths of install (SPEC §8), with a stubbed exec: the Claude plugin copy is refreshed with
// `claude plugin update` after a change (the sync action), and a file an earlier release wrote and this one
// no longer renders is pruned, with uninstall's safety. An earlier release is simulated two ways: another
// launch (so every rendered file changes), and a state entry for a file only the "old" release rendered.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { SUMMIT_VERSION } from '../../src/core/version.js'
import { runInstall, runUninstall } from '../../src/install/install.js'
import { loadState, saveState, sha } from '../../src/install/state.js'
import { seededHome } from '../helpers/env.js'
import { changingArgv, claudeExec, TEST_LAUNCH, testLaunch } from '../helpers/install.js'

const oldLaunch = testLaunch({ cli: '/opt/old/dist/cli.js' })
const launch = TEST_LAUNCH
const UPDATE = ['claude', 'plugin', 'update', 'harness-summit@harness-summit', '--scope', 'user']
const argv = changingArgv

// Purpose: a temp home where the "old" release installed `harnesses`, and a fresh recording exec.
async function oldInstall(harnesses: ('claude' | 'codex')[] = ['claude']) {
    const home = seededHome()
    await runInstall({ harnesses, home, dryRun: false, exec: claudeExec(), launch: oldLaunch })
    return { home, exec: claudeExec(), opts: { harnesses, home, dryRun: false } }
}

// Purpose: make the state record `rel` as a file install wrote (as an older release would have), in a dir
// install created.
async function recordOldFile(home: string, rel: string, content = 'old skill\n'): Promise<string> {
    const file = path.join(home, rel)
    const state = await loadState(home)
    if (!fs.existsSync(path.dirname(file))) state.dirs.push(path.dirname(file))
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    state.files[file] = sha(content)
    await saveState(home, state)
    return file
}

describe('Claude plugin refresh on upgrade', () => {
    it('a fresh install runs no update and records the version', async () => {
        const home = seededHome()
        const exec = claudeExec()
        await runInstall({ harnesses: ['claude'], home, dryRun: false, exec, launch })
        expect(argv(exec).map((a) => a[2])).toEqual(['marketplace', 'install'])
        expect((await loadState(home)).synced).toEqual({ 'claude-plugin-update': SUMMIT_VERSION })
    })

    it('runs the update when the plugin files changed, then nothing on the next run', async () => {
        const { home, exec, opts } = await oldInstall()
        const lines = await runInstall({ ...opts, exec, launch })
        expect(argv(exec)).toEqual([UPDATE])
        expect(lines).toContain(`run     ${UPDATE.join(' ')} (files changed)`)
        expect((await loadState(home)).synced?.['claude-plugin-update']).toBe(SUMMIT_VERSION)
        const again = await runInstall({ ...opts, exec, launch })
        expect(argv(exec)).toEqual([UPDATE])
        expect(again.every((l) => l.startsWith('ok '))).toBe(true)
    })

    it('runs the update when the recorded version differs, even with no file change', async () => {
        const home = seededHome()
        await runInstall({ harnesses: ['claude'], home, dryRun: false, exec: claudeExec(), launch })
        const state = await loadState(home)
        delete state.synced // a state written by 1.0.1 or earlier
        await saveState(home, state)
        const exec = claudeExec()
        const lines = await runInstall({ harnesses: ['claude'], home, dryRun: false, exec, launch })
        expect(argv(exec)).toEqual([UPDATE])
        expect(lines).toContain(`run     ${UPDATE.join(' ')} (recorded none, now ${SUMMIT_VERSION})`)
    })

    it('does not update before install has installed the plugin', async () => {
        const home = seededHome()
        const exec = claudeExec()
        await runInstall({ harnesses: ['claude'], home, dryRun: false, exec, launch: oldLaunch })
        const state = await loadState(home)
        delete state.execs['claude-plugin'] // the plugin install never ran (failed half way)
        await saveState(home, state)
        const exec2 = claudeExec()
        await runInstall({ harnesses: ['claude'], home, dryRun: false, exec: exec2, launch })
        expect(argv(exec2).map((a) => a[2])).toEqual(['install'])
    })

    it('dry run reports the update and runs nothing', async () => {
        const { home, exec, opts } = await oldInstall()
        const before = fs.readFileSync(path.join(home, '.local/share/harness-summit/install-state.json'), 'utf8')
        const lines = await runInstall({ ...opts, dryRun: true, exec, launch })
        expect(lines).toContain(`run     ${UPDATE.join(' ')} (files changed)`)
        expect(argv(exec)).toEqual([])
        expect(fs.readFileSync(path.join(home, '.local/share/harness-summit/install-state.json'), 'utf8')).toBe(before)
    })

    it('a failed update warns, install finishes, and the next run retries', async () => {
        const { home, opts } = await oldInstall(['claude', 'codex'])
        const failing = claudeExec(() => ({ code: 1, stdout: '', stderr: 'boom' }))
        const lines = await runInstall({ ...opts, exec: failing, launch })
        expect(lines.some((l) => l.startsWith('warn    claude-plugin-update failed (SUMMIT_EXEC_FAILED'))).toBe(true)
        expect(lines.some((l) => l.includes(path.join(home, '.codex', 'config.toml')))).toBe(true)
        expect((await loadState(home)).synced).toBeUndefined()
        const exec = claudeExec()
        await runInstall({ ...opts, exec, launch })
        expect(argv(exec)).toEqual([UPDATE])
    })

    it('uninstall never undoes the update and forgets its record', async () => {
        const { home, exec, opts } = await oldInstall()
        await runInstall({ ...opts, exec, launch })
        await runUninstall({ ...opts, exec, launch })
        expect(argv(exec).slice(1)).toEqual([
            ['claude', 'plugin', 'uninstall', 'harness-summit@harness-summit'],
            ['claude', 'plugin', 'marketplace', 'remove', 'harness-summit'],
        ])
        expect(fs.existsSync(path.join(home, '.local/share/harness-summit'))).toBe(false)
    })
})

describe('pruning files this release no longer renders', () => {
    const OLD_SKILL = '.codex/skills/summit-old/SKILL.md'

    it('removes an unchanged old file and the dir install created for it', async () => {
        const { home, exec, opts } = await oldInstall(['codex'])
        const file = await recordOldFile(home, OLD_SKILL)
        const lines = await runInstall({ ...opts, exec, launch })
        expect(lines).toContain(`remove  ${file}`)
        expect(fs.existsSync(path.dirname(file))).toBe(false)
        const state = await loadState(home)
        expect(state.files[file]).toBeUndefined()
        expect(state.dirs).not.toContain(path.dirname(file))
    })

    it('keeps and reports a file the user changed, and stops owning it', async () => {
        const { home, exec, opts } = await oldInstall(['codex'])
        const file = await recordOldFile(home, OLD_SKILL)
        fs.writeFileSync(file, 'my edit\n')
        const lines = await runInstall({ ...opts, exec, launch })
        expect(lines).toContain(`keep    ${file} (changed since install)`)
        expect(fs.readFileSync(file, 'utf8')).toBe('my edit\n')
        expect((await loadState(home)).files[file]).toBeUndefined()
        await runUninstall({ ...opts, exec, launch })
        expect(fs.readFileSync(file, 'utf8')).toBe('my edit\n')
    })

    it('never touches a user file install did not write, even in its own dir', async () => {
        const { home, exec, opts } = await oldInstall(['codex'])
        const mine = path.join(home, '.codex/skills/my-own/SKILL.md')
        fs.mkdirSync(path.dirname(mine), { recursive: true })
        fs.writeFileSync(mine, 'mine\n')
        const lines = await runInstall({ ...opts, exec, launch })
        expect(lines.some((l) => l.includes('my-own'))).toBe(false)
        await runUninstall({ ...opts, exec, launch })
        expect(fs.readFileSync(mine, 'utf8')).toBe('mine\n')
    })

    it('dry run reports the removal and deletes nothing', async () => {
        const { home, exec, opts } = await oldInstall(['codex'])
        const file = await recordOldFile(home, OLD_SKILL)
        const lines = await runInstall({ ...opts, dryRun: true, exec, launch })
        expect(lines).toContain(`remove  ${file}`)
        expect(fs.readFileSync(file, 'utf8')).toBe('old skill\n')
        expect((await loadState(home)).files[file]).toBe(sha('old skill\n'))
    })

    it('prunes only the harnesses this run installs', async () => {
        const { home, exec } = await oldInstall(['claude', 'codex'])
        const file = await recordOldFile(home, OLD_SKILL)
        const lines = await runInstall({ harnesses: ['claude'], home, dryRun: false, exec, launch })
        expect(lines.some((l) => l.includes('summit-old'))).toBe(false)
        expect(fs.existsSync(file)).toBe(true)
    })

    it('a pruned Claude skill triggers the plugin refresh', async () => {
        const home = seededHome()
        await runInstall({ harnesses: ['claude'], home, dryRun: false, exec: claudeExec(), launch })
        const rel = '.local/share/harness-summit/claude-marketplace/claude/skills/summit-old/SKILL.md'
        const file = await recordOldFile(home, rel)
        // Claude copies the marketplace folder at update time: the emptied skill dir must be gone by then.
        const dirAtUpdate: boolean[] = []
        const exec = claudeExec(() => {
            dirAtUpdate.push(fs.existsSync(path.dirname(file)))
            return { code: 0, stdout: '', stderr: '' }
        })
        const lines = await runInstall({ harnesses: ['claude'], home, dryRun: false, exec, launch })
        expect(lines).toContain(`remove  ${file}`)
        expect(argv(exec)).toEqual([UPDATE])
        expect(dirAtUpdate).toEqual([false])
    })

    it('a recorded dir the user replaced with a file survives install prune and uninstall', async () => {
        for (const fn of [runInstall, runUninstall]) {
            const { home, exec, opts } = await oldInstall(['codex'])
            const file = await recordOldFile(home, OLD_SKILL)
            const dir = path.dirname(file)
            fs.rmSync(dir, { recursive: true })
            fs.writeFileSync(dir, 'my file\n')
            const lines = await fn({ ...opts, exec, launch })
            expect(fs.readFileSync(dir, 'utf8')).toBe('my file\n')
            expect(lines).toContain(`keep    ${dir} (user's file in the way)`)
            expect((await loadState(home)).dirs).not.toContain(dir)
        }
    })

    it('uninstall also removes an old file the state still records', async () => {
        const { home, exec, opts } = await oldInstall(['codex'])
        const file = await recordOldFile(home, OLD_SKILL)
        await runUninstall({ ...opts, exec, launch })
        expect(fs.existsSync(file)).toBe(false)
        expect(fs.existsSync(path.join(home, '.local/share/harness-summit'))).toBe(false)
    })
})
