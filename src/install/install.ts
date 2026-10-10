// `harness-summit install` / `uninstall` (SPEC §8): apply or reverse the per-harness plans and keep
// the install state. Every file edit is backed up once, merged key by key and idempotent.
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

import { defaultExec, type Exec } from '../core/exec.js'
import { pathExists } from '../core/fsx.js'
import { log } from '../core/log.js'
import { pipe, step } from '../core/pipe.js'
import { HarnessSchema, type Harness } from '../core/schemas.js'
import {
    applyAction,
    ensureParentDirs,
    removeCreatedDirs,
    revertAction,
    type Action,
    type ActionEnv,
} from './actions.js'
import { installLaunch } from './launch.js'
import { planFor } from './plan.js'
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
}

// Purpose: the OpenCode global config file, chosen the way `opencode mcp add --global` chooses it
// (observed with OpenCode 2.0.24 in a temp HOME, FIXES-LOG m11): opencode.json when it exists, else
// opencode.jsonc when it exists, else opencode.json (created by the command).
export async function opencodeConfigPath(home: string): Promise<string> {
    const dir = path.join(home, '.config', 'opencode')
    const json = path.join(dir, 'opencode.json')
    const jsonc = path.join(dir, 'opencode.jsonc')
    if (await pathExists(json)) return json
    return (await pathExists(jsonc)) ? jsonc : json
}

// Purpose: make the action environment for one run.
function actionEnv(ctx: InstallCtx): ActionEnv {
    return {
        state: ctx.state as InstallState,
        exec: ctx.opts.exec ?? defaultExec,
        dryRun: ctx.opts.dryRun,
        report: (l) => ctx.lines.push(l),
    }
}

// Step: validate the option data (DTO).
const validateStep = step<InstallCtx>('validateOptions', (ctx) => {
    InstallOptionsSchema.parse({ harnesses: ctx.opts.harnesses, home: ctx.opts.home, dryRun: ctx.opts.dryRun })
    return ctx
})

// Step: load what earlier installs recorded.
const loadStep = step<InstallCtx>('loadState', async (ctx) => ({ ...ctx, state: await loadState(ctx.opts.home) }))

// Step: build the action list for the chosen harnesses.
const planStep = step<InstallCtx>('plan', async (ctx) => {
    const launch = ctx.opts.launch ?? installLaunch()
    const input = { home: ctx.opts.home, launch, opencodeConfig: await opencodeConfigPath(ctx.opts.home) }
    const actions = ctx.opts.harnesses.flatMap((h) => planFor(h, input))
    log('info', 'install.plan', 'planned', { actions: actions.length })
    return { ...ctx, actions }
})

// Purpose: run each action and save the state file right after any action that changed it, whether
// the action then failed or not (write-ahead, REVIEW M3): a failure half way still leaves a state
// that uninstall can reverse, and a re-run skips the external commands that already ran.
async function runEach(ctx: InstallCtx, actions: Action[], run: (a: Action, env: ActionEnv) => Promise<void>) {
    const env = actionEnv(ctx)
    for (const a of actions) {
        const before = JSON.stringify(env.state)
        try {
            await run(a, env)
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
    await runEach(ctx, [...(ctx.actions ?? [])].reverse(), revertAction)
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
    const ctx = await pipe<InstallCtx>('install', { opts, lines: [] }, [validateStep, loadStep, planStep, applyStep])
    return ctx.lines
}

// Purpose: run uninstall; returns the report lines.
export async function runUninstall(opts: InstallOptions): Promise<string[]> {
    log('info', 'runUninstall', 'start', { harnesses: opts.harnesses, home: opts.home, dryRun: opts.dryRun })
    const ctx = await pipe<InstallCtx>('uninstall', { opts, lines: [] }, [
        validateStep,
        loadStep,
        planStep,
        revertStep,
        cleanupStep,
    ])
    return ctx.lines
}
