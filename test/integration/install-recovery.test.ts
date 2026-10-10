// Install failure paths and the OpenCode registration shape: a half-way failure stays uninstallable
// (REVIEW M3), OpenCode's config file is chosen the way `opencode mcp add --global` chooses it (m11),
// and every registration carries the harness CLI paths (m10).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { HARNESSES } from '../../src/core/schemas.js'
import { opencodeConfigPath, runInstall, runUninstall } from '../../src/install/install.js'
import { stateFile } from '../../src/install/state.js'
import { errorCode, recordingExec, seededHome, snapshot } from '../helpers/env.js'

const launch = {
    node: '/usr/bin/node',
    cli: '/opt/harness-summit/dist/cli.js',
    env: { SUMMIT_CODEX_BIN: '/opt/bin/codex', SUMMIT_OPENCODE_BIN: '/opt/bin/opencode' },
}

describe('install that fails half way', () => {
    it('saves what it did, so uninstall reverses it and a re-run does not repeat the claude commands', async () => {
        const home = seededHome()
        const original = snapshot(home)
        const exec = recordingExec()
        const opts = { harnesses: [...HARNESSES], home, dryRun: false, exec, launch }
        const conflict = path.join(home, '.omp/agent/extensions/harness-summit.ts')
        fs.mkdirSync(path.dirname(conflict), { recursive: true })
        fs.writeFileSync(conflict, '// mine\n')
        expect(await errorCode(runInstall(opts))).toBe('SUMMIT_INSTALL_CONFLICT')
        const state = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'))
        expect(state.execs).toEqual({ 'claude-marketplace': true, 'claude-plugin': true })
        expect(Object.keys(state.edits).map((f) => path.relative(home, f))).toEqual([
            '.codex/config.toml',
            '.pi/agent/mcp.json',
            '.omp/agent/mcp.json',
        ])

        fs.rmSync(conflict)
        await runInstall(opts)
        expect(exec.calls.filter((c) => c.req.cmd === 'claude')).toHaveLength(2)

        await runUninstall(opts)
        fs.mkdirSync(path.dirname(conflict), { recursive: true })
        fs.writeFileSync(conflict, '// mine\n')
        expect(snapshot(home)).toEqual({
            ...original,
            files: { ...original.files, '.omp/agent/extensions/harness-summit.ts': '// mine\n' },
            dirs: [...original.dirs, '.omp/agent/extensions'].sort(),
        })
    })

    it('uninstall right after the failed install restores the tree', async () => {
        const home = seededHome()
        const exec = recordingExec()
        const opts = { harnesses: [...HARNESSES], home, dryRun: false, exec, launch }
        const conflict = path.join(home, '.omp/agent/extensions/harness-summit.ts')
        fs.mkdirSync(path.dirname(conflict), { recursive: true })
        fs.writeFileSync(conflict, '// mine\n')
        const before = snapshot(home)
        await errorCode(runInstall(opts))
        await runUninstall(opts)
        expect(snapshot(home)).toEqual(before)
        expect(exec.calls.slice(-2).map((c) => c.req.args.slice(0, 3))).toEqual([
            ['plugin', 'uninstall', 'harness-summit@harness-summit'],
            ['plugin', 'marketplace', 'remove'],
        ])
    })
})

describe('OpenCode registration', () => {
    it('targets opencode.json when it exists or when no config exists, else opencode.jsonc', async () => {
        const home = seededHome()
        const dir = path.join(home, '.config/opencode')
        expect(await opencodeConfigPath(home)).toBe(path.join(dir, 'opencode.jsonc'))
        fs.writeFileSync(path.join(dir, 'opencode.json'), '{}\n')
        expect(await opencodeConfigPath(home)).toBe(path.join(dir, 'opencode.json'))
        fs.rmSync(path.join(dir, 'opencode.json'))
        fs.rmSync(path.join(dir, 'opencode.jsonc'))
        expect(await opencodeConfigPath(home)).toBe(path.join(dir, 'opencode.json'))
    })

    it('passes the harness CLI paths as --env, and every other registration carries them as env', async () => {
        const home = seededHome()
        const exec = recordingExec()
        await runInstall({ harnesses: ['opencode', 'pi', 'claude'], home, dryRun: false, exec, launch })
        const oc = exec.calls.find((c) => c.req.cmd === 'opencode')!.req.args
        expect(oc.slice(0, 8)).toEqual([
            'mcp',
            'add',
            '--global',
            '--env',
            'SUMMIT_CODEX_BIN=/opt/bin/codex',
            '--env',
            'SUMMIT_OPENCODE_BIN=/opt/bin/opencode',
            'harness-summit',
        ])
        const pi = JSON.parse(fs.readFileSync(path.join(home, '.pi/agent/mcp.json'), 'utf8')).mcpServers[
            'harness-summit'
        ]
        expect(pi.env).toEqual(launch.env)
        const mcp = path.join(home, '.local/share/harness-summit/claude-marketplace/claude/.mcp.json')
        expect(JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers['harness-summit'].env).toEqual(launch.env)
    })
})
