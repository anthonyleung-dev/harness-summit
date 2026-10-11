// The product version: the ONE door. It is read from package.json, so a release bumps one place only.
// Every module sits two levels below the package root (src/core or dist/core).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

import { summitError } from './errors.js'

const PackageSchema = z.object({ version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/) })

// Purpose: read and validate the version field of package.json. Synchronous: it runs once at load.
export function readPackageVersion(
    file: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
): string {
    let raw: unknown
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch (err) {
        throw summitError('SUMMIT_INTERNAL', `cannot read ${file}`, 'readPackageVersion', { file }, err)
    }
    const parsed = PackageSchema.safeParse(raw)
    if (!parsed.success) {
        throw summitError('SUMMIT_INTERNAL', `no valid version in ${file}`, 'readPackageVersion', { file })
    }
    return parsed.data.version
}

export const SUMMIT_VERSION = readPackageVersion()
