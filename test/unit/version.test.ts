// Unit tests for the package door: package.json is the only place a release bumps, and the package root is
// found by name from any depth (src/core under vitest, dist/ in the bundle).
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { packageRoot, readPackageManifest, readPackageVersion, SUMMIT_VERSION } from '../../src/core/version.js'
import { REPO, sourceFiles, tmpDir } from '../helpers/env.js'

// Every source or workflow file name (sourceFiles).
const CODE_FILE = /\.(ts|mts|js|mjs|ya?ml)$/

// Purpose: tell whether source text finds a directory by walking up from its own module location: it
// turns import.meta (or __dirname) into a path and names a parent step ('..' or '../...') outside an
// import or export line. Passing import.meta.url on as a value (runIfMain) is not a walk.
function walksUp(text: string): boolean {
    const locates =
        /fileURLToPath\(import\.meta\.url\)|import\.meta\.(dirname|filename)|__dirname|new URL\([^)]*import\.meta\.url/
    const code = text
        .split('\n')
        .filter((l) => !/^\s*import\b|^\s*export\b.*\bfrom\s*['"]|^\s*\}\s*from\b/.test(l))
        .join('\n')
    return locates.test(code) && /['"`]\.\.(\/[^'"`]*)?['"`]/.test(code)
}

describe('SUMMIT_VERSION', () => {
    it('equals the version in package.json', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string }
        expect(SUMMIT_VERSION).toBe(pkg.version)
    })

    it('fails with a structured error when package.json has no valid version', () => {
        const file = path.join(tmpDir('pkgver'), 'package.json')
        fs.writeFileSync(file, JSON.stringify({ name: 'harness-summit', version: 'one' }))
        expect(() => readPackageVersion(file)).toThrow(/no valid version/)
        expect(() => readPackageVersion(path.join(tmpDir('pkgver'), 'missing.json'))).toThrow(/cannot read/)
    })

    it('is the only version source: no quoted semver literal in src or adapters', () => {
        const hits = [...sourceFiles(path.join(REPO, 'src')), ...sourceFiles(path.join(REPO, 'adapters'))].filter((f) =>
            /['"`]\d+\.\d+\.\d+['"`]/.test(fs.readFileSync(f, 'utf8')),
        )
        expect(hits).toEqual([])
    })
})

describe('readPackageManifest (the one package.json reader)', () => {
    it('returns name, version and license, and fails with a structured error on a bad file', () => {
        const file = path.join(tmpDir('manifest'), 'package.json')
        fs.writeFileSync(file, JSON.stringify({ name: 'zod', version: '4.0.0+build', license: 'MIT', x: 1 }))
        expect(readPackageManifest(file)).toEqual({ name: 'zod', version: '4.0.0+build', license: 'MIT' })
        fs.writeFileSync(file, JSON.stringify({ version: '1.0.0' }))
        expect(() => readPackageManifest(file)).toThrow(
            expect.objectContaining({ code: 'SUMMIT_INTERNAL', fn: 'readPackageManifest', inputs: { file } }),
        )
    })

    it('is the only package.json parser: no other JSON.parse of a package.json in src or scripts', () => {
        const hits = [...sourceFiles(path.join(REPO, 'src')), ...sourceFiles(path.join(REPO, 'scripts'))].filter(
            (f) =>
                !f.endsWith(path.join('core', 'version.ts')) &&
                /package\.json/.test(fs.readFileSync(f, 'utf8')) &&
                /JSON\.parse/.test(fs.readFileSync(f, 'utf8')),
        )
        expect(hits).toEqual([])
    })
})

describe('packageRoot', () => {
    // Purpose: a temp dir holding a package.json with the given name.
    function pkgDir(name: string): string {
        const dir = tmpDir('pkgroot')
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }))
        return dir
    }

    it('finds the repo from src/core (vitest and tsx run the sources)', () => {
        expect(packageRoot()).toBe(REPO)
        expect(packageRoot(path.join(REPO, 'src', 'core'))).toBe(REPO)
    })

    it('finds the root from a dist-like dir one level down, past a foreign package.json', () => {
        const root = pkgDir('harness-summit')
        const dist = path.join(root, 'dist')
        fs.mkdirSync(dist)
        expect(packageRoot(dist)).toBe(root)
        // A package.json of another name (or an unreadable one) on the way up is not ours.
        const nested = path.join(root, 'node_modules', 'other')
        fs.mkdirSync(nested, { recursive: true })
        fs.writeFileSync(path.join(nested, 'package.json'), JSON.stringify({ name: 'other' }))
        fs.writeFileSync(path.join(root, 'node_modules', 'package.json'), '{ not json')
        expect(packageRoot(nested)).toBe(root)
    })

    it('is the only package-root lookup: nothing else walks up from import.meta with ".."', () => {
        // The pi/OMP extension is the one exemption, with the reason in CLAUDE.md: its installed copy cannot
        // import src/, and its dev fallback (nothing injected) finds dist/cli.js above itself. This test file
        // holds the raw forms as detector input, so it is exempt too.
        const exempt = [
            path.join(REPO, 'src', 'core', 'version.ts'),
            path.join(REPO, 'adapters', 'pi-omp', 'harness-summit.ts'),
            path.join(REPO, 'test', 'unit', 'version.test.ts'),
        ]
        const files = ['src', 'scripts', 'test', 'adapters', '.github'].flatMap((d) =>
            sourceFiles(path.join(REPO, d), CODE_FILE),
        )
        const walks = files.filter((f) => !exempt.includes(f) && walksUp(fs.readFileSync(f, 'utf8')))
        expect(files.length).toBeGreaterThan(50)
        expect(walks).toEqual([])
    })

    it('the walk detector sees each raw form', () => {
        expect(walksUp("path.resolve(import.meta.dirname, '..', '..')")).toBe(true)
        expect(walksUp("const d = path.dirname(fileURLToPath(import.meta.url))\nreturn path.resolve(d, '..')")).toBe(
            true,
        )
        expect(walksUp('new URL("../package.json", import.meta.url)')).toBe(true)
        expect(walksUp("path.join(__dirname, '..')")).toBe(true)
        expect(walksUp("export const R = path.resolve(import.meta.dirname, '..')")).toBe(true)
        expect(walksUp("import { x } from '../a.js'\nawait runIfMain(import.meta.url, main)")).toBe(false)
    })

    it('throws a structured SUMMIT_INTERNAL error when no matching package.json exists', () => {
        const start = path.join(pkgDir('not-harness-summit'), 'dist')
        expect(() => packageRoot(start)).toThrow(
            expect.objectContaining({ code: 'SUMMIT_INTERNAL', fn: 'packageRoot', inputs: { start } }),
        )
    })
})
