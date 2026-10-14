// `gen-plugin`, the build step behind `npm run build` (SPEC §8): write every generated file of the repo and
// delete the generated files the current templates no longer produce. It refuses to run outside a source
// checkout, because the published package (a global npm install, the Claude plugin cache) ships this CLI too.
import fs from 'node:fs'
import path from 'node:path'

import { summitError } from '../core/errors.js'
import { log } from '../core/log.js'
import { staleOwned } from '../core/prune.js'
import { packageRoot } from '../core/version.js'
import { devPluginLaunch, npmPluginLaunch } from '../install/launch.js'
import {
    renderClaudePlugin,
    renderPublicMarketplace,
    renderPublicPlugin,
    renderServerJson,
    type RenderedFile,
} from '../install/render.js'

// Directories gen-plugin fully owns (repo-relative, POSIX form): every file in them that the current render
// does not produce is deleted, unless KEEP_IN_OWNED names it.
export const OWNED_DIRS = ['plugins/claude'] as const

// Hand-written files inside OWNED_DIRS that gen-plugin must keep, each with the reason. Empty: every file
// in plugins/claude comes from renderClaudePlugin (manifest, .mcp.json, hooks.json, one SKILL.md per template).
export const KEEP_IN_OWNED: Readonly<Record<string, string>> = {}

// Every generated path OUTSIDE the owned dirs that gen-plugin writes now or wrote in an earlier release. Only
// these are deleted when the render stops producing them; every other file there is hand-written. A render that
// produces a path outside the owned dirs and not on this list is a build error, so the list stays complete.
// When a renderer is retired, keep its path here so the build deletes the old copy.
export const ROOT_GENERATED = ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json', 'server.json'] as const

// The two paths that mark a source checkout (see isSourceCheckout).
export const SOURCE_MARKERS = ['src/cli.ts', '.git'] as const

export interface GenPluginOptions {
    // The repo root to write into (default: the package root of this CLI).
    root?: string
    // The files to write, repo-relative (default: renderRepoFiles()). Tests pass extra or fewer files.
    rendered?: RenderedFile[]
    // Hand-written files to keep inside the owned dirs (default: KEEP_IN_OWNED).
    keep?: Readonly<Record<string, string>>
}

// Purpose: every generated file of the repo, with repo-relative POSIX paths: the dev plugin under
// plugins/claude, and at the root the public plugin manifest, the public marketplace and server.json.
export function renderRepoFiles(): RenderedFile[] {
    const dev = renderClaudePlugin(devPluginLaunch()).map((f) => ({ ...f, rel: `${OWNED_DIRS[0]}/${f.rel}` }))
    return [...dev, renderPublicPlugin(npmPluginLaunch()), renderPublicMarketplace(), renderServerJson()]
}

// Purpose: tell whether `root` is a source checkout. The npm tarball never holds `src/` (package.json `files`)
// and never holds `.git` (npm always leaves it out), so an installed package fails both checks; a git clone and
// the CI checkout pass both. `.git` may be a directory or a file (a git worktree), so only existence counts.
export function isSourceCheckout(root: string): boolean {
    return SOURCE_MARKERS.every((m) => fs.existsSync(path.join(root, m)))
}

// Purpose: stop with SUMMIT_BAD_INPUT unless `root` is a source checkout. Runs before any write.
function assertSourceCheckout(root: string): void {
    if (isSourceCheckout(root)) return
    const missing = SOURCE_MARKERS.filter((m) => !fs.existsSync(path.join(root, m)))
    log('error', 'genPlugin', 'not a source checkout', { root, missing })
    throw summitError(
        'SUMMIT_BAD_INPUT',
        `gen-plugin is a build step and runs only in a source checkout of the repo; ${root} has no ${missing.join(' or ')}. It never rewrites an installed package.`,
        'genPlugin',
        { root, missing },
    )
}

// Purpose: tell whether a repo-relative POSIX path lies inside one of the owned dirs.
function inOwnedDir(rel: string): boolean {
    return OWNED_DIRS.some((d) => rel.startsWith(`${d}/`))
}

// Purpose: every file (and symlink) under `dir`, as POSIX paths relative to `root`; empty when `dir` is missing.
function listFiles(root: string, dir: string): string[] {
    const abs = path.join(root, dir)
    if (!fs.existsSync(abs)) return []
    return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
        const rel = `${dir}/${e.name}`
        return e.isDirectory() ? listFiles(root, rel) : [rel]
    })
}

// Purpose: the repo-relative files to delete: files in the owned dirs that the render does not produce and
// `keep` does not name, and ROOT_GENERATED paths the render no longer produces. Throws SUMMIT_INTERNAL when
// the render writes outside the owned dirs to a path ROOT_GENERATED does not list.
export function staleFiles(root: string, rendered: RenderedFile[], keep: Readonly<Record<string, string>>): string[] {
    const produced = new Set(rendered.map((f) => f.rel))
    const unlisted = [...produced].filter((r) => !inOwnedDir(r) && !(ROOT_GENERATED as readonly string[]).includes(r))
    if (unlisted.length > 0) {
        log('error', 'staleFiles', 'render writes a path outside the generated list', { unlisted })
        throw summitError(
            'SUMMIT_INTERNAL',
            `gen-plugin renders ${unlisted.join(', ')} outside ${OWNED_DIRS.join(', ')}; add it to ROOT_GENERATED`,
            'staleFiles',
            { root, unlisted },
        )
    }
    const inOwned = OWNED_DIRS.flatMap((d) => listFiles(root, d))
    const atRoot = ROOT_GENERATED.filter((r) => fs.existsSync(path.join(root, r)))
    return staleOwned([...inOwned, ...atRoot], produced, (r) => r in keep)
}

// Purpose: remove the empty directories under each owned dir, deepest first (the dir itself stays).
function removeEmptyDirs(root: string, dir: string): void {
    const abs = path.join(root, dir)
    if (!fs.existsSync(abs)) return
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        if (!e.isDirectory()) continue
        const sub = `${dir}/${e.name}`
        removeEmptyDirs(root, sub)
        if (fs.readdirSync(path.join(root, sub)).length === 0) fs.rmdirSync(path.join(root, sub))
    }
}

// Purpose: run the build step: check the checkout, write every rendered file, delete the stale ones and the
// empty dirs they leave. Returns one `write` or `remove` line per file.
// The stale-file rule itself is shared with install (`staleOwned`, src/core/prune.ts).
// Not install's `fileActions` (plan.ts) on purpose: this is the build step. It overwrites generated files
// in the repo every time, keeps no state and has no undo. Install files are owned files in a user's home:
// they refuse to overwrite a file install did not write, honor --dry-run, are recorded in the install state
// and are removed by uninstall. Sharing one writer would give the build those rules or take them from install.
export function genPlugin(opts: GenPluginOptions = {}): string[] {
    const root = opts.root ?? packageRoot()
    assertSourceCheckout(root)
    const rendered = opts.rendered ?? renderRepoFiles()
    const stale = staleFiles(root, rendered, opts.keep ?? KEEP_IN_OWNED)
    const lines = rendered.map((f) => {
        const file = path.join(root, f.rel)
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, f.content)
        return `write   ${file}`
    })
    for (const rel of stale) {
        fs.rmSync(path.join(root, rel), { force: true })
        lines.push(`remove  ${path.join(root, rel)}`)
    }
    for (const d of OWNED_DIRS) removeEmptyDirs(root, d)
    log('info', 'genPlugin', 'generated', { root, written: rendered.length, removed: stale })
    return lines
}
