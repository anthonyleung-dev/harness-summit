// Unit tests for the bundle build step (scripts/bundle.ts) and the package manifest it serves: the CLI ships
// as one self-contained file, so package.json has no runtime dependencies, and every package esbuild puts
// into the bundle has its license notice in the shipped notices file.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
    bundledPackages,
    externalLoads,
    licenseText,
    NOTICES_FILE,
    packageDirOf,
    renderNotices,
} from '../../scripts/bundle.js'
import { dirtyFiles } from '../../scripts/check-generated.js'
import { BUNDLE_FILE } from '../../src/core/version.js'
import { REPO, tmpDir } from '../helpers/env.js'

interface Manifest {
    dependencies?: Record<string, string>
    devDependencies: Record<string, string>
    files: string[]
    bin: Record<string, string>
}

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as Manifest
const toPosix = (p: string): string => p.split(path.sep).join('/')

describe('package.json', () => {
    it('has no runtime dependencies: the libraries are bundled build inputs', () => {
        expect(pkg.dependencies ?? {}).toEqual({})
        for (const name of ['@modelcontextprotocol/sdk', 'zod', 'jsonc-parser', 'smol-toml', 'esbuild']) {
            expect(pkg.devDependencies[name], name).toBeDefined()
        }
        // esbuild is pinned exactly: a new esbuild must not change the shipped bundle unseen.
        expect(pkg.devDependencies.esbuild).toMatch(/^\d+\.\d+\.\d+$/)
    })

    it('ships the bundle and the notices file, and no other dist file', () => {
        expect(pkg.bin['harness-summit']).toBe(toPosix(BUNDLE_FILE))
        expect(pkg.files).toContain(toPosix(BUNDLE_FILE))
        expect(pkg.files).toContain(toPosix(NOTICES_FILE))
        expect(pkg.files.filter((f) => f === 'dist' || f.startsWith('dist/')).sort()).toEqual(
            [toPosix(BUNDLE_FILE), toPosix(NOTICES_FILE)].sort(),
        )
    })
})

describe('bundle notices', () => {
    it('maps a metafile input to its package dir (last node_modules segment, scoped names)', () => {
        expect(packageDirOf('src/core/version.ts')).toBeNull()
        expect(packageDirOf('node_modules/zod/v4/core/core.js')).toBe('node_modules/zod')
        expect(packageDirOf('node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js')).toBe(
            'node_modules/@modelcontextprotocol/sdk',
        )
        expect(packageDirOf('node_modules/a/node_modules/@s/b/x.js')).toBe('node_modules/a/node_modules/@s/b')
    })

    it('lists each bundled package once and renders its full license text', () => {
        const inputs = {
            'src/cli.ts': {},
            'node_modules/smol-toml/dist/index.js': {},
            'node_modules/smol-toml/dist/parse.js': {},
            'node_modules/zod/v4/index.js': {},
        }
        const pkgs = bundledPackages({ inputs, outputs: {} } as never, REPO)
        expect(pkgs.map((p) => [p.name, p.license])).toEqual([
            ['smol-toml', 'BSD-3-Clause'],
            ['zod', 'MIT'],
        ])
        const text = renderNotices(pkgs, REPO)
        expect(text).toMatch(/smol-toml \d+\.\d+\.\d+ \(BSD-3-Clause\)/)
        expect(text).toMatch(/Redistributions of source code must retain/)
    })

    it('fails the build with a structured error when a bundled package ships no license file', () => {
        const root = tmpDir('nolicense')
        fs.mkdirSync(path.join(root, 'node_modules', 'bare'), { recursive: true })
        expect(() =>
            licenseText({ name: 'bare', version: '1.0.0', license: 'MIT', dir: 'node_modules/bare' }, root),
        ).toThrow(expect.objectContaining({ code: 'SUMMIT_INTERNAL', fn: 'licenseText' }))
    })
})

describe('externalLoads (the bundle is self-contained)', () => {
    it('accepts Node built-ins in every form, and generated code text', () => {
        const ok = [
            "import fs from 'node:fs'",
            'import { spawn } from "node:child_process"',
            "import 'node:process'",
            "const m = await import('node:os')",
            "const r = require('fs')",
            'var __commonJS = (cb, mod) => function __require() {',
            `x.code = 'require("ajv/dist/runtime/uri").default'`,
            'y = `require("ajv-formats/dist/formats")`',
            'obj.require("zod")',
        ]
        for (const src of ok) expect(externalLoads(src), src).toEqual([])
    })

    it('rejects each way of loading a package from outside the bundle', () => {
        expect(externalLoads("import { z } from 'zod'")).toEqual(['zod'])
        expect(externalLoads("export { a } from 'pkg-a'")).toEqual(['pkg-a'])
        expect(externalLoads("import 'side-effect'")).toEqual(['side-effect'])
        expect(externalLoads("const j = require('jsonc-parser')")).toEqual(['jsonc-parser'])
        expect(externalLoads("const s = await import('smol-toml')")).toEqual(['smol-toml'])
        expect(externalLoads('const x = __require("ajv")')).toEqual(['<__require call at 10>'])
        expect(externalLoads('const x = require(name)')).toEqual(['<non-literal load at 10>'])
        expect(externalLoads('const x = await import(spec)')).toEqual(['<non-literal load at 16>'])
    })
})

describe('check:generated', () => {
    it('counts changed and untracked files from git status --porcelain', () => {
        expect(dirtyFiles('')).toEqual([])
        expect(dirtyFiles('\n')).toEqual([])
        expect(dirtyFiles(' M server.json\n?? plugins/claude/skills/new/SKILL.md\n')).toEqual([
            ' M server.json',
            '?? plugins/claude/skills/new/SKILL.md',
        ])
    })
})
