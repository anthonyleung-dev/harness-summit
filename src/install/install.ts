// `harness-summit install` / `uninstall` (SPEC §8): apply or reverse the per-harness plans and keep
// the install state. Every file edit is backed up once, merged key by key and idempotent.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { toSummitError } from '../core/errors.js'
import { defaultExec, type Exec } from '../core/exec.js'
import { pathExists } from '../core/fsx.js'
import { log } from '../core/log.js'
import { pipe, step } from '../core/pipe.js'
import { HarnessSchema, type Harness } from '../core/schemas.js'
import {
    actionTarget,
    applyAction,
    FAIL_PREFIX,
    ensureParentDirs,
    removeCreatedDirs,
    revertAction,
    type Action,
    type ActionEnv,
} from './actions.js'
import { checkClaudeMarketplace, checkClaudePlugin } from './claudeMarket.js'
import { OPENCODE_CONFIG_FILES, opencodeDir } from './homes.js'
import { installLaunch } from './launch.js'
import { planFor, prunePlan } from './plan.js'
import type { Launch } from './render.js'
import { isEmptyState, loadState, saveState, stateFile, type InstallState } from './state.js'

// The data part of the install options (exec and launch are injected objects, not data).
export const InstallOptionsSchema = z.object({
    harnesses: z.array(HarnessSchema).min(1),
    home: z.string().min(1),
    dryRun: z.boolean(),
})

export interface InstallOptions extends z.infer<typeof InstallOptionsSchema> {
    harnesses: Harness[]
    exec?: Exec
    launch?: Launch
}

interface InstallCtx {
    opts: InstallOptions
    lines: string[]
    state?: InstallState
    actions?: Action[]
    // The user's paths in the way already reported in this run (inTheWay.ts), shared by every step.
    kept: Set<string>
}

// Purpose: the OpenCode global config file, chosen the way `opencode mcp add --global` chooses it (OpenCode
// 2.0.26, OPENCODE_CONFIG_FILES in homes.ts): the first candidate in OpenCode's config dir (opencodeDir) that
// is a file, else the first candidate (opencode.json, created by the command).
export async function opencodeConfigPath(home: string): Promise<string> {
    const files = OPENCODE_CONFIG_FILES.map((rel) => path.join(opencodeDir(home), ...rel))
    for (const f of files) if (await pathExists(f, 'file')) return f
    return files[0]!
}

// Purpose: make the action environment for one run.
function actionEnv(ctx: InstallCtx): ActionEnv {
    return {
        state: ctx.state as InstallState,
        exec: ctx.opts.exec ?? defaultExec,
        dryRun: ctx.opts.dryRun,
        report: (l) => ctx.lines.push(l),
        written: new Set(),
        ran: new Set(),
        kept: ctx.kept,
    }
}

// Step: validate the option data (DTO).
const validateStep = step<InstallCtx>('validateOptions', (ctx) => {
    InstallOptionsSchema.parse({ harnesses: ctx.opts.harnesses, home: ctx.opts.home, dryRun: ctx.opts.dryRun })
    return ctx
})

// Step: load what earlier installs recorded.
const loadStep = step<InstallCtx>('loadState', async (ctx) => ({ ...ctx, state: await loadState(ctx.opts.home) }))

// Step: the Claude checks before any write (claudeMarket.ts). When the state records the plugin, check that
// Claude Code still has it (else its records are dropped and this run installs it again). Then, unless the
// state records that install added its marketplace, stop when another source holds the marketplace name.
const claudeCheckStep = step<InstallCtx>('claudeMarketplace', async (ctx) => {
    if (!ctx.opts.harnesses.includes('claude')) return ctx
    const state = ctx.state as InstallState
    const exec = ctx.opts.exec ?? defaultExec
    const report = (l: string) => ctx.lines.push(l)
    await checkClaudePlugin(ctx.opts.home, exec, state, report)
    if (state.execs['claude-marketplace'] !== true) await checkClaudeMarketplace(ctx.opts.home, exec, report)
    return ctx
})

