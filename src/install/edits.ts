// Text-level edits of user config files that keep every foreign byte: a marked TOML block (Codex)
// and a single JSON/JSONC key (pi, OMP, OpenCode removal) through jsonc-parser.
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'

import { summitError } from '../core/errors.js'
import { log } from '../core/log.js'

export const TOML_BEGIN = '# >>> harness-summit (managed by `harness-summit install`; do not edit) >>>'
export const TOML_END = '# <<< harness-summit <<<'

// Purpose: find our marked block: [start of begin line, end after the end line's newline].
function findBlock(text: string): [number, number] | null {
    const start = text.indexOf(TOML_BEGIN)
    if (start < 0) return null
    const endMarker = text.indexOf(TOML_END, start)
    if (endMarker < 0)
        throw summitError('SUMMIT_INSTALL_CONFLICT', 'harness-summit TOML block has no end marker', 'findBlock', {})
    let end = endMarker + TOML_END.length
    if (text[end] === '\n') end += 1
    return [start, end]
}

// Purpose: render the marked block around TOML table text.
export function tomlBlock(body: string): string {
    return `${TOML_BEGIN}\n${body.trimEnd()}\n${TOML_END}\n`
}

// Purpose: parse TOML text, or fail with SUMMIT_INSTALL_CONFLICT (install never writes a file it
// cannot read, and never leaves one Codex cannot read).
export function parseTomlOrRefuse(text: string, what: string): Record<string, unknown> {
    try {
        return parseToml(text) as Record<string, unknown>
    } catch (err) {
        log('warn', 'parseTomlOrRefuse', 'TOML does not parse', { what, error: String(err) })
        throw summitError(
            'SUMMIT_INSTALL_CONFLICT',
            `${what} is not valid TOML; fix it first`,
            'parseTomlOrRefuse',
            { what },
            err,
        )
    }
}

// Purpose: insert or replace our block. Refuses when the rest of the file already defines
// `mcp_servers.<serverKey>` in any form (plain or quoted header, a sub-table, an inline table), or
// when the result would not parse (REVIEW M4).
export function upsertTomlBlock(text: string, block: string, serverKey: string): string {
    const found = findBlock(text)
    const outside = found ? text.slice(0, found[0]) + text.slice(found[1]) : text
    const servers = parseTomlOrRefuse(outside, 'the Codex config').mcp_servers
    if (typeof servers === 'object' && servers !== null && serverKey in servers) {
        throw summitError(
            'SUMMIT_INSTALL_CONFLICT',
            `mcp_servers.${serverKey} is already defined outside the harness-summit block`,
            'upsertTomlBlock',
            { serverKey },
        )
    }
    const next = found
        ? text.slice(0, found[0]) + block + text.slice(found[1])
        : text + (text === '' ? '' : text.endsWith('\n') ? '\n' : '\n\n') + block
    parseTomlOrRefuse(next, 'the Codex config with the harness-summit block')
    return next
}

// Purpose: remove our block and the blank line install put before it.
export function removeTomlBlock(text: string): string {
    const found = findBlock(text)
    if (!found) return text
    let [start] = found
    if (text.slice(Math.max(0, start - 2), start) === '\n\n') start -= 1
    return text.slice(0, start) + text.slice(found[1])
}

// Purpose: parse JSON/JSONC text, failing on syntax errors.
export function parseJsonc(text: string, file: string): unknown {
    const errors: ParseError[] = []
    const value = parse(text === '' ? '{}' : text, errors, { allowTrailingComma: true })
    if (errors.length > 0)
        throw summitError('SUMMIT_CORRUPT_FILE', `cannot parse ${file}`, 'parseJsonc', { file, errors: errors.length })
    return value
}

// Purpose: read a nested value by key path.
export function getAt(value: unknown, keyPath: string[]): unknown {
    let cur: unknown = value
    for (const k of keyPath) {
        if (typeof cur !== 'object' || cur === null) return undefined
        cur = (cur as Record<string, unknown>)[k]
    }
    return cur
}

// Purpose: set (or with `undefined`, remove) one key, changing nothing else in the text. Removing a
// key that is not there (its parent included) returns the text unchanged (REVIEW m5).
export function setJsonKey(text: string, keyPath: string[], value: unknown, file: string): string {
    const current = parseJsonc(text, file)
    if (value === undefined && getAt(current, keyPath) === undefined) return text
    const base = text === '' ? '{}\n' : text
    // No formattingOptions on purpose: jsonc-parser would reformat the whole line around the edit,
    // which rewrites foreign keys in a one-line file.
    return applyEdits(base, modify(base, keyPath, value, {}))
}

// Purpose: remove one key, then each parent object that is now empty and that did not exist in
// `original` (the file before install; null when unknown, then no parent is removed) (REVIEW m6).
export function removeJsonKey(text: string, keyPath: string[], original: string | null, file: string): string {
    let next = setJsonKey(text, keyPath, undefined, file)
    if (original === null) return next
    const before = parseJsonc(original, file)
    for (let n = keyPath.length - 1; n >= 1; n--) {
        const parent = keyPath.slice(0, n)
        const value = getAt(parseJsonc(next, file), parent)
        const empty = typeof value === 'object' && value !== null && Object.keys(value).length === 0
        if (!empty || getAt(before, parent) !== undefined) break
        next = setJsonKey(next, parent, undefined, file)
        log('info', 'removeJsonKey', 'removed empty parent created by install', { file, parent: parent.join('.') })
    }
    return next
}
