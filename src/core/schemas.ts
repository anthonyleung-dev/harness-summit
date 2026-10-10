// Zod schemas for every file the summit root holds (SPEC §3, §4). Files are validated on every read.
import { z } from 'zod'

// The product name. It is the MCP server name, the registration key in every harness config, the
// Claude plugin name and the marketplace name (one door for the string).
export const SUMMIT_NAME = 'harness-summit'

export const HARNESSES = ['claude', 'codex', 'pi', 'omp', 'opencode'] as const
export const HarnessSchema = z.enum(HARNESSES)
export type Harness = z.infer<typeof HarnessSchema>

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
// The one uuid schema (lower case). Tool inputs, tool outputs and stored records all use it.
export const UuidSchema = z.string().regex(UUID_PATTERN, 'must be a lower-case uuid')

// Names: used as file names (`<sender>.md`), so a strict charset. A uuid-shaped name is refused so a
// name never shadows a uuid. The one name schema: tool inputs, rename and agent.json use it.
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

// Windows device names: a file `nul.md` or a folder `con` is the device, not a file, on Windows. Names
// and group names refuse them on every OS, so a group works the same everywhere (one definition).
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i

// Purpose: tell whether a name is a Windows device name (case-insensitive).
export function isReservedName(name: string): boolean {
    return RESERVED_NAME.test(name)
}

export const NameSchema = z
    .string()
    .regex(NAME_PATTERN, 'name must match ^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$')
    .refine((n) => !UUID_PATTERN.test(n), 'name must not be a uuid')
    .refine((n) => !isReservedName(n), 'name must not be a Windows device name (con, nul, com1, ...)')

// The sender label of a record, an inbox file and a notice: a display name or a uuid, nothing else (it
// is part of the wake notice, which reaches `cmd.exe` on Windows, so it must never carry `%`, `!` or
// quotes).
export const SenderLabelSchema = z.union([NameSchema, UuidSchema])

// Purpose: tell whether a string is a sender label (the one check: records, inbox file names, notices).
export function isSenderLabel(label: string): boolean {
    return SenderLabelSchema.safeParse(label).success
}

export const WakeSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('signal'), path: z.string().min(1) }),
    z.object({ type: z.literal('codex-queue'), threadId: z.string().min(1) }),
    z.object({ type: z.literal('opencode-prompt'), sessionID: z.string().min(1) }),
])
export type Wake = z.infer<typeof WakeSchema>

export const HostRecordSchema = z.object({
    uuid: UuidSchema,
    groupKey: z.string().min(1),
    harness: HarnessSchema,
    hostKey: z.string().min(1),
    joinedAt: z.string(),
})
export type HostRecord = z.infer<typeof HostRecordSchema>

export const CWD_SOURCES = ['process.cwd', 'codex-workspaces', 'opencode-session'] as const
export const CwdSourceSchema = z.enum(CWD_SOURCES)
export type CwdSource = z.infer<typeof CwdSourceSchema>

export const AgentRecordSchema = z.object({
    uuid: UuidSchema,
    name: NameSchema.nullable(),
    harness: HarnessSchema,
    hostKey: z.string().min(1),
    cwd: z.string(),
    cwdSource: CwdSourceSchema,
    projectRoot: z.string(),
    // The process that served the agent when it joined (informational; liveness comes from the heartbeat,
    // src/core/heartbeat.ts). Kept because servers before the heartbeat require the field.
    pid: z.number().int().positive().nullable(),
    joinedAt: z.string(),
    wake: WakeSchema,
})
export type AgentRecord = z.infer<typeof AgentRecordSchema>

export const MembersSchema = z.object({
    version: z.literal(1),
    members: z.record(z.string(), UuidSchema),
})
export type Members = z.infer<typeof MembersSchema>

// Why a name claim took a name over (O1), always with force: its holder was gone (`alive: false`, confirmed
// by the second look), or its liveness was unknown. summit_rename and summit_group return it, so a model reports
// the real reason and never guesses it.
export const TAKEOVER_REASONS = ['holder-gone', 'forced-unknown'] as const
export const TakeoverReasonSchema = z.enum(TAKEOVER_REASONS)
export type TakeoverReason = z.infer<typeof TakeoverReasonSchema>
export const TakeoverSchema = z.object({ from: UuidSchema, reason: TakeoverReasonSchema })
export type Takeover = z.infer<typeof TakeoverSchema>

export const CursorSchema = z.record(z.string(), z.number().int().nonnegative())
export type Cursor = z.infer<typeof CursorSchema>

// `.lastwake` of an agent folder: the debounce claim of the last wake (F4, F5). A sender writes it
// under the receiver's read lock BEFORE it runs the wake command. `announced` lists the ids of the
// records that wake announces; `claim` lets a sender whose wake failed remove only its own claim.
export const LastWakeSchema = z.object({
    at: z.number().int().nonnegative(),
    claim: UuidSchema,
    announced: z.array(UuidSchema),
})
export type LastWake = z.infer<typeof LastWakeSchema>

// One message record as stored in `<sender>.md` (SPEC §5).
export const MessageRecordSchema = z.object({
    id: UuidSchema,
    from: SenderLabelSchema,
    fromId: UuidSchema,
    to: z.string().min(1),
    at: z.string(),
    replyTo: UuidSchema.optional(),
    body: z.string(),
})
export type MessageRecord = z.infer<typeof MessageRecordSchema>

// A byte range of an inbox file that holds no valid record (torn write, foreign text). The scan
// skips it, reports it, and never throws on it (REVIEW M2).
export const CorruptSpanSchema = z.object({
    file: z.string(),
    offset: z.number().int().nonnegative(),
    length: z.number().int().nonnegative(),
    reason: z.string(),
})
export type CorruptSpan = z.infer<typeof CorruptSpanSchema>
