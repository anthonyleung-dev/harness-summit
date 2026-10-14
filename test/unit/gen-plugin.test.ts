// Unit tests for the build step `gen-plugin` (src/cli/genPlugin.ts): it deletes generated files the templates
// no longer produce, keeps hand-written files, and refuses to run outside a source checkout.
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
    genPlugin,
    isSourceCheckout,
    KEEP_IN_OWNED,
    OWNED_DIRS,
    renderRepoFiles,
    ROOT_GENERATED,
    SOURCE_MARKERS,
} from '../../src/cli/genPlugin.js'
import { REPO, snapshot, tmpDir } from '../helpers/env.js'

const FAKE_SKILL = 'plugins/claude/skills/zz-fake/SKILL.md'

// Purpose: a temp dir that passes the source-checkout test (src/cli.ts and a .git dir), with one
// hand-written root file.
function fakeCheckout(): string {
    const root = tmpDir('gen')
    fs.mkdirSync(path.join(root, 'src'), { recursive: true })
    fs.writeFileSync(path.join(root, 'src', 'cli.ts'), '// entry\n')
    fs.mkdirSync(path.join(root, '.git'))
    fs.writeFileSync(path.join(root, 'README.md'), 'hand-written\n')
    return root
}

describe('gen-plugin', () => {
    it('removes a file the templates no longer produce, and the empty dir it leaves', () => {
        const root = fakeCheckout()
        const real = renderRepoFiles()
        genPlugin({ root, rendered: [...real, { rel: FAKE_SKILL, content: 'fake\n' }] })
        expect(fs.readFileSync(path.join(root, FAKE_SKILL), 'utf8')).toBe('fake\n')

        const lines = genPlugin({ root, rendered: real })
        expect(fs.existsSync(path.join(root, FAKE_SKILL))).toBe(false)
        expect(fs.existsSync(path.dirname(path.join(root, FAKE_SKILL)))).toBe(false)
        expect(lines).toContain(`remove  ${path.join(root, FAKE_SKILL)}`)
        // What is left is exactly the render, plus the hand-written files.
        const files = Object.keys(snapshot(root).files).sort()
        expect(files).toEqual([...real.map((f) => f.rel), 'README.md', 'src/cli.ts'].sort())
    })

    it('keeps an allowlisted hand-written file inside an owned dir', () => {
        const root = fakeCheckout()
        const notes = 'plugins/claude/NOTES.md'
        fs.mkdirSync(path.join(root, 'plugins', 'claude'), { recursive: true })
        fs.writeFileSync(path.join(root, notes), 'mine\n')
        genPlugin({ root, keep: { [notes]: 'test: a hand-written file' } })
        expect(fs.readFileSync(path.join(root, notes), 'utf8')).toBe('mine\n')
        // Without the allowlist entry, the owned dir gets no foreign files.
        genPlugin({ root })
        expect(fs.existsSync(path.join(root, notes))).toBe(false)
    })

    it('deletes a root file only when it is on the generated list', () => {
        const root = fakeCheckout()
        genPlugin({ root })
        // server.json is on ROOT_GENERATED: a render without it deletes it. README.md is not: it stays.
        genPlugin({ root, rendered: renderRepoFiles().filter((f) => f.rel !== 'server.json') })
        expect(fs.existsSync(path.join(root, 'server.json'))).toBe(false)
        expect(fs.readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('hand-written\n')
    })

    it('fails, writing nothing, when the render writes outside the owned dirs and the generated list', () => {
        const root = fakeCheckout()
        const before = snapshot(root)
        expect(() => genPlugin({ root, rendered: [{ rel: 'README.md', content: 'x' }] })).toThrow(
            expect.objectContaining({ code: 'SUMMIT_INTERNAL' }),
        )
        expect(snapshot(root)).toEqual(before)
    })

    it('refuses with SUMMIT_BAD_INPUT outside a source checkout, writing nothing', () => {
        for (const marker of SOURCE_MARKERS) {
            const root = fakeCheckout()
            fs.rmSync(path.join(root, marker), { recursive: true })
            const before = snapshot(root)
            expect(isSourceCheckout(root)).toBe(false)
            expect(() => genPlugin({ root })).toThrow(
                expect.objectContaining({ code: 'SUMMIT_BAD_INPUT', fn: 'genPlugin' }),
            )
            expect(snapshot(root)).toEqual(before)
        }
    })

    it('accepts a git worktree, whose .git is a file', () => {
        const root = fakeCheckout()
        fs.rmSync(path.join(root, '.git'), { recursive: true })
        fs.writeFileSync(path.join(root, '.git'), 'gitdir: /elsewhere\n')
        expect(isSourceCheckout(root)).toBe(true)
    })

    it('owns only plugins/claude, which holds no hand-written file in this repo', () => {
        expect([...OWNED_DIRS]).toEqual(['plugins/claude'])
        expect(KEEP_IN_OWNED).toEqual({})
        const rendered = new Set(renderRepoFiles().map((f) => f.rel))
        const onDisk = Object.keys(snapshot(path.join(REPO, 'plugins', 'claude')).files).map(
            (r) => `plugins/claude/${r}`,
        )
        expect(onDisk.filter((r) => !rendered.has(r))).toEqual([])
        for (const r of ROOT_GENERATED) expect(rendered.has(r), r).toBe(true)
    })
})
