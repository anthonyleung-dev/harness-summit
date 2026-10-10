// Message record format (SPEC §5) and its parser. One record:
//
//   ---\nid: …\nfrom: …\nfromId: …\nto: …\nat: …\n[replyTo: …\n]length: <body bytes>\n---\n<body>\n\n
//
// `length` is an addition to the SPEC header: it lets the parser read a body that itself contains
// `---` lines without guessing (see BUILD-LOG Decisions).
//
// The parser never throws on content (REVIEW M2). Bytes that hold no valid record (a torn append, a
// foreign file) become a corrupt span: the parser reports it and goes on at the next valid record.
import { MessageRecordSchema, type MessageRecord } from './schemas.js'

const OPEN = '---\n'
const TRAILER = '\n\n'
const HEADER_FENCE = '\n' + OPEN
// A real header is under 400 bytes; past this a missing fence means garbage, not a slow append.
const MAX_HEADER_BYTES = 2048
const HEADER_LINE = /^(id|from|fromId|to|at|replyTo|length): (.+)$/
const REQUIRED_KEYS = ['id', 'from', 'fromId', 'to', 'at', 'length']

// Purpose: render one record as the exact bytes to append.
export function formatRecord(rec: MessageRecord): string {
    const r = MessageRecordSchema.parse(rec)
    const lines = [`id: ${r.id}`, `from: ${r.from}`, `fromId: ${r.fromId}`, `to: ${r.to}`, `at: ${r.at}`]
    if (r.replyTo !== undefined) lines.push(`replyTo: ${r.replyTo}`)
    lines.push(`length: ${Buffer.byteLength(r.body)}`)
    return `${OPEN}${lines.join('\n')}\n${OPEN}${r.body}${TRAILER}`
}

// A span of the buffer that holds no valid record; offsets are relative to the buffer start.
export interface BadSpan {
    offset: number
    length: number
    reason: string
}

export interface ParsedRecords {
    records: MessageRecord[]
    // Bytes consumed from the start of the buffer: complete records and corrupt spans. A trailing
    // record that is still being appended is left unconsumed.
    consumed: number
    corrupt: BadSpan[]
}

type Attempt =
    | { kind: 'record'; record: MessageRecord; end: number }
    | { kind: 'incomplete' }
    | { kind: 'corrupt'; reason: string }

// Purpose: parse the header lines strictly: known keys only, each once, required keys present.
function parseHeader(text: string): Record<string, string> | null {
    const out: Record<string, string> = {}
    for (const line of text.split('\n')) {
        const m = HEADER_LINE.exec(line)
        if (m === null || out[m[1] as string] !== undefined) return null
        out[m[1] as string] = m[2] as string
    }
    return REQUIRED_KEYS.every((k) => out[k] !== undefined) ? out : null
}

// Purpose: try to read one record starting at `pos`.
function tryRecordAt(buf: Buffer, pos: number): Attempt {
    const head = buf.toString('utf8', pos, Math.min(buf.length, pos + OPEN.length))
    if (head !== OPEN) return OPEN.startsWith(head) ? { kind: 'incomplete' } : { kind: 'corrupt', reason: 'no fence' }
    const headerStart = pos + OPEN.length
    const headerEnd = buf.indexOf(HEADER_FENCE, headerStart - 1)
    if (headerEnd < 0) {
        return buf.length - pos > MAX_HEADER_BYTES
            ? { kind: 'corrupt', reason: 'no header end' }
            : { kind: 'incomplete' }
    }
    if (headerEnd - pos > MAX_HEADER_BYTES) return { kind: 'corrupt', reason: 'header too long' }
    const header = parseHeader(buf.toString('utf8', headerStart, headerEnd))
    const length = Number(header?.length)
    if (header === null || !Number.isInteger(length) || length < 0) return { kind: 'corrupt', reason: 'bad header' }
    const bodyStart = headerEnd + HEADER_FENCE.length
    const end = bodyStart + length + TRAILER.length
    if (end > buf.length) return { kind: 'incomplete' }
    if (buf.toString('utf8', bodyStart + length, end) !== TRAILER) return { kind: 'corrupt', reason: 'no trailer' }
    const parsed = MessageRecordSchema.safeParse({
        id: header.id,
        from: header.from,
        fromId: header.fromId,
        to: header.to,
        at: header.at,
        ...(header.replyTo !== undefined ? { replyTo: header.replyTo } : {}),
        body: buf.toString('utf8', bodyStart, bodyStart + length),
    })
    return parsed.success ? { kind: 'record', record: parsed.data, end } : { kind: 'corrupt', reason: 'bad header' }
}

// Purpose: the first offset after `from` where a record starts: a complete one, or (with
// `allowIncomplete`) one that is still being appended. Null when there is none.
function nextRecordStart(buf: Buffer, from: number, allowIncomplete: boolean): number | null {
    for (let i = buf.indexOf(OPEN, from); i >= 0; i = buf.indexOf(OPEN, i + 1)) {
        const a = tryRecordAt(buf, i)
        if (a.kind === 'record' || (allowIncomplete && a.kind === 'incomplete')) return i
    }
    if (!allowIncomplete) return null
    // A partial fence at the very end is the start of an append still in progress: keep it.
    for (let k = OPEN.length - 1; k >= 1; k--) {
        const s = buf.length - k
        if (s >= from && OPEN.startsWith(buf.toString('utf8', s))) return s
    }
    return null
}

// Purpose: parse every record in `buf`. Never throws on content: a corrupt span is skipped up to the
// next valid record and reported. A trailing record still being appended is left unconsumed, unless
// a complete record follows it (one writer appends in order, so that record was torn).
export function parseRecords(buf: Buffer): ParsedRecords {
    const records: MessageRecord[] = []
    const corrupt: BadSpan[] = []
    let pos = 0
    while (pos < buf.length) {
        const a = tryRecordAt(buf, pos)
        if (a.kind === 'record') {
            records.push(a.record)
            pos = a.end
            continue
        }
        const next =
            a.kind === 'incomplete' ? nextRecordStart(buf, pos + 1, false) : nextRecordStart(buf, pos + 1, true)
        if (a.kind === 'incomplete' && next === null) break
        const to = next ?? buf.length
        corrupt.push({ offset: pos, length: to - pos, reason: a.kind === 'corrupt' ? a.reason : 'torn record' })
        pos = to
    }
    return { records, consumed: pos, corrupt }
}
