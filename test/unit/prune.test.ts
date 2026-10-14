// The one stale-file rule (src/core/prune.ts), shared by gen-plugin and install, its guard against a second
// copy, and isInsideDir (src/core/project.ts), which install uses to scope its owned files.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { isInsideDir } from '../../src/core/project.js'
import { staleOwned } from '../../src/core/prune.js'
import { REPO, sourceFiles } from '../helpers/env.js'

// Purpose: tell whether source text computes "owned minus produced" by hand: a filter whose test is
// "not in this set".
function prunesByHand(text: string): boolean {
    return /\.filter\(\s*\(?\s*\w+\s*\)?\s*=>\s*!\s*\w+\.has\(/.test(text)
}

describe('staleOwned', () => {
    it('gives the owned paths the render no longer produces, minus the kept ones, each once', () => {
        expect(staleOwned(['a', 'b', 'c', 'b', 'd'], ['a'], (p) => p === 'd')).toEqual(['b', 'c'])
        expect(staleOwned([], ['a'])).toEqual([])
        expect(staleOwned(['a'], [])).toEqual(['a'])
    })

    it('is the only stale-file rule: no other source file filters by "not produced" by hand', () => {
        const exempt = [path.join(REPO, 'src', 'core', 'prune.ts')]
        const files = ['src', 'scripts', 'adapters'].flatMap((d) => sourceFiles(path.join(REPO, d)))
        const copies = files.filter((f) => !exempt.includes(f) && prunesByHand(fs.readFileSync(f, 'utf8')))
        expect(files.length).toBeGreaterThan(30)
        expect(copies).toEqual([])
    })

    it('the guard sees the raw forms', () => {
        expect(prunesByHand('owned.filter((r) => !produced.has(r) && !(r in keep))')).toBe(true)
        expect(prunesByHand('xs.filter(x => !seen.has(x))')).toBe(true)
        expect(prunesByHand('if (!seen.has(x)) log()')).toBe(false)
    })
})

describe('isInsideDir', () => {
    it('is true strictly below the dir only (POSIX)', () => {
        expect(isInsideDir('/h/.codex/skills/a/SKILL.md', '/h/.codex/skills', 'linux')).toBe(true)
        expect(isInsideDir('/h/.codex/skills', '/h/.codex/skills', 'linux')).toBe(false)
        expect(isInsideDir('/h/.codex/skills2/a', '/h/.codex/skills', 'linux')).toBe(false)
        expect(isInsideDir('/h/.codex/..skills/a', '/h/.codex', 'linux')).toBe(true)
        expect(isInsideDir('/h/x', '/h/.codex', 'linux')).toBe(false)
        expect(isInsideDir('/H/.codex/a', '/h/.codex', 'linux')).toBe(false)
    })

    it('ignores letter case and separator form on Windows', () => {
        expect(isInsideDir('C:/Users/A/.codex/skills/x.md', 'c:\\users\\a\\.codex', 'win32')).toBe(true)
        expect(isInsideDir('D:\\x', 'C:\\x', 'win32')).toBe(false)
    })
})
