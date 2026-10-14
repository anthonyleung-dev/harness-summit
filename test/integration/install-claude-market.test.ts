// The Claude marketplace-name clash (claudeMarket.ts): Claude Code keeps one marketplace per name, so an
// install over a public-plugin marketplace of the same name stops before any write with the fix. A list
// that cannot be read leaves install as it was. `claude` is stubbed: no harness CLI runs.
import { describe, expect, it } from 'vitest'

import { parseMarketList } from '../../src/install/claudeMarket.js'
import { doctorReport } from '../../src/install/doctor.js'
import { runInstall } from '../../src/install/install.js'
import { claudeMarketDir } from '../../src/install/plan.js'
import { loadState, saveState } from '../../src/install/state.js'
import { recordingExec, seededHome, snapshot } from '../helpers/env.js'
import { changingArgv, claudeExec, TEST_LAUNCH } from '../helpers/install.js'

const launch = TEST_LAUNCH
const PUBLIC = { name: 'harness-summit', source: 'github', repo: 'anthonyleung-dev/harness-summit' }

// Purpose: a stubbed claude whose `marketplace list --json` answers `stdout` with exit `code`; every
// other command exits 0 with no output.
function listing(entries: object[] | string, code = 0) {
    const stdout = typeof entries === 'string' ? entries : JSON.stringify(entries) + '\n'
    return recordingExec((req) =>
        req.args.join(' ') === 'plugin marketplace list --json'
            ? { code, stdout, stderr: '' }
            : { code: 0, stdout: '', stderr: '' },
    )
}

// Purpose: the claude argv of each recorded call.
function claudeArgs(exec: ReturnType<typeof recordingExec>): string[][] {
    return exec.calls.filter((c) => c.req.cmd === 'claude').map((c) => c.req.args)
}

describe('install --harness claude with a harness-summit marketplace from another source', () => {
    for (const dryRun of [false, true]) {
        it(`stops before any write with the fix (dryRun=${dryRun})`, async () => {
            const home = seededHome()
            const before = snapshot(home)
            const exec = listing([{ name: 'other', source: 'directory', path: '/x' }, PUBLIC])
            const run = runInstall({ harnesses: ['claude', 'codex'], home, dryRun, exec, launch })
            await expect(run).rejects.toMatchObject({
                code: 'SUMMIT_INSTALL_CONFLICT',
                fn: 'checkClaudeMarketplace',
                inputs: { name: 'harness-summit', source: 'github', from: PUBLIC.repo },
            })
            const err = (await run.catch((e: unknown) => e)) as Error
            expect(err.message).toContain(
                'in Claude Code run /plugin uninstall harness-summit@harness-summit, then /plugin marketplace remove harness-summit',
            )
            expect(err.message).toContain('--harness codex,pi,omp,opencode')
            expect(err.message).not.toContain('&&')
            expect(snapshot(home)).toEqual(before)
            expect(claudeArgs(exec).every((a) => a.join(' ') === 'plugin marketplace list --json')).toBe(true)
        })
    }

    it('goes on when the harness-summit marketplace is install’s own directory', async () => {
        const home = seededHome()
        const exec = listing([{ name: 'harness-summit', source: 'directory', path: claudeMarketDir(home) }])
        await runInstall({ harnesses: ['claude'], home, dryRun: false, exec, launch })
        expect(claudeArgs(exec).map((a) => a.slice(0, 3).join(' '))).toEqual([
            'plugin marketplace list',
            'plugin marketplace add',
            'plugin install harness-summit@harness-summit',
        ])
        expect((await doctorReport(home)).find((l) => l.startsWith('claude'))).toMatch(
            /^claude\s+registered=yes .* route=install$/,
        )
    })

    it('goes on when the list cannot be read (exit 1, no JSON), with a visible warn line', async () => {
        for (const exec of [listing([PUBLIC], 1), listing('Configured marketplaces:\n  harness-summit')]) {
            const home = seededHome()
            const lines = await runInstall({ harnesses: ['claude'], home, dryRun: false, exec, launch })
            expect(claudeArgs(exec)).toHaveLength(3)
            expect(lines[0]).toBe(
                'warn    could not read `claude plugin marketplace list --json`; install goes on without this check',
            )
        }
    })

    it('reads pretty-printed JSON after a warning line, and stops on the public marketplace there', async () => {
        const exec = listing(`Warning: settings file has an unknown key\n${JSON.stringify([PUBLIC], null, 2)}\n`)
        const run = runInstall({ harnesses: ['claude'], home: seededHome(), dryRun: false, exec, launch })
        await expect(run).rejects.toMatchObject({ code: 'SUMMIT_INSTALL_CONFLICT' })
    })

    it('never asks claude when claude is not among the harnesses', async () => {
        const exec = listing([PUBLIC])
        await runInstall({ harnesses: ['codex'], home: seededHome(), dryRun: false, exec, launch })
        expect(claudeArgs(exec)).toEqual([])
    })
})

