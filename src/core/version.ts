// The package door: where the installed package lives (`packageRoot`) and its version (`SUMMIT_VERSION`).
// The version is read from package.json, so a release bumps one place only. The root is found by walking
// up from this module, because the depth differs: src/core under vitest/tsx (two levels), the esbuild
// bundle dist/cli.js (one level), the npm package or the Claude plugin cache (`<root>/dist/cli.js`).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import { summitError } from './errors.js'
import { log } from './log.js'
import { SUMMIT_NAME } from './schemas.js'

// The package.json fields this package reads: its own (name, version), and those of every package the
// bundle carries (scripts/bundle.ts writes their license notices). One schema, one reader.
export const PackageManifestSchema = z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    license: z.string().optional(),
})
export type PackageManifest = z.infer<typeof PackageManifestSchema>
// Our own version: plain semver with an optional pre-release (the registry and the marketplace pin it).
const OWN_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

// The built CLI (the esbuild bundle), relative to the package root, in POSIX form: the plugin manifests and
// package.json `bin` need `/`, and path.join accepts it on every OS. The build, the launches and doctor use it.
export const BUNDLE_FILE = 'dist/cli.js'

// Purpose: the directory of this module (src/core, or dist when bundled).
function moduleDir(): string {
    return path.dirname(fileURLToPath(import.meta.url))
}

// Purpose: true when `dir/package.json` exists and names this package. Any unreadable or foreign
// package.json is not ours, so the walk goes on.
function isOurPackage(dir: string): boolean {
    try {
        return readPackageManifest(path.join(dir, 'package.json')).name === SUMMIT_NAME
    } catch {
        return false
    }
}

// Purpose: the package root: the nearest directory at or above `start` whose package.json has the name
// SUMMIT_NAME. Throws SUMMIT_INTERNAL when the walk reaches the file-system root without one.
export function packageRoot(start: string = moduleDir()): string {
    let dir = path.resolve(start)
    for (;;) {
        if (isOurPackage(dir)) return dir
        const parent = path.dirname(dir)
        if (parent === dir) break
        dir = parent
    }
    log('error', 'packageRoot', 'no package.json of this package above start', { start })
    throw summitError('SUMMIT_INTERNAL', `no ${SUMMIT_NAME} package.json at or above ${start}`, 'packageRoot', {
        start,
    })
}

// Purpose: read and validate one package.json (ours or a bundled package's). Throws SUMMIT_INTERNAL when
// the file cannot be read or parsed, or has no name or version.
export function readPackageManifest(file: string): PackageManifest {
    let raw: unknown
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
        throw summitError('SUMMIT_INTERNAL', `cannot read ${file}`, 'readPackageManifest', { file }, err)
    }
    const parsed = PackageManifestSchema.safeParse(raw)
    if (!parsed.success) {
        throw summitError('SUMMIT_INTERNAL', `no valid name or version in ${file}`, 'readPackageManifest', { file })
    }
    return parsed.data
}

// Purpose: our version from package.json, checked as plain semver. Synchronous: it runs once at load.
export function readPackageVersion(file: string = path.join(packageRoot(), 'package.json')): string {
    const { version } = readPackageManifest(file)
    if (!OWN_VERSION.test(version)) {
        log('error', 'readPackageVersion', 'package.json version is not plain semver', { file, version })
        throw summitError('SUMMIT_INTERNAL', `no valid version in ${file}`, 'readPackageVersion', { file, version })
    }
    return version
}

export const SUMMIT_VERSION = readPackageVersion()
