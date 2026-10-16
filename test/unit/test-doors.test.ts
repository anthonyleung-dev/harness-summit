// One door for the shared test fixtures: the install-test launch (TEST_LAUNCH, testLaunch in
// test/helpers/install.ts) and the recursive source-tree walker (sourceFiles in test/helpers/env.ts). A second
// copy of either fails here. Also: the spawn door's written exemptions (CLAUDE.md) stay the only ones.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { REPO, sourceFiles } from '../helpers/env.js'

// Purpose: tell whether source text walks a directory tree by hand (readdir with `recursive: true`).
function walksTree(text: string): boolean {
    return /readdir(Sync)?\([^)]*recursive:\s*true/.test(text)
}

// Purpose: tell whether source text spells out a launch object literal with fixed node and cli paths.
function launchLiteral(text: string): boolean {
    return /\bnode:\s*['"][^'"]*['"]\s*,\s*cli:\s*['"]/.test(text)
}

describe('one door for test fixtures', () => {
    // The helpers hold the one copy each; this file holds the raw forms as detector input.
    const exempt = ['helpers/env.ts', 'helpers/install.ts', 'unit/test-doors.test.ts'].map((f) =>
        path.join(REPO, 'test', f),
    )
    const files = ['src', 'scripts', 'test', 'adapters'].flatMap((d) => sourceFiles(path.join(REPO, d)))

    it('no file but the helpers walks a source tree or spells out a test launch', () => {
        const hits = files
            .filter((f) => !exempt.includes(f))
            .filter((f) => {
                const text = fs.readFileSync(f, 'utf8')
                return walksTree(text) || launchLiteral(text)
            })
        expect(files.length).toBeGreaterThan(80)
        expect(hits).toEqual([])
    })

    it('the detectors see each raw form', () => {
        expect(walksTree("fs.readdirSync(dir, { recursive: true, encoding: 'utf8' })")).toBe(true)
        expect(walksTree('await fsp.readdir(d, { recursive: true })')).toBe(true)
        expect(walksTree('fs.readdirSync(d, { withFileTypes: true })')).toBe(false)
        expect(launchLiteral("const launch = { node: '/usr/bin/node', cli: '/opt/x/dist/cli.js' }")).toBe(true)
        expect(launchLiteral("{\n    node: '/usr/bin/node',\n    cli: '/opt/x/cli.js',\n}")).toBe(true)
        expect(launchLiteral("return { node: 'node', cli: `${PLUGIN_ROOT}/x` }")).toBe(false)
    })
})

// Purpose: tell whether source text spells out the injected MCP launch line of the pi/OMP extension (MCP_PREFIX).
function injectedMcpLiteral(text: string): boolean {
    return /INJECTED_MCP: McpLaunch \| null = /.test(text)
}

// Purpose: tell whether source text spells out a registration key path (JSON_KEY, CODEX_KEY, OPENCODE_KEY).
function keyPathLiteral(text: string): boolean {
    return /\[\s*['"](mcpServers|mcp_servers|mcp)['"]\s*,\s*(['"](harness-summit|servers)['"]|SUMMIT_NAME)/.test(text)
}

describe('one door for registration keys and the injected launch line', () => {
    const files = ['src', 'scripts', 'test', 'adapters'].flatMap((d) => sourceFiles(path.join(REPO, d)))
    const rel = (f: string) => path.relative(REPO, f).split(path.sep).join('/')
    const hits = (detect: (text: string) => boolean) =>
        files
            .filter((f) => detect(fs.readFileSync(f, 'utf8')))
            .map(rel)
            .sort()

    it('only src/install/keys.ts spells a key path; only launch.ts and the extension source the launch line', () => {
        expect(hits(keyPathLiteral)).toEqual(['src/install/keys.ts', 'test/unit/test-doors.test.ts'])
        expect(hits(injectedMcpLiteral)).toEqual([
            'adapters/pi-omp/harness-summit.ts',
            'src/install/launch.ts',
            'test/unit/test-doors.test.ts',
        ])
    })

    it('the detectors see each raw form', () => {
        expect(keyPathLiteral("setJsonKey(t, ['mcpServers', 'harness-summit'], v, f)")).toBe(true)
        expect(keyPathLiteral("['mcp_servers', SUMMIT_NAME]")).toBe(true)
        expect(keyPathLiteral('["mcp", "servers", "harness-summit"]')).toBe(true)
        expect(keyPathLiteral("getAt(value, ['mcpServers'])")).toBe(false)
        expect(injectedMcpLiteral('`const INJECTED_MCP: McpLaunch | null = ${x}`')).toBe(true)
        expect(injectedMcpLiteral('MCP_PREFIX')).toBe(false)
    })
})

describe('one door for spawns', () => {
    it('only src/core/exec.ts and the two written exemptions (CLAUDE.md) import node:child_process', () => {
        const files = ['src', 'scripts', 'adapters'].flatMap((d) => sourceFiles(path.join(REPO, d)))
        const spawning = files.filter((f) => fs.readFileSync(f, 'utf8').includes('node:child_process'))
        expect(spawning.map((f) => path.relative(REPO, f).split(path.sep).join('/')).sort()).toEqual([
            'adapters/pi-omp/harness-summit.ts',
            'scripts/check-generated.ts',
            'src/core/exec.ts',
        ])
    })
})
