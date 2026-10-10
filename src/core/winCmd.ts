// Command lines for Windows batch files (`.cmd`, `.bat`): Node cannot spawn them without a shell, so the
// spawn door (src/core/exec.ts) runs them as `cmd.exe /d /s /c "<line>"` with this line. Pure string
// functions, so every OS can test them.
//
// The quoting follows cross-spawn (lib/util/escape.js): each argument is first quoted for the C runtime
// argument parser (CommandLineToArgvW rules: backslashes before a quote are doubled, the quote is
// escaped), then every cmd.exe metacharacter, the quotes included, gets a caret, so cmd.exe never sees an
// unescaped quote and never enters quote mode inside an argument. The carets are applied TWICE: a batch
// file passes its arguments on with `%*` (an npm shim runs `node.exe <script> %*`), and cmd.exe parses
// the expanded line a second time. cross-spawn doubles them only for shims under `node_modules/.bin`;
// a global npm shim (`%APPDATA%\npm\codex.cmd`) has the same `%*` line, so here every batch file gets
// them. cmd.exe expands `%VAR%` (and `%VAR:a=b%`) before any caret counts, and `!VAR!` under delayed
// expansion, and a line break ends the command: none of them can be escaped reliably, so an argument or
// a batch path that holds one is refused (SUMMIT_BAD_INPUT). `/v:off` turns delayed expansion off for
// the shell we start. The wake payloads never hold them (src/core/schemas.ts SenderLabelSchema: notices
// name senders by display name or uuid only).
import { summitError } from './errors.js'

// cmd.exe metacharacters (cross-spawn's list).
const META = /([()\][%!^"`<>&|;, *?])/g

// Purpose: tell whether a file is a batch file that only cmd.exe can run.
export function isBatchFile(file: string): boolean {
    return /\.(cmd|bat)$/i.test(file)
}

// Characters cmd.exe acts on before escaping applies: variable expansion and line breaks.
const UNSAFE = /[%!\r\n]/

// Purpose: refuse a value that cmd.exe would expand or cut (`%`, `!`, a line break).
function assertCmdSafe(value: string, what: string, fn: string): void {
    if (UNSAFE.test(value)) {
        throw summitError('SUMMIT_BAD_INPUT', `${what} for a batch file cannot hold %, ! or a line break`, fn, {
            value,
        })
    }
}

// Purpose: quote one argument for the C runtime parser of the program the batch file starts, then
// caret-escape it twice for the two cmd.exe parses (see the header).
export function escapeCmdArg(arg: string): string {
    assertCmdSafe(arg, 'an argument', 'escapeCmdArg')
    let quoted = arg.replace(/(\\*)"/g, '$1$1\\"')
    quoted = quoted.replace(/(\\*)$/, '$1$1')
    quoted = `"${quoted}"`
    return quoted.replace(META, '^$1').replace(META, '^$1')
}

// Purpose: the `/c` line for a batch file and its arguments: the file path in plain quotes (a path never
// holds a quote, and cmd.exe takes everything inside quotes literally), then each escaped argument.
export function batchCommandLine(file: string, args: string[]): string {
    if (file.includes('"')) {
        throw summitError('SUMMIT_BAD_INPUT', 'a batch file path cannot hold a quote', 'batchCommandLine', { file })
    }
    assertCmdSafe(file, 'a batch file path', 'batchCommandLine')
    return [`"${file}"`, ...args.map(escapeCmdArg)].join(' ')
}

// Purpose: the cmd.exe argv that runs a batch file: `/d` (no AutoRun commands), `/v:off` (no delayed
// expansion), `/s` (strip exactly the outer quotes), `/c` (run the line, then exit). The caller spawns it with windowsVerbatimArguments, so
// Node passes the line unchanged.
export function cmdArgs(file: string, args: string[]): string[] {
    return ['/d', '/v:off', '/s', '/c', `"${batchCommandLine(file, args)}"`]
}
