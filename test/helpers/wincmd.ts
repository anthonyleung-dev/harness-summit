// A model of how Windows takes a `cmd.exe /d /s /c "<line>"` command line apart, for tests on every OS:
// cmd.exe's caret and quote phase (once for the `/c` line, once more when the batch file expands `%*`),
// then the C runtime argument parser of the program the batch file starts. It follows the documented
// rules for the characters the spawn door produces; it is not a full cmd.exe.

// Characters that make cmd.exe do something when they are outside quotes and not escaped.
const OPERATORS = '&|<>()'

// Purpose: one cmd.exe parse of `line`: outside quotes a caret escapes the next character (an escaped
// quote does not toggle quote mode); a quote toggles quote mode and stays; an unescaped operator outside
// quotes throws (cmd.exe would act on it).
export function cmdPhase(line: string): string {
    let out = ''
    let quoted = false
    for (let i = 0; i < line.length; i++) {
        const c = line[i]!
        if (c === '"') {
            quoted = !quoted
            out += c
        } else if (!quoted && c === '^') {
            i++
            out += line[i] ?? ''
        } else if (!quoted && OPERATORS.includes(c)) {
            throw new Error(`cmd.exe would act on ${c} at ${i} in: ${line}`)
        } else out += c
    }
    return out
}

// Purpose: split a command line into argv by the C runtime rules (CommandLineToArgvW): 2n backslashes and
// a quote give n backslashes and toggle quote mode; 2n+1 backslashes and a quote give n backslashes and a
// literal quote; other backslashes are literal; blanks outside quotes separate arguments.
export function msvcrtArgv(line: string): string[] {
    const args: string[] = []
    let cur = ''
    let has = false
    let quoted = false
    for (let i = 0; i < line.length;) {
        const c = line[i]!
        if (c === '\\') {
            let n = 0
            while (line[i] === '\\') {
                n++
                i++
            }
            if (line[i] === '"') {
                cur += '\\'.repeat(Math.floor(n / 2))
                // An odd count escapes the quote; an even count leaves it to toggle quote mode next.
                if (n % 2 === 1) {
                    cur += '"'
                    i++
                }
            } else cur += '\\'.repeat(n)
            has = true
        } else if (c === '"') {
            quoted = !quoted
            has = true
            i++
        } else if (!quoted && (c === ' ' || c === '\t')) {
            if (has) args.push(cur)
            cur = ''
            has = false
            i++
        } else {
            cur += c
            has = true
            i++
        }
    }
    if (has) args.push(cur)
    return args
}

// Purpose: the argv that the program behind a batch shim (`"<node>" "<script>" %*`) receives when the door
// runs `cmd.exe <cmdArgs>`: strip the `/s` outer quotes, parse once, cut off the batch file path, expand
// `%*` into the shim's line and parse again, then split by the C runtime rules.
export function argvThroughShim(cmdArgs: string[]): string[] {
    const line = cmdArgs[3] ?? ''
    if (!line.startsWith('"') || !line.endsWith('"')) throw new Error(`no /s outer quotes: ${line}`)
    const first = cmdPhase(line.slice(1, -1))
    const end = first.indexOf('"', 1)
    const rest = first.slice(end + 1)
    return msvcrtArgv(cmdPhase(rest))
}
