// A path install owns whose type the user changed (a file where install made a dir, or a dir where it wrote a
// file) belongs to the user now. One door for install, prune and uninstall (actions.ts): find what is in the
// way, report it once per run, forget the record, and let every other action go on.
import path from 'node:path'

import { pathKind } from '../core/fsx.js'
import { log } from '../core/log.js'
import type { ActionEnv } from './actions.js'

export interface InTheWay {
    path: string
    // What the user put there.
    kind: 'file' | 'dir'
}

// Purpose: the first thing that stops `target` from being the `want` install owns: the shallowest ancestor
// that exists and is not a dir (a user's file), else the target itself when it exists as the other type. Null
// when the way is clear (a missing ancestor clears it: nothing below it exists).
export async function inTheWay(target: string, want: 'file' | 'dir'): Promise<InTheWay | null> {
    const chain: string[] = []
    for (let d = path.dirname(target); d !== path.dirname(d); d = path.dirname(d)) chain.unshift(d)
    for (const d of chain) {
        const kind = await pathKind(d)
        if (kind === null) return null
        if (kind !== 'dir') return { path: d, kind: 'file' }
    }
    const kind = await pathKind(target)
    if (kind === null || kind === want) return null
    return { path: target, kind: kind === 'dir' ? 'dir' : 'file' }
}

// Purpose: when a user's file or dir stands where install owns `target`, keep it: report it once per run
// (`keep <path> (user's <kind> in the way)`, the shallowest blocker only), forget the record (`forget`, not in
// a dry run) and return true. Return false when the way is clear.
export async function keepInTheWay(
    target: string,
    want: 'file' | 'dir',
    env: ActionEnv,
    forget: () => void,
): Promise<boolean> {
    const way = await inTheWay(target, want)
    if (way === null) return false
    if (!env.kept.has(way.path)) {
        env.kept.add(way.path)
        env.report(`keep    ${way.path} (user's ${way.kind} in the way)`)
        log('warn', 'keepInTheWay', 'user path in the way; record forgotten', { target, want, way })
    }
    if (!env.dryRun) forget()
    return true
}
