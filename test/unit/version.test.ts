// Unit tests for the version door: package.json is the only place a release bumps.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { readPackageVersion, SUMMIT_VERSION } from '../../src/core/version.js'
import { REPO, tmpDir } from '../helpers/env.js'

// Purpose: every .ts file under a directory, recursively.
function tsFiles(dir: string): string[] {
    return fs
        .readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.ts'))
        .map((f) => path.join(dir, f))
}

describe('SUMMIT_VERSION', () => {
    it('equals the version in package.json', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string }
        expect(SUMMIT_VERSION).toBe(pkg.version)
    })

    it('fails with a structured error when package.json has no valid version', () => {
        const file = path.join(tmpDir('pkgver'), 'package.json')
        fs.writeFileSync(file, JSON.stringify({ version: 'one' }))
        expect(() => readPackageVersion(file)).toThrow(/no valid version/)
        expect(() => readPackageVersion(path.join(tmpDir('pkgver'), 'missing.json'))).toThrow(/cannot read/)
    })

    it('is the only version source: no quoted semver literal in src or adapters', () => {
        const hits = [...tsFiles(path.join(REPO, 'src')), ...tsFiles(path.join(REPO, 'adapters'))].filter((f) =>
            /['"`]\d+\.\d+\.\d+['"`]/.test(fs.readFileSync(f, 'utf8')),
        )
        expect(hits).toEqual([])
    })
})
