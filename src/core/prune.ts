// The one stale-file rule (SPEC §8), shared by the build step (`gen-plugin`, src/cli/genPlugin.ts) and
// install (src/install/plan.ts): a file is stale when its owner wrote it before and the current render no
// longer produces it. Each caller decides what it owns (gen-plugin: the files in its owned dirs; install:
// the files its install state records) and how a stale file goes (gen-plugin deletes it; install deletes it
// only when it is unchanged since install wrote it).
import { log } from './log.js'

// Purpose: the paths in `owned` that `produced` does not hold and `keep` does not protect, in `owned`
// order, each once. Paths are compared as given, so both lists must use one spelling (both repo-relative
// POSIX, or both absolute paths built by the same path.join calls).
export function staleOwned(
    owned: Iterable<string>,
    produced: Iterable<string>,
    keep: (p: string) => boolean = () => false,
): string[] {
    const made = new Set(produced)
    const stale = [...new Set(owned)].filter((p) => !made.has(p) && !keep(p))
    log('debug', 'staleOwned', 'stale files found', { stale: stale.length })
    return stale
}
