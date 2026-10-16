// Unit tests for registration.ts: each harness's registration text, as install renders it, reads back as the
// launch it was rendered from; a missing or broken registration reads as null; sameLaunch's env rule.
import { describe, expect, it } from 'vitest'

import { setJsonKey, tomlBlock, upsertTomlBlock } from '../../src/install/edits.js'
import { JSON_KEY, OPENCODE_KEY } from '../../src/install/keys.js'
import { renderExtension } from '../../src/install/launch.js'
import { codexTables } from '../../src/install/plan.js'
import { readLaunch, sameLaunch } from '../../src/install/registration.js'
import { CLAUDE_MCP_FILE, mcpLaunch, renderClaudePlugin } from '../../src/install/render.js'
import { OLD_LAUNCH, TEST_LAUNCH, testLaunch } from '../helpers/install.js'

const launch = testLaunch({ env: { SUMMIT_CODEX_BIN: '/usr/bin/codex' } })

describe('readLaunch', () => {
    it('reads back what install renders for every harness', () => {
        const claude = renderClaudePlugin(launch).find((f) => f.rel === CLAUDE_MCP_FILE)!.content
        expect(readLaunch('claude', claude, 'f').launch).toEqual(mcpLaunch(launch, 'claude'))
        const toml = upsertTomlBlock('a = 1\n', tomlBlock(codexTables(launch)), 'harness-summit')
        expect(readLaunch('codex', toml, 'f').launch).toEqual(mcpLaunch(launch, 'codex'))
        const omp = setJsonKey('{"mcpServers": {"x": {}}}\n', JSON_KEY, mcpLaunch(launch, 'omp'), 'f')
        expect(readLaunch('omp', omp, 'f').launch).toEqual(mcpLaunch(launch, 'omp'))
        const { command, args, env } = mcpLaunch(launch, 'opencode')
        const server = { type: 'local', command: [command, ...args], environment: env }
        expect(readLaunch('opencode', setJsonKey('{}', OPENCODE_KEY, server, 'f'), 'f').launch).toEqual(
            mcpLaunch(launch, 'opencode'),
        )
        expect(readLaunch('pi', renderExtension('pi', launch), 'f').launch).toEqual(mcpLaunch(launch, 'pi'))
    })

    it('no registration: launch null and no problem; a broken or misshapen one: launch null and the reason', () => {
        expect(readLaunch('omp', '{"mcpServers": {}}', 'f')).toEqual({ launch: null, problem: null })
        expect(readLaunch('codex', 'a = 1\n', 'f')).toEqual({ launch: null, problem: null })
        expect(readLaunch('omp', '{"mcpServers": ', 'f').problem).toBe('cannot parse f')
        expect(readLaunch('codex', 'a = [', 'f').problem).toBe('f is not valid TOML; fix it first')
        expect(readLaunch('pi', renderExtension('omp', launch), 'f')).toEqual({
            launch: null,
            problem: 'the extension holds no injected MCP launch',
        })
        const bad = readLaunch('opencode', setJsonKey('{}', OPENCODE_KEY, { type: 'local' }, 'f'), 'f')
        expect(bad.launch).toBeNull()
        expect(bad.problem).toMatch(/^unexpected shape: command /)
    })
})

describe('sameLaunch', () => {
    const wanted = mcpLaunch(TEST_LAUNCH, 'omp')

    it('compares command and args; env only on request, a missing env equal to an empty one', () => {
        expect(sameLaunch(wanted, wanted, true)).toBe(true)
        expect(sameLaunch(null, wanted, false)).toBe(false)
        expect(sameLaunch(mcpLaunch(OLD_LAUNCH, 'omp'), wanted, false)).toBe(false)
        expect(sameLaunch({ ...wanted, command: '/other/node' }, wanted, false)).toBe(false)
        const withEnv = { ...wanted, env: { SUMMIT_CODEX_BIN: '/usr/bin/codex' } }
        expect(sameLaunch(withEnv, wanted, false)).toBe(true)
        expect(sameLaunch(withEnv, wanted, true)).toBe(false)
        expect(sameLaunch({ ...wanted, env: {} }, wanted, true)).toBe(true)
    })
})

describe('sameLaunch compares paths with samePath', () => {
    it('a normalised or (on Windows) differently-cased node or CLI path is the same launch', () => {
        const posix = { command: '/usr/bin/node', args: ['/opt/hs/dist/cli.js', 'mcp', '--harness', 'omp'] }
        const dotted = { command: '/usr/lib/../bin/node', args: ['/opt/hs/./dist/cli.js', 'mcp', '--harness', 'omp'] }
        expect(sameLaunch(dotted, posix, true, 'linux')).toBe(true)
        const win = { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\hs\\dist\\cli.js', 'mcp'] }
        const cased = { command: 'c:\\program files\\NodeJS\\node.exe', args: ['c:\\HS\\dist\\cli.js', 'mcp'] }
        expect(sameLaunch(cased, win, true, 'win32')).toBe(true)
        expect(sameLaunch(cased, win, true, 'linux')).toBe(false)
        expect(sameLaunch({ ...posix, args: [...posix.args.slice(0, 3), 'pi'] }, posix, true, 'linux')).toBe(false)
    })
})