// Step: build the action list for the chosen harnesses. Each harness starts with the prune actions for the
// files an earlier install wrote and this version no longer renders, so a later sync action sees them.
const planStep = step<InstallCtx>('plan', async (ctx) => {
    const launch = ctx.opts.launch ?? installLaunch()
    // The OpenCode config is looked up only when OpenCode is planned: a refused XDG_CONFIG_HOME blocks only it.
    const opencode = ctx.opts.harnesses.includes('opencode')
    const input = {
        home: ctx.opts.home,
        launch,
        opencodeConfig: opencode ? await opencodeConfigPath(ctx.opts.home) : undefined,
    }
    const state = ctx.state as InstallState
    const actions = ctx.opts.harnesses.flatMap((h) => {
        const planned = planFor(h, input)
        return [...prunePlan(h, input, state, planned), ...planned]
    })
    const pruned = actions.filter((a) => a.kind === 'prune').length
    log('info', 'install.plan', 'planned', { actions: actions.length, pruned })
    return { ...ctx, actions }
})

// Purpose: run each action and save the state file right after any action that changed it, whether
// the action then failed or not (write-ahead, REVIEW M3): a failure half way still leaves a state
// that uninstall can reverse, and a re-run skips the external commands that already ran. Install stops at
// the first failure. With `keepGoing` (uninstall) a failed action is reported as a `fail` line, its record
// stays in the state (a re-run retries it), and every later action still runs.
async function runEach(
    ctx: InstallCtx,
    actions: Action[],
    run: (a: Action, env: ActionEnv) => Promise<void>,
    keepGoing = false,
) {
    const env = actionEnv(ctx)
    for (const a of actions) {
        const before = JSON.stringify(env.state)
        try {
            await run(a, env)
        } catch (err) {
            if (!keepGoing) throw err
            const e = toSummitError(err, 'runEach', { kind: a.kind, target: actionTarget(a) })
            log('error', 'runEach', 'action failed; going on', { error: e.toJSON() })
            env.report(`${FAIL_PREFIX}${actionTarget(a)}: ${e.code}: ${e.message}`)
        } finally {
            if (!ctx.opts.dryRun && JSON.stringify(env.state) !== before) await saveState(ctx.opts.home, env.state)
        }
    }
}

// Step: apply every action (state saved after each one).
const applyStep = step<InstallCtx>('apply', async (ctx) => {
    // The state file's dirs are install-owned too, so uninstall can remove them (recorded at once).
    if (!ctx.opts.dryRun) {
        const state = ctx.state as InstallState
        const dirs = state.dirs.length
        await ensureParentDirs(stateFile(ctx.opts.home), state)
        if (state.dirs.length !== dirs) await saveState(ctx.opts.home, state)
    }
    await runEach(ctx, ctx.actions ?? [], applyAction)
    return ctx
})

// Step: revert every action, newest first (state saved after each one).
const revertStep = step<InstallCtx>('revert', async (ctx) => {
    await runEach(ctx, [...(ctx.actions ?? [])].reverse(), revertAction, true)
    return ctx
})

// Step: after uninstall, drop the state file when it records nothing, then the dirs install created.
const cleanupStep = step<InstallCtx>('cleanup', async (ctx) => {
    const state = ctx.state as InstallState
    const dirsOnly: InstallState = { ...state, dirs: [] }
    if (!ctx.opts.dryRun && isEmptyState(dirsOnly)) await fsp.rm(stateFile(ctx.opts.home), { force: true })
    await removeCreatedDirs(actionEnv(ctx))
    if (!ctx.opts.dryRun && !isEmptyState(state)) await saveState(ctx.opts.home, state)
    return ctx
})

// Purpose: run install; returns the report lines.
export async function runInstall(opts: InstallOptions): Promise<string[]> {
    log('info', 'runInstall', 'start', { harnesses: opts.harnesses, home: opts.home, dryRun: opts.dryRun })
    const ctx = await pipe<InstallCtx>('install', { opts, lines: [], kept: new Set() }, [
        validateStep,
        loadStep,
        claudeCheckStep,
        planStep,
        applyStep,
    ])
    return ctx.lines
}

// Purpose: run uninstall; returns the report lines.
export async function runUninstall(opts: InstallOptions): Promise<string[]> {
    log('info', 'runUninstall', 'start', { harnesses: opts.harnesses, home: opts.home, dryRun: opts.dryRun })
    const ctx = await pipe<InstallCtx>('uninstall', { opts, lines: [], kept: new Set() }, [
        validateStep,
        loadStep,
        planStep,
        revertStep,
        cleanupStep,
    ])
    return ctx.lines
}
