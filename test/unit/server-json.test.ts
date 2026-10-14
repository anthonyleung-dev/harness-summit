// Unit tests for server.json, the MCP Registry entry. `npm run build` writes it from renderServerJson, so
// package.json stays the only version source; CI fails when the committed file is stale. The registry
// accepts the entry only when its name equals the published package.json mcpName.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { HARNESSES } from '../../src/core/schemas.js'
import { SUMMIT_VERSION } from '../../src/core/version.js'
import { renderServerJson } from '../../src/install/render.js'
import { REPO } from '../helpers/env.js'

type Pkg = { name: string; version: string; mcpName?: string; repository: { url: string } }
type Arg = { type: string; name?: string; value?: string; choices?: string[] }
type ServerJson = {
    name: string
    description: string
    version: string
    repository: { url: string; source: string }
    packages: { registryType: string; identifier: string; version: string; packageArguments?: Arg[] }[]
}

// Purpose: read one text file at the repo root.
function readRoot(file: string): string {
    return fs.readFileSync(path.join(REPO, file), 'utf8')
}

const pkg = JSON.parse(readRoot('package.json')) as Pkg
const server = JSON.parse(readRoot('server.json')) as ServerJson

describe('server.json', () => {
    it('is exactly what renderServerJson writes', () => {
        expect(readRoot('server.json')).toBe(renderServerJson().content)
    })

    it('carries the package.json version in both version fields', () => {
        expect(SUMMIT_VERSION).toBe(pkg.version)
        expect(server.version).toBe(SUMMIT_VERSION)
        expect(server.packages.map((p) => p.version)).toEqual([SUMMIT_VERSION])
    })

    it('says that setup is needed, within the registry limit of 100 characters', () => {
        expect(server.description).toBe(
            'Let coding agents on one machine message and wake each other. Run `harness-summit install` first.',
        )
        expect(server.description.length).toBeLessThanOrEqual(100)
    })

    it('has the name that package.json mcpName claims (registry ownership check)', () => {
        expect(pkg.mcpName).toBeDefined()
        expect(server.name).toBe(pkg.mcpName)
    })

    it('uses the GitHub namespace of the repository, as GitHub auth requires', () => {
        const owner = /github\.com\/([^/]+)\//.exec(pkg.repository.url)?.[1]
        expect(owner).toBeDefined()
        expect(server.name.startsWith(`io.github.${owner}/`)).toBe(true)
        expect(server.repository).toEqual({ url: `https://github.com/${owner}/${pkg.name}`, source: 'github' })
    })

    it('points at this npm package', () => {
        expect(server.packages).toHaveLength(1)
        expect(server.packages[0]).toMatchObject({ registryType: 'npm', identifier: pkg.name })
    })

    it('starts the server as `mcp --harness <one of HARNESSES>`', () => {
        const args = server.packages[0]?.packageArguments ?? []
        expect(args[0]).toMatchObject({ type: 'positional', value: 'mcp' })
        expect(args[1]).toMatchObject({ type: 'named', name: '--harness' })
        expect(args[1]?.choices).toEqual([...HARNESSES])
    })
})
