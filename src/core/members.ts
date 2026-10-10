// Group name map `members.json` and its lock `members.lock` (SPEC §4, §5). Every write holds the lock
// (src/core/lock.ts: O_EXCL create, owner line, a lease its holder refreshes; stale when nobody refreshed
// it for STALE_MS).
import { summitError } from './errors.js'
import { readJsonFile, writeJsonAtomic } from './fsx.js'
import { withLock, type LockOptions } from './lock.js'
import { log } from './log.js'
import { membersFile, membersLock } from './paths.js'
import { MembersSchema, type Members } from './schemas.js'

// Purpose: read the name map of a group (empty map when the file does not exist).
export async function readMembers(root: string, groupKey: string): Promise<Members> {
    return (await readJsonFile(membersFile(root, groupKey), MembersSchema)) ?? { version: 1, members: {} }
}

export type MembersUpdate = (m: Members) => Promise<Members> | Members

// Purpose: run `fn` while holding the group's members lock (the one lock of a group's name map).
// Callers that must change the map and other files as one unit (group move: claim + folder move;
// pid refresh vs name takeover) hold it around all of their steps.
export async function lockGroup<T>(
    root: string,
    groupKey: string,
    fn: () => Promise<T>,
    opts: LockOptions = {},
): Promise<T> {
    return await withLock(membersLock(root, groupKey), fn, opts)
}

// Purpose: run `fn` while holding the members locks of several groups (lockGroup for each). The locks
// are taken in sorted key order, so two callers that need the same two locks never wait for each other
// in a cycle. A key given twice is locked once. Used by the group move (old and new group).
export async function lockGroups<T>(root: string, groupKeys: string[], fn: () => Promise<T>): Promise<T> {
    const [first, ...rest] = [...new Set(groupKeys)].sort()
    if (first === undefined) return await fn()
    return await lockGroup(root, first, () => lockGroups(root, rest, fn))
}

// Purpose: run `update` on the name map and write the result. The CALLER holds the group lock
// (lockGroup). `update` may throw to abort without writing. `after` runs once the map is written
// (rename uses it to write agent.json in step with the map).
export async function applyMembersUpdate(
    root: string,
    groupKey: string,
    update: MembersUpdate,
    after?: (next: Members) => Promise<void>,
): Promise<Members> {
    const next = MembersSchema.parse(await update(await readMembers(root, groupKey)))
    await writeJsonAtomic(membersFile(root, groupKey), next)
    log('debug', 'applyMembersUpdate', 'members.json written', { groupKey, size: Object.keys(next.members).length })
    if (after) await after(next)
    return next
}

// Purpose: run `update` on the name map under the lock and write the result (applyMembersUpdate
// inside lockGroup).
export async function updateMembers(
    root: string,
    groupKey: string,
    update: MembersUpdate,
    after?: (next: Members) => Promise<void>,
): Promise<Members> {
    return await lockGroup(root, groupKey, () => applyMembersUpdate(root, groupKey, update, after))
}

// Purpose: drop every name that points to `uuid`.
export function withoutUuid(m: Members, uuid: string): Members {
    return { version: 1, members: Object.fromEntries(Object.entries(m.members).filter(([, u]) => u !== uuid)) }
}

// Purpose: every map key that equals `name` ignoring letter case, the exact key first. New names are
// unique ignoring case (`Alice` and `alice` cannot both be claimed), because each name is an inbox file
// name and macOS and Windows file systems ignore case by default; a map written by an older version may
// still hold such a pair. The one comparison: claims and lookups use it.
export function nameKeys(m: Members, name: string): string[] {
    const wanted = name.toLowerCase()
    const keys = Object.keys(m.members).filter((k) => k.toLowerCase() === wanted)
    return [...keys.filter((k) => k === name), ...keys.filter((k) => k !== name)]
}

// Purpose: the map key a lookup of `name` uses (the one lookup door): the exact key when present, else
// the only case match; undefined when none. Several case matches and no exact key (a pair an older
// version wrote) fail with SUMMIT_AMBIGUOUS_TARGET naming them, never a pick by map order.
export function lookupName(m: Members, name: string): string | undefined {
    const keys = nameKeys(m, name)
    if (keys[0] === name || keys.length <= 1) return keys[0]
    throw summitError(
        'SUMMIT_AMBIGUOUS_TARGET',
        `${name} matches ${keys.length} agents (${keys.join(', ')}). Send to one exact name or to its uuid (list the group's members to see it).`,
        'lookupName',
        {
            name,
            candidates: keys,
        },
    )
}

// Purpose: map `name` to `uuid`. `replaceKeys` are the entries a claim judged and took over (they may
// differ in case); no other entry is removed.
export function withName(m: Members, name: string, uuid: string, replaceKeys: string[] = []): Members {
    const members = Object.fromEntries(Object.entries(m.members).filter(([k]) => !replaceKeys.includes(k)))
    return { version: 1, members: { ...members, [name]: uuid } }
}

// Purpose: find the name of `uuid` in the map, or null.
export function nameOf(m: Members, uuid: string): string | null {
    return Object.entries(m.members).find(([, u]) => u === uuid)?.[0] ?? null
}
