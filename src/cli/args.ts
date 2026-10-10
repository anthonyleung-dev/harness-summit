// CLI argument DTO (SPEC §8): parse argv once, validate it with Zod, and turn every bad flag into a
// structured SUMMIT_BAD_INPUT error (REVIEW m16). The one place that parses `--harness`.
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'

import { summitError } from '../core/errors.js'
import { HARNESSES, HarnessSchema, type Harness } from '../core/schemas.js'

const OPTIONS = {
    harness: { type: 'string' },
    'host-key': { type: 'string' },
    pid: { type: 'string' },
    session: { type: 'string' },
    previous: { type: 'string' },
    home: { type: 'string' },
    'dry-run': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
} as const

export const CliArgsSchema = z.object({
    cmd: z.string().optional(),
    sub: z.string().optional(),
    harness: z.string().optional(),
    hostKey: z.string().optional(),
    pid: z.string().optional(),
    session: z.string().optional(),
    previous: z.string().optional(),
    home: z.string().min(1),
    dryRun: z.boolean(),
    help: z.boolean(),
})
export type CliArgs = z.infer<typeof CliArgsSchema>

// Purpose: parse argv into the CLI DTO. An unknown flag or a missing flag value is SUMMIT_BAD_INPUT.
export function parseCliArgs(argv: string[]): CliArgs {
    let parsed: ReturnType<typeof parseArgs<{ args: string[]; options: typeof OPTIONS; allowPositionals: true }>>
    try {
        parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
    } catch (err) {
        throw summitError(
            'SUMMIT_BAD_INPUT',
            err instanceof Error ? err.message : String(err),
            'parseCliArgs',
            { argv },
            err,
        )
    }
    const { values, positionals } = parsed
    return CliArgsSchema.parse({
        cmd: positionals[0],
        sub: positionals[1],
        harness: values.harness,
        hostKey: values['host-key'],
        pid: values.pid,
        session: values.session,
        previous: values.previous,
        home: typeof values.home === 'string' ? path.resolve(values.home) : os.homedir(),
        dryRun: values['dry-run'] === true,
        help: values.help === true,
    })
}

// Purpose: one harness from `--harness`, or SUMMIT_BAD_INPUT.
export function parseHarness(value: string | undefined, fn: string): Harness {
    const parsed = HarnessSchema.safeParse(value?.trim())
    if (!parsed.success) {
        throw summitError('SUMMIT_BAD_INPUT', `--harness must be one of ${HARNESSES.join(', ')}`, fn, {
            harness: value,
        })
    }
    return parsed.data
}

// Purpose: parse `--harness a,b|all` into a list of harnesses.
export function parseHarnessList(value: string | undefined): Harness[] {
    if (value === undefined || value === '' || value === 'all') return [...HARNESSES]
    return value.split(',').map((h) => parseHarness(h, 'parseHarnessList'))
}

// Purpose: a positive integer pid from `--pid`, or SUMMIT_BAD_INPUT.
export function parsePid(value: string | undefined): number {
    const pid = Number(value)
    if (!Number.isInteger(pid) || pid <= 0) {
        throw summitError('SUMMIT_BAD_INPUT', '--pid must be a positive integer', 'parsePid', { pid: value })
    }
    return pid
}

// Purpose: tell whether a command may write the summit log file. Only commands that work on the
// summit root log there; `--help`, no command, `--dry-run`, `doctor` and `gen-plugin` never create
// it (REVIEW m1).
export function logsToFile(args: CliArgs): boolean {
    if (args.help || args.dryRun) return false
    return ['mcp', 'hook', 'notice', 'install', 'uninstall'].includes(args.cmd ?? '')
}
