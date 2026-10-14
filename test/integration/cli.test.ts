// The CLI boundary: `--help`, no command, `--dry-run` and `doctor` never create the summit root
// (REVIEW m1), and bad arguments give a structured SUMMIT_BAD_INPUT (REVIEW m16). The built CLI is one
// self-contained bundle: it imports only Node built-ins and prints the package.json version.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { externalLoads } from '../../scripts/bundle.js'
import { CLI, REPO, runCli, seededHome, tmpDir } from '../helpers/env.js'

describe('CLI', () => {
    it('never creates the summit root for --help, no command, --dry-run or doctor', async () => {
        const root = path.join(tmpDir('noroot'), 'root')
        const env = { HARNESS_SUMMIT_HOME: root, HARNESS_SUMMIT_EXEC_LOG: path.join(tmpDir('exec'), 'x.log') }
        const home = seededHome()
        for (const args of [
            ['--help'],
            ['--version'],
            [],
            ['install', '--harness', 'all', '--dry-run', '--home', home],
            ['uninstall', '--harness', 'all', '--dry-run', '--home', home],
            ['doctor', '--home', home],
            ['--bogus'],
        ]) {
            await runCli(args, { env })
            expect(fs.existsSync(root), args.join(' ')).toBe(false)
        }
    })

    it('bad arguments fail with SUMMIT_BAD_INPUT, never a raw error', async () => {
        const env = { HARNESS_SUMMIT_HOME: tmpDir('badargs') }
        for (const args of [
            ['mcp'],
            ['mcp', '--harness', 'vim'],
            ['--bogus'],
            ['hook', 'ext-arm', '--harness', 'pi'],
            ['nope'],
        ]) {
            const r = await runCli(args, { env })
            expect(r.code, args.join(' ')).toBe(1)
            expect(JSON.parse(r.stderr).error.code, args.join(' ')).toBe('SUMMIT_BAD_INPUT')
        }
    })

    it('--version prints the package.json version', async () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')) as { version: string }
        const r = await runCli(['--version'], { env: { HARNESS_SUMMIT_HOME: tmpDir('ver') } })
        expect(r.code).toBe(0)
        expect(r.stdout.trim()).toBe(pkg.version)
    })

    it('the built CLI is one bundle that imports nothing but Node built-ins', () => {
        const src = fs.readFileSync(CLI, 'utf8')
        expect(src).toMatch(/^import\s[^'"]*?from\s*['"]node:/m)
        expect(externalLoads(src)).toEqual([])
        // Not minified: the CLI's own function names survive, so a stack trace stays readable.
        expect(src).toMatch(/function packageRoot\(/)
    })
})
