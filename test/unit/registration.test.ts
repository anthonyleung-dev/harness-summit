// Unit tests for registration.ts: each harness's registration text, as install renders it, reads back as the
// launch it was rendered from; a missing or broken registration reads as null; sameLaunch's env rule.
import { describe, expect, it } from 'vitest'

import { setJsonKey, tomlBlock, upsertTomlBlock } from '../../src/install/edits.js'
import { renderExtension } from '../../src/install/launch.js'
import { OPENCODE_KEY } from '../../src/install/movable.js'
import { codexTables } from '../../src/install/plan.js'
import { JSON_KEY, readLaunch, sameLaunch } from '../../src/install/registration.js'
import { CLAUDE_MCP_FILE, mcpLaunch, renderClaudePlugin } from '../../src/install/render.js'
import { OLD_LAUNCH, TEST_LAUNCH, testLaunch } from '../helpers/install.js'

const launch = testLaunch({ env: { SUMMIT_CODEX_BIN: '/usr/bin/codex' } })

describe('readLaunch', () => {
    it('reads back what install renders for every harness', () => {
        const claude = renderClaudePlugin(launch).find((f) => f.rel === CLAUDE_MCP_FILE)!.content
        expect(readLaunch('claude', claude, 'f')).toEqual(mcpLaunch(launch, 'claude'))
        const toml = upsertTomlBlock('a = 1\n', tomlBlock(codexTables(launch)), 'harness-summit')
        expect(readLaunch('codex', toml, 'f')).toEqual(mcpLaunch(launch, 'codex'))
        const omp = setJsonKey('{"mcpServers": {"x": {}}}\n', JSON_KEY, mcpLaunch(launch, 'omp'), 'f')
        expect(readLaunch('omp', omp, 'f')).toEqual(mcpLaunch(launch, 'omp'))
        const { command, args, env } = mcpLaunch(launch, 'opencode')
        const server = { type: 'local', command: [command, ...args], environment: env }
        expect(readLaunch('opencode', setJsonKey('{}', OPENCODE_KEY, server, 'f'), 'f')).toEqual(
            mcpLaunch(launch, 'opencode'),
        )
        expect(readLaunch('pi', renderExtension('pi', launch), 'f')).toEqual(mcpLaunch(launch, 'pi'))
    })

    it('reads null for no registration and for a file that does not parse', () => {
        expect(readLaunch('omp', '{"mcpServers": {}}', 'f')).toBeNull()
        expect(readLaunch('omp', '{"mcpServers": ', 'f')).toBeNull()
        expect(readLaunch('codex', 'a = [', 'f')).toBeNull()
        expect(readLaunch('pi', renderExtension('omp', launch), 'f')).toBeNull()
        expect(readLaunch('opencode', setJsonKey('{}', OPENCODE_KEY, { type: 'local' }, 'f'), 'f')).toBeNull()
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