describe('doctor without an install record for Claude Code', () => {
    it('says that it cannot see a /plugin install instead of a bare "registered=no"', async () => {
        const line = (await doctorReport(seededHome())).find((l) => l.startsWith('claude'))
        expect(line).toMatch(/^claude\s+registered=no .* route=unknown \(doctor does not detect a \/plugin install\)$/)
    })
})

describe('parseMarketList', () => {
    it('reads the whole stdout or its last line, else null', () => {
        const one = [{ name: 'a', source: 'github', repo: 'o/r', installLocation: '/c' }]
        expect(parseMarketList(JSON.stringify(one))).toEqual(one)
        expect(parseMarketList(`notice line\n${JSON.stringify(one)}`)).toEqual(one)
        expect(parseMarketList('Configured marketplaces:')).toBeNull()
        expect(parseMarketList('[{"name": 1}]')).toBeNull()
        expect(parseMarketList(`warning: x\n${JSON.stringify(one, null, 2)}\n`)).toEqual(one)
        expect(parseMarketList('a [ b ] c')).toBeNull()
    })
})

// What Claude Code 2.1.299 printed on stderr (exit 1) for `claude plugin update harness-summit@harness-summit
// --scope user` in a temp home, after `/plugin uninstall` and after `/plugin marketplace remove`.
const NOT_INSTALLED =
    '✘ Failed to update plugin "harness-summit@harness-summit": Plugin "harness-summit" is not installed'
const NOT_FOUND = '✘ Failed to update plugin "harness-summit@harness-summit": Plugin "harness-summit" not found'

describe('a plugin removed by hand while the state says installed', () => {
    // Purpose: a temp home where install installed the Claude plugin.
    async function installed(): Promise<string> {
        const home = seededHome()
        await runInstall({ harnesses: ['claude'], home, dryRun: false, exec: claudeExec(), launch })
        return home
    }

    it('a re-run sees it missing in `claude plugin list --json` and installs it again', async () => {
        const home = await installed()
        const exec = claudeExec(undefined, false)
        const lines = await runInstall({ harnesses: ['claude'], home, dryRun: false, exec, launch })
        expect(lines[0]).toBe(
            'warn    harness-summit@harness-summit is no longer installed in Claude Code (removed by hand?); installing it again',
        )
        expect(changingArgv(exec).map((a) => a.slice(1, 4).join(' '))).toEqual([
            'plugin marketplace add',
            'plugin install harness-summit@harness-summit',
        ])
        expect((await loadState(home)).execs).toEqual({ 'claude-marketplace': true, 'claude-plugin': true })
        const again = claudeExec()
        await runInstall({ harnesses: ['claude'], home, dryRun: false, exec: again, launch })
        expect(changingArgv(again)).toEqual([])
    })

    it('dry run reports the reinstall and keeps the state', async () => {
        const home = await installed()
        const before = await loadState(home)
        const lines = await runInstall({
            harnesses: ['claude'],
            home,
            dryRun: true,
            exec: claudeExec(undefined, false),
            launch,
        })
        expect(lines).toContain('run     claude plugin install harness-summit@harness-summit --scope user')
        expect(await loadState(home)).toEqual(before)
    })

    it('with an unreadable plugin list, a failed update that says so drops the records; the next run installs', async () => {
        for (const [stderr, dropped] of [
            [NOT_INSTALLED, ['claude-plugin']],
            [NOT_FOUND, ['claude-marketplace', 'claude-plugin']],
        ] as const) {
            const home = await installed()
            const state = await loadState(home)
            delete state.synced // makes the update run
            await saveState(home, state)
            const failing = recordingExec((req) =>
                req.args[1] === 'update' ? { code: 1, stdout: '', stderr } : { code: 0, stdout: '', stderr: '' },
            )
            const lines = await runInstall({ harnesses: ['claude'], home, dryRun: false, exec: failing, launch })
            expect(lines.some((l) => l.startsWith('warn    claude-plugin-update: the plugin'))).toBe(true)
            const execs = (await loadState(home)).execs
            for (const id of dropped) expect(execs[id], id).toBeUndefined()
            const next = claudeExec()
            await runInstall({ harnesses: ['claude'], home, dryRun: false, exec: next, launch })
            expect(changingArgv(next).map((a) => a[2])).toEqual(
                dropped.length === 2 ? ['marketplace', 'install'] : ['install'],
            )
        }
    })
})
