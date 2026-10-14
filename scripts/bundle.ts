// Build step: bundle the CLI into ONE self-contained ESM file, dist/cli.js, so the published package has no
// runtime dependencies. The npm package (`bin`) and the public Claude plugin (`${CLAUDE_PLUGIN_ROOT}/dist/
// cli.js`) run this same file. Claude Code installs no node_modules for an npm-sourced plugin, so an
// unbundled `import 'zod'` would fail there. It also writes dist/THIRD_PARTY_LICENSES.txt: the license text
// of every package esbuild put into the bundle (read from the metafile, so a new transitive dependency is
// never missed). Not minified on purpose: stack traces keep readable function names.
import { build, type Metafile } from 'esbuild'
import fs from 'node:fs'
import { isBuiltin } from 'node:module'
import path from 'node:path'

import { summitError } from '../src/core/errors.js'
import { BUNDLE_FILE, packageRoot, readPackageManifest } from '../src/core/version.js'
import { runIfMain } from './main.js'

const ROOT = packageRoot()
export const NOTICES_FILE = 'dist/THIRD_PARTY_LICENSES.txt'
const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt))?$/i

export interface BundledPackage {
    name: string
    version: string
    license: string
    dir: string
}

// Purpose: the package directory of one metafile input inside node_modules (the LAST node_modules segment,
// so a nested copy is its own package), or null for our own source.
export function packageDirOf(input: string): string | null {
    const parts = input.split(/[\\/]/)
    const at = parts.lastIndexOf('node_modules')
    if (at < 0 || at + 1 >= parts.length) return null
    const width = parts[at + 1]!.startsWith('@') ? 2 : 1
    return parts.slice(0, at + 1 + width).join('/')
}

// Purpose: every distinct third-party package (name@version) whose files are inside the bundle.
export function bundledPackages(meta: Metafile, root: string = ROOT): BundledPackage[] {
    const dirs = new Set<string>()
    for (const input of Object.keys(meta.inputs)) {
        const dir = packageDirOf(input)
        if (dir !== null) dirs.add(dir)
    }
    const byId = new Map<string, BundledPackage>()
    for (const dir of dirs) {
        const pkg = readPackageManifest(path.join(root, dir, 'package.json'))
        const license = pkg.license ?? 'UNKNOWN'
        byId.set(`${pkg.name}@${pkg.version}`, { name: pkg.name, version: pkg.version, license, dir })
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name))
}

// Purpose: the license text a package ships. A package without one fails the build: its notice must ship.
export function licenseText(pkg: BundledPackage, root: string = ROOT): string {
    const dir = path.join(root, pkg.dir)
    const names = fs.readdirSync(dir).filter((f) => LICENSE_FILE.test(f))
    if (names.length === 0) {
        throw summitError('SUMMIT_INTERNAL', `${pkg.name} ships no license file`, 'licenseText', { dir })
    }
    return names.map((f) => fs.readFileSync(path.join(dir, f), 'utf8').trim()).join('\n\n')
}

// Purpose: the THIRD_PARTY_LICENSES.txt text: one section per bundled package, with its full license.
export function renderNotices(pkgs: BundledPackage[], root: string = ROOT): string {
    const head =
        'harness-summit bundles the following third-party packages into dist/cli.js.\n' +
        'Their license notices follow.\n'
    const sections = pkgs.map((p) => {
        const title = `${p.name} ${p.version} (${p.license})`
        return `${'='.repeat(78)}\n${title}\n${'='.repeat(78)}\n\n${licenseText(p, root)}\n`
    })
    return [head, ...sections].join('\n')
}

// Every way an ES module can load another module, with the specifier in group 2 (group 1 for the
// quote). A call form must not follow a quote, a backtick, a dot or a name character, so code that a
// library builds as text (ajv: `'require("ajv/dist/runtime/uri")'`) and method calls (`x.require(`) are
// not counted.
const STATIC_IMPORT = /^\s*(?:import|export)\s[^'"`;]*?\sfrom\s*(['"])([^'"]+)\1/gm
const BARE_IMPORT = /^\s*import\s*(['"])([^'"]+)\1/gm
const LOAD_CALL = /(?<![\w$.'"`])(?:require|import)\s*\(\s*(['"])([^'"]+)\1/g
// A load call whose argument is not a string literal: its target cannot be checked, so it is refused.
const DYNAMIC_LOAD_CALL = /(?<![\w$.'"`])(?:require|import)\s*\(\s*(?![\s'")])/g
// esbuild's shim for a `require` it could not bundle. A call of it (not its `function __require()`
// definition) means a package stayed outside the bundle.
const REQUIRE_SHIM_CALL = /(?<!function\s+)\b__require\s*\(/g

// Purpose: every module the bundle text loads at run time that is not a Node built-in: static and bare
// imports, `require('x')` and `import('x')` calls, any non-literal load call and any `__require(` call.
// Empty for a self-contained bundle. The build fails on a non-empty result (bundle()), and a test runs it
// on dist/cli.js.
export function externalLoads(src: string): string[] {
    const specs = [STATIC_IMPORT, BARE_IMPORT, LOAD_CALL].flatMap((re) => [...src.matchAll(re)].map((m) => m[2]!))
    const found = specs.filter((s) => !isBuiltin(s))
    for (const m of src.matchAll(DYNAMIC_LOAD_CALL)) found.push(`<non-literal load at ${m.index}>`)
    for (const m of src.matchAll(REQUIRE_SHIM_CALL)) found.push(`<__require call at ${m.index}>`)
    return [...new Set(found)]
}

// Purpose: run esbuild, then write the notices file. Prints one line per written file.
export async function bundle(root: string = ROOT): Promise<void> {
    const outfile = path.join(root, BUNDLE_FILE)
    let meta: Metafile
    try {
        const result = await build({
            absWorkingDir: root,
            entryPoints: [path.join(root, 'src', 'cli.ts')],
            outfile,
            bundle: true,
            platform: 'node',
            format: 'esm',
            target: 'node22',
            // jsonc-parser's `main` is a UMD build that esbuild cannot follow; its `module` build is ESM.
            mainFields: ['module', 'main'],
            legalComments: 'none',
            metafile: true,
            logLevel: 'warning',
        })
        meta = result.metafile
    } catch (err) {
        throw summitError('SUMMIT_INTERNAL', 'esbuild failed', 'bundle', { outfile }, err)
    }
    const external = externalLoads(fs.readFileSync(outfile, 'utf8'))
    if (external.length > 0) {
        throw summitError('SUMMIT_INTERNAL', `bundle loads modules outside itself: ${external.join(', ')}`, 'bundle', {
            outfile,
            external,
        })
    }
    const pkgs = bundledPackages(meta, root)
    fs.writeFileSync(path.join(root, NOTICES_FILE), renderNotices(pkgs, root))
    console.log(`write   ${outfile}`)
    console.log(`write   ${path.join(root, NOTICES_FILE)} (${pkgs.map((p) => p.name).join(', ')})`)
}

await runIfMain(import.meta.url, bundle)
