// Acceptance 6: install/uninstall against a seeded temp home. Foreign bytes stay identical, install is
// idempotent, uninstall restores the original tree exactly. External commands are stubbed.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { HARNESSES } from '../../src/core/schemas.js'
import { BACKUP_SUFFIX } from '../../src/install/actions.js'
import { runInstall, runUninstall } from '../../src/install/install.js'
import { recordingExec, runCli, seededHome, snapshot, tmpDir } from '../helpers/env.js'

const launch = { node: '/usr/bin/node', cli: '/opt/harness-summit/dist/cli.js' }

describe('install / uninstall (in-process, stubbed exec)', () => {
    const home = seededHome()
    const original = snapshot(home)
    const exec = recordingExec()
    const opts = { harnesses: [...HARNESSES], home, dryRun: false, exec, launch }
    const read = (rel: string) => fs.readFileSync(path.join(home, rel), 'utf8')
    // The two list commands, at the path each of the five harnesses reads them from.
    const listFiles = ['summit-list', 'sl'].flatMap((n) => [
        `.local/share/harness-summit/claude-marketplace/claude/skills/${n}/SKILL.md`,
        `.codex/skills/${n}/SKILL.md`,
        `.pi/agent/prompts/${n}.md`,
        `.omp/agent/commands/${n}.md`,
        `.config/opencode/commands/${n}.md`,
    ])

    it('installs every harness and keeps every foreign byte', async () => {
        await runInstall(opts)

        const toml = read('.codex/config.toml')
        expect(toml.startsWith(original.files['.codex/config.toml']!)).toBe(true)
        expect(toml).toContain(
            '[mcp_servers.harness-summit]\ncommand = "/usr/bin/node"\nargs = ["/opt/harness-summit/dist/cli.js", "mcp", "--harness", "codex"]',
        )
        expect(toml.match(/approval_mode = "approve"/g)).toHaveLength(9)

        const pi = JSON.parse(read('.pi/agent/mcp.json'))
        expect(pi.mcpServers['harness-summit']).toEqual({
            command: '/usr/bin/node',
            args: ['/opt/harness-summit/dist/cli.js', 'mcp', '--harness', 'pi'],
            exposure: 'direct',
        })
        expect(read('.pi/agent/mcp.json')).toContain(
            '"hakiri-memory": {\n      "command": "hakiri",\n      "args": ["mcp"],\n      "env": { "HAKIRI_SCOPE": "user" }\n    }',
        )
        expect(read('.omp/agent/mcp.json')).toContain(
            '"hakiri-memory":{"command":"hakiri","args":["mcp"]},"qmd":{"command":"qmd","args":["mcp"]}',
        )
        expect(JSON.parse(read('.omp/agent/mcp.json')).mcpServers['harness-summit'].args).toEqual([
            '/opt/harness-summit/dist/cli.js',
            'mcp',
            '--harness',
            'omp',
        ])

        for (const rel of [
            '.codex/config.toml',
            '.pi/agent/mcp.json',
            '.omp/agent/mcp.json',
            '.config/opencode/opencode.jsonc',
        ]) {
            expect(read(rel + BACKUP_SUFFIX)).toBe(original.files[rel])
        }
        expect(read('.config/opencode/opencode.jsonc')).toBe(original.files['.config/opencode/opencode.jsonc'])
        for (const [rel, content] of Object.entries(original.files)) {
            if (!rel.endsWith('.toml') && !rel.endsWith('mcp.json')) expect(read(rel)).toBe(content)
        }

        const ext = read('.pi/agent/extensions/harness-summit.ts')
        expect(ext).toContain('const INJECTED_HARNESS: string | null = "pi"')
        expect(ext).toContain(
            'const INJECTED_CLI: string[] | null = ["/usr/bin/node","/opt/harness-summit/dist/cli.js"]',
        )
        expect(read('.omp/agent/extensions/harness-summit.ts')).toContain(
            'const INJECTED_HARNESS: string | null = "omp"',
        )

        expect(fs.readdirSync(path.join(home, '.codex/skills')).sort()).toEqual([
            'sg',
            'sj',
            'sl',
            'sr',
            'summit-bye',
            'summit-group',
            'summit-join',
            'summit-list',
            'summit-rename',
            'summit-send',
        ])
        expect(fs.readdirSync(path.join(home, '.pi/agent/prompts'))).toHaveLength(10)
        expect(fs.readdirSync(path.join(home, '.omp/agent/commands'))).toHaveLength(10)
        expect(fs.readdirSync(path.join(home, '.config/opencode/commands'))).toHaveLength(10)
        for (const rel of listFiles) expect(read(rel)).toContain('`summit_members` tool')
        const plugin = path.join(home, '.local/share/harness-summit/claude-marketplace')
        expect(JSON.parse(fs.readFileSync(path.join(plugin, 'claude/.mcp.json'), 'utf8'))).toEqual({
            mcpServers: {
                'harness-summit': {
                    command: '/usr/bin/node',
                    args: ['/opt/harness-summit/dist/cli.js', 'mcp', '--harness', 'claude'],
                },
            },
        })

        expect(exec.calls.map((c) => [c.req.cmd, ...c.req.args])).toEqual([
            ['claude', 'plugin', 'marketplace', 'add', plugin],
            ['claude', 'plugin', 'install', 'harness-summit@harness-summit', '--scope', 'user'],
            [
                'opencode',
                'mcp',
                'add',
                '--global',
                'harness-summit',
                '--',
                '/usr/bin/node',
                '/opt/harness-summit/dist/cli.js',
                'mcp',
                '--harness',
                'opencode',
            ],
        ])
        expect(exec.calls.every((c) => c.req.env?.HOME === home)).toBe(true)
    })

    it('is idempotent: a second install changes nothing and runs nothing', async () => {
        const after1 = snapshot(home)
        const lines = await runInstall(opts)
        expect(snapshot(home)).toEqual(after1)
        expect(exec.calls).toHaveLength(3)
        expect(lines.every((l) => l.startsWith('ok '))).toBe(true)
    })

    it('uninstall restores the original tree byte for byte', async () => {
        await runUninstall(opts)
        expect(snapshot(home)).toEqual(original)
        for (const rel of listFiles) expect(fs.existsSync(path.join(home, rel))).toBe(false)
        expect(exec.calls.slice(3).map((c) => [c.req.cmd, ...c.req.args])).toEqual([
            ['claude', 'plugin', 'uninstall', 'harness-summit@harness-summit'],
            ['claude', 'plugin', 'marketplace', 'remove', 'harness-summit'],
        ])
    })

    it('refuses to overwrite a foreign file at a command path', async () => {
        const h = seededHome()
        fs.mkdirSync(path.join(h, '.pi/agent/prompts'), { recursive: true })
        fs.writeFileSync(path.join(h, '.pi/agent/prompts/sj.md'), 'mine\n')
        await expect(runInstall({ ...opts, home: h, harnesses: ['pi'] })).rejects.toMatchObject({
            code: 'SUMMIT_INSTALL_CONFLICT',
        })
        expect(fs.readFileSync(path.join(h, '.pi/agent/prompts/sj.md'), 'utf8')).toBe('mine\n')
    })

    it('keeps user edits made after install and removes only our key', async () => {
        const h = seededHome()
        await runInstall({ ...opts, home: h, harnesses: ['omp'] })
        const file = path.join(h, '.omp/agent/mcp.json')
        fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"qmd":{', '"added":{"command":"x"},"qmd":{'))
        await runUninstall({ ...opts, home: h, harnesses: ['omp'] })
        const after = JSON.parse(fs.readFileSync(file, 'utf8'))
        expect(Object.keys(after.mcpServers).sort()).toEqual(['added', 'hakiri-memory', 'qmd'])
        expect(fs.existsSync(path.join(h, '.omp/agent/commands'))).toBe(false)
    })
})

describe('install CLI (--home, dry run, exec recorded)', () => {
    it('--dry-run writes nothing; real run + uninstall round-trips; no harness CLI runs', async () => {
        const home = seededHome()
        const original = snapshot(home)
        const execLog = path.join(tmpDir('exec'), 'exec.log')
        const env = { HARNESS_SUMMIT_EXEC_LOG: execLog, HARNESS_SUMMIT_HOME: tmpDir('root') }
        const dry = await runCli(['install', '--harness', 'all', '--dry-run', '--home', home], { env })
        expect(dry.code).toBe(0)
        expect(dry.stdout).toContain('(dry run: nothing written)')
        expect(snapshot(home)).toEqual(original)

        expect((await runCli(['install', '--harness', 'codex,opencode', '--home', home], { env })).code).toBe(0)
        const recorded = fs.readFileSync(execLog, 'utf8')
        expect(recorded).toContain('"cmd":"opencode","args":["mcp","add","--global",')
        expect(recorded).toContain('"harness-summit","--","' + process.execPath + '"')
        const doctor = await runCli(['doctor', '--home', home], { env })
        expect(doctor.stdout).toMatch(/codex\s+registered=yes commands=10\/10/)
        expect((await runCli(['uninstall', '--harness', 'codex,opencode', '--home', home], { env })).code).toBe(0)
        expect(snapshot(home)).toEqual(original)
    })
})
