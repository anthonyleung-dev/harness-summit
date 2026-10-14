// Integration test: the built CLI refuses `gen-plugin` inside an installed package (a global npm install or
// the Claude plugin cache): a copy of the published files with no src/ and no .git. Nothing is written.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { BUNDLE_FILE } from '../../src/core/version.js'
import { REPO, runCli, snapshot, tmpDir } from '../helpers/env.js'

// The package.json `files` entries a published package holds that gen-plugin would rewrite, plus package.json.
const PUBLISHED = ['package.json', BUNDLE_FILE, '.claude-plugin/plugin.json', 'plugins/claude/skills']

describe('gen-plugin in an installed package', () => {
    it('exits 1 with SUMMIT_BAD_INPUT and leaves every file as it was', async () => {
        const pkg = tmpDir('pkg')
        for (const rel of PUBLISHED) fs.cpSync(path.join(REPO, rel), path.join(pkg, rel), { recursive: true })
        const before = snapshot(pkg)
        const res = await runCli(['gen-plugin'], { cli: path.join(pkg, BUNDLE_FILE) })
        expect(res.code).toBe(1)
        expect(res.stdout).toBe('')
        const err = JSON.parse(res.stderr.trim()) as { error: { code: string; fn: string } }
        expect(err.error).toMatchObject({ code: 'SUMMIT_BAD_INPUT', fn: 'genPlugin' })
        expect(snapshot(pkg)).toEqual(before)
    })

    it('is not advertised by --help', async () => {
        const res = await runCli(['--help'])
        expect(res.code).toBe(0)
        expect(res.stdout).not.toContain('gen-plugin')
    })
})
