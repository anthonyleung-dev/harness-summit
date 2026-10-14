// CI step (ci.yml and release.yml, through `npm run check:generated`): after `npm run build`, the working
// tree must equal the commit. `git status --porcelain` lists changed AND untracked files, so a generated
// file that a template change adds and nobody commits fails the check too (`git diff --exit-code` misses
// untracked files). One script instead of a shell line: it runs the same on the Windows runner (PowerShell).
import { execFileSync } from 'node:child_process'

import { summitError } from '../src/core/errors.js'
import { runIfMain } from './main.js'

// Purpose: the lines of `git status --porcelain` output that name a file (empty when the tree is clean).
export function dirtyFiles(porcelain: string): string[] {
    return porcelain.split('\n').filter((l) => l.trim() !== '')
}

// Purpose: fail with a structured error that lists every changed or untracked file.
export function checkGenerated(cwd: string = process.cwd()): void {
    const porcelain = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd, encoding: 'utf8' })
    const dirty = dirtyFiles(porcelain)
    if (dirty.length === 0) {
        console.log('generated files: the working tree equals the commit')
        return
    }
    throw summitError(
        'SUMMIT_INTERNAL',
        `the build changed or added files that are not committed; run npm run build and commit them:\n${dirty.join('\n')}`,
        'checkGenerated',
        { cwd, dirty },
    )
}

await runIfMain(import.meta.url, () => checkGenerated())
