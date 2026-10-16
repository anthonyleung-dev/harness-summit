// A re-install after the launch changed (SPEC §8): the owner moves from a dev checkout to the npm package,
// upgrades node, or moves the package, and runs install once. Every registration must then start the new
// node and CLI, even when its file is unchanged since the last install; a third run changes nothing; uninstall
// still restores each user file byte for byte; doctor names a registration that starts another CLI.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { HARNESSES } from '../../src/core/schemas.js'
import { BACKUP_SUFFIX } from '../../src/install/actions.js'
import { doctorReport } from '../../src/install/doctor.js'
import { removeJsonKey, removeTomlBlock } from '../../src/install/edits.js'
import { runInstall, runUninstall } from '../../src/install/install.js'
import { installLaunch } from '../../src/install/launch.js'
import { OPENCODE_KEY } from '../../src/install/movable.js'
import type { Launch } from '../../src/install/render.js'
import { seededHome, snapshot } from '../helpers/env.js'
import { claudeExec, fakeOpencode, OLD_LAUNCH, TEST_LAUNCH } from '../helpers/install.js'

// Launch A: another node and another CLI. Launch B: TEST_LAUNCH.
const A = OLD_LAUNCH
const B = TEST_LAUNCH

const OMP = '.omp/agent/mcp.json'
const CODEX = '.codex/config.toml'
const OPENCODE = '.config/opencode/opencode.jsonc'
const CLAUDE_MCP = '.local/share/harness-summit/claude-marketplace/claude/.mcp.json'
const PI_EXT = '.pi/agent/extensions/harness-summit.ts'

// Purpose: a seeded home, its original tree, and install/uninstall of every harness with the fake opencode.
function setup() {
    const home = seededHome()
    const original = snapshot(home)
    const exec = claudeExec(fakeOpencode)
    const opts = { harnesses: [...HARNESSES], home, dryRun: false, exec }
    const install = (launch: Launch) => runInstall({ ...opts, launch })
    const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8')
    const opencodeRuns = () => exec.calls.filter((c) => c.req.cmd === 'opencode').length
    return { home, original, exec, opts, install, read, opencodeRuns }
}

// Purpose: tell whether every registration of `home` starts `launch` (node and CLI).
function holdsLaunch(read: (rel: string) => string, launch: Launch): void {
    const args = (h: string) => [launch.cli, 'mcp', '--harness', h]
    expect(JSON.parse(read(CLAUDE_MCP)).mcpServers['harness-summit']).toEqual({
        command: launch.node,
        args: args('claude'),
    })
    expect(read(CODEX)).toContain(
        `[mcp_servers.harness-summit]\ncommand = ${JSON.stringify(launch.node)}\nargs = ${JSON.stringify(args('codex')).replaceAll(',', ', ')}\n`,
    )
    expect(JSON.parse(read(OMP)).mcpServers['harness-summit']).toEqual({ command: launch.node, args: args('omp') })
    expect(read(OPENCODE)).toContain(JSON.stringify([launch.node, ...args('opencode')]))
    expect(read(PI_EXT)).toContain(
        `const INJECTED_MCP: McpLaunch | null = ${JSON.stringify({ command: launch.node, args: args('pi') })}`,
    )
}

describe('re-install with another launch', () => {
    it('rewrites every registration, then is idempotent, then uninstall restores the original bytes', async () => {
        const { home, original, install, read, opencodeRuns } = setup()
        await install(A)
        holdsLaunch(read, A)
        expect(opencodeRuns()).toBe(1)

        const lines = await install(B)
        holdsLaunch(read, B)
        const abs = (rel: string) => path.join(home, rel)
        expect(lines).toContain(`edit    ${abs(CODEX)} ([mcp_servers.harness-summit])`)
        expect(lines).toContain(`edit    ${abs(OMP)} (mcpServers.harness-summit)`)
        expect(lines.some((l) => l.startsWith(`run     ${abs(OPENCODE)} (mcp.servers.harness-summit): opencode`))).toBe(
            true,
        )
        expect(lines).toContain(`write   ${abs(CLAUDE_MCP)}`)
        expect(lines).toContain(`write   ${abs(PI_EXT)}`)
        expect(opencodeRuns()).toBe(2)

        // Foreign bytes: each user file minus our key is the user's original file, byte for byte.
        expect(removeTomlBlock(read(CODEX))).toBe(original.files[CODEX])
        expect(removeJsonKey(read(OMP), ['mcpServers', 'harness-summit'], original.files[OMP]!, OMP)).toBe(
            original.files[OMP],
        )
        expect(removeJsonKey(read(OPENCODE), OPENCODE_KEY, original.files[OPENCODE]!, OPENCODE)).toBe(
            original.files[OPENCODE],
        )
        // The backup is still the user's original, never our first edit.
        for (const rel of [CODEX, OMP, OPENCODE]) expect(read(rel + BACKUP_SUFFIX)).toBe(original.files[rel])

        const again = await install(B)
        expect(again.filter((l) => !l.startsWith('ok '))).toEqual([])
        expect(opencodeRuns()).toBe(2)

        await runUninstall({ harnesses: [...HARNESSES], home, dryRun: false, exec: claudeExec(), launch: B })
        expect(snapshot(home)).toEqual(original)
    })

    it('a re-run with the same launch stays all ok and runs no opencode command', async () => {
        const { install, opencodeRuns } = setup()
        await install(B)
        const lines = await install(B)
        expect(lines.filter((l) => !l.startsWith('ok '))).toEqual([])
        expect(opencodeRuns()).toBe(1)
    })

    it('a dry run reports the changed registrations and writes nothing', async () => {
        const { home, install, opts, opencodeRuns } = setup()
        await install(A)
        const before = snapshot(home)
        const lines = await runInstall({ ...opts, dryRun: true, launch: B })
        expect(lines).toContain(`edit    ${path.join(home, OMP)} (mcpServers.harness-summit)`)
        expect(snapshot(home)).toEqual(before)
        expect(opencodeRuns()).toBe(1)
    })
})

describe('doctor names a stale registration', () => {
    // Purpose: the doctor lines that warn about a stale registration.
    const staleLines = async (home: string) => (await doctorReport(home)).filter((l) => l.startsWith('warn '))

    it('after an install with another CLI, one warn line per harness with the fix; none after a re-install', async () => {
        const { home, install } = setup()
        await install(A)
        const warns = await staleLines(home)
        expect(warns.map((l) => l.split(/\s+/)[1])).toEqual([...HARNESSES])
        for (const [i, h] of HARNESSES.entries()) {
            expect(warns[i]).toContain(`${A.node} ${A.cli} (missing)`)
            expect(warns[i]).toContain(`run \`harness-summit install --harness ${h}\``)
        }
        // The harness lines keep their format (registered=yes).
        expect((await doctorReport(home)).find((l) => l.startsWith('omp '))).toMatch(/registered=yes/)

        await install(installLaunch())
        expect(await staleLines(home)).toEqual([])
    })
})
