// Install failure paths and the OpenCode registration shape: a half-way failure stays uninstallable
// (REVIEW M3), OpenCode's config file is chosen the way `opencode mcp add --global` chooses it (m11),
// and every registration carries the harness CLI paths (m10).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { HARNESSES } from '../../src/core/schemas.js'
import { BACKUP_SUFFIX } from '../../src/install/actions.js'
import { setJsonKey } from '../../src/install/edits.js'
import { opencodeConfigPath, runInstall, runUninstall } from '../../src/install/install.js'
import { JSON_KEY } from '../../src/install/keys.js'
import { sha, stateFile } from '../../src/install/state.js'
import { errorCode, recordingExec, seededHome, snapshot } from '../helpers/env.js'
import { claudeExec, testLaunch } from '../helpers/install.js'

const launch = testLaunch({ env: { SUMMIT_CODEX_BIN: '/opt/bin/codex', SUMMIT_OPENCODE_BIN: '/opt/bin/opencode' } })

describe('install that fails half way', () => {
    it('saves what it did, so uninstall reverses it and a re-run does not repeat the claude commands', async () => {
        const home = seededHome()
        const original = snapshot(home)
        const exec = claudeExec()
        const opts = { harnesses: [...HARNESSES], home, dryRun: false, exec, launch }
        const conflict = path.join(home, '.omp/agent/extensions/harness-summit.ts')
        fs.mkdirSync(path.dirname(conflict), { recursive: true })
        fs.writeFileSync(conflict, '// mine\n')
        expect(await errorCode(runInstall(opts))).toBe('SUMMIT_INSTALL_CONFLICT')
        const state = JSON.parse(fs.readFileSync(stateFile(home), 'utf8'))
        expect(state.execs).toEqual({ 'claude-marketplace': true, 'claude-plugin': true })
        expect(Object.keys(state.edits).map((f) => path.relative(home, f).split(path.sep).join('/'))).toEqual([
            '.codex/config.toml',
            '.omp/agent/mcp.json',
        ])

        fs.rmSync(conflict)
        await runInstall(opts)
        // One marketplace check (first run only), then add and install once each; the re-run checks that the
        // plugin is still installed.
        expect(exec.calls.filter((c) => c.req.cmd === 'claude').map((c) => c.req.args.slice(0, 3))).toEqual([
            ['plugin', 'marketplace', 'list'],
            ['plugin', 'marketplace', 'add'],
            ['plugin', 'install', 'harness-summit@harness-summit'],
            ['plugin', 'list', '--json'],
        ])

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
    it('targets the first config file mcp add would use (opencode.json, opencode.jsonc, .opencode/...)', async () => {
        const home = seededHome()
        const dir = path.join(home, '.config/opencode')
        expect(await opencodeConfigPath(home)).toBe(path.join(dir, 'opencode.jsonc'))
        fs.writeFileSync(path.join(dir, 'opencode.json'), '{}\n')
        expect(await opencodeConfigPath(home)).toBe(path.join(dir, 'opencode.json'))
        fs.rmSync(path.join(dir, 'opencode.json'))
        fs.rmSync(path.join(dir, 'opencode.jsonc'))
        expect(await opencodeConfigPath(home)).toBe(path.join(dir, 'opencode.json'))
        // Then .opencode/opencode.json, then .opencode/opencode.jsonc; a dir of that name is not a file.
        const nested = path.join(dir, '.opencode')
        fs.mkdirSync(path.join(nested, 'opencode.json'), { recursive: true })
        fs.writeFileSync(path.join(nested, 'opencode.jsonc'), '{}\n')
        expect(await opencodeConfigPath(home)).toBe(path.join(nested, 'opencode.jsonc'))
        fs.rmSync(path.join(nested, 'opencode.json'), { recursive: true })
        fs.writeFileSync(path.join(nested, 'opencode.json'), '{}\n')
        expect(await opencodeConfigPath(home)).toBe(path.join(nested, 'opencode.json'))
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
        // pi: the extension registers the server, with the harness CLI paths in its env.
        const ext = fs.readFileSync(path.join(home, '.pi/agent/extensions/harness-summit.ts'), 'utf8')
        expect(ext).toContain(`"env":${JSON.stringify(launch.env)}`)
        const mcp = path.join(home, '.local/share/harness-summit/claude-marketplace/claude/.mcp.json')
        expect(JSON.parse(fs.readFileSync(mcp, 'utf8')).mcpServers['harness-summit'].env).toEqual(launch.env)
    })
})

describe('upgrade from an install that registered pi in mcp.json', () => {
    // Purpose: put the home in the state an older install left: the pi mcp.json key, its backup, and the
    // edit record in the install state.
    function olderPiInstall(home: string): { file: string; original: string } {
        const file = path.join(home, '.pi/agent/mcp.json')
        const original = fs.readFileSync(file, 'utf8')
        const edited = setJsonKey(original, JSON_KEY, { command: 'node' }, file)
        fs.writeFileSync(file + BACKUP_SUFFIX, original)
        fs.writeFileSync(file, edited)
        const state = { version: 1, files: {}, dirs: [], execs: {}, edits: {} as Record<string, unknown> }
        state.edits[file] = { existed: true, preSha: sha(original), postSha: sha(edited) }
        fs.mkdirSync(path.dirname(stateFile(home)), { recursive: true })
        fs.writeFileSync(stateFile(home), JSON.stringify(state))
        return { file, original }
    }

    it('install retires the old pi entry (a same-name entry would win over the extension)', async () => {
        const home = seededHome()
        const { file, original } = olderPiInstall(home)
        await runInstall({ harnesses: ['pi'], home, dryRun: false, exec: recordingExec(), launch })
        expect(fs.readFileSync(file, 'utf8')).toBe(original)
        expect(fs.existsSync(file + BACKUP_SUFFIX)).toBe(false)
        expect(JSON.parse(fs.readFileSync(stateFile(home), 'utf8')).edits[file]).toBeUndefined()
    })

    it('uninstall without a re-install retires it too', async () => {
        const home = seededHome()
        const { file, original } = olderPiInstall(home)
        await runUninstall({ harnesses: ['pi'], home, dryRun: false, exec: recordingExec(), launch })
        expect(fs.readFileSync(file, 'utf8')).toBe(original)
    })
})
