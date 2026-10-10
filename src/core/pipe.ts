// Pipe Pattern: a flow is a list of small named steps run in order over one context object. A step
// may carry an `undo`: when a later step fails, the undos of the steps that completed run in reverse
// order (best effort, each logged), so a multi-step change never stops half way (REVIEW M1).
import { toSummitError } from './errors.js'
import { log } from './log.js'

export type Step<C> = {
    name: string
    run: (ctx: C) => Promise<C> | C
    undo?: (ctx: C) => Promise<void> | void
}

// Purpose: build a named step, optionally with its compensation.
export function step<C>(
    name: string,
    run: (ctx: C) => Promise<C> | C,
    undo?: (ctx: C) => Promise<void> | void,
): Step<C> {
    return undo === undefined ? { name, run } : { name, run, undo }
}

// Purpose: run the undos of completed steps, newest first. An undo failure is logged and the rest
// still run. Exported for a step that runs a locked sub-pipe and must undo it later (group move).
export async function rollBack<C>(flow: string, done: { s: Step<C>; ctx: C }[]): Promise<void> {
    for (const { s, ctx } of [...done].reverse()) {
        if (s.undo === undefined) continue
        try {
            await s.undo(ctx)
            log('warn', `${flow}.${s.name}`, 'step undone')
        } catch (err) {
            log('error', `${flow}.${s.name}`, 'undo failed', {
                error: toSummitError(err, `${flow}.${s.name}`).toJSON(),
            })
        }
    }
}

// Purpose: run the steps in order. Each step gets the context returned by the previous one. The first
// failure undoes the completed steps and is rethrown as a SummitError naming the flow and the step.
export async function pipe<C>(flow: string, initial: C, steps: Step<C>[]): Promise<C> {
    let ctx = initial
    const done: { s: Step<C>; ctx: C }[] = []
    for (const s of steps) {
        try {
            ctx = await s.run(ctx)
            done.push({ s, ctx })
            log('debug', `${flow}.${s.name}`, 'step done')
        } catch (err) {
            const e = toSummitError(err, `${flow}.${s.name}`)
            log('warn', `${flow}.${s.name}`, 'step failed', { error: e.toJSON() })
            await rollBack(flow, done)
            throw e
        }
    }
    log('debug', flow, 'flow done')
    return ctx
}
