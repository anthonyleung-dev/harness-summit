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
// them. Known limits: `%` (variable expansion) and `!` (delayed expansion, off by default) are not
// guaranteed to survive cmd.exe, and a line break cannot pass at all (refused). The wake payloads hold
// neither (src/core/wake.ts: names and uuids only).
import { summitError } from './errors.js'

// cmd.exe metacharacters (cross-spawn's list).
const META = /([()\][%!^"`<>&|;, *?])/g

// Purpose: tell whether a file is a batch file that only cmd.exe can run.
export function isBatchFile(file: string): boolean {
    return /\.(cmd|bat)$/i.test(file)
}

// Purpose: quote one argument for the C runtime parser of the program the batch file starts, then
// caret-escape it twice for the two cmd.exe parses (see the header).
export function escapeCmdArg(arg: string): string {
    if (/[\r\n]/.test(arg)) {
        throw summitError('SUMMIT_BAD_INPUT', 'an argument for a batch file cannot hold a line break', 'escapeCmdArg', {
            arg,
        })
    }
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
    return [`"${file}"`, ...args.map(escapeCmdArg)].join(' ')
}

// Purpose: the cmd.exe argv that runs a batch file: `/d` (no AutoRun commands), `/s` (strip exactly the
// outer quotes), `/c` (run the line, then exit). The caller spawns it with windowsVerbatimArguments, so
// Node passes the line unchanged.
export function cmdArgs(file: string, args: string[]): string[] {
    return ['/d', '/s', '/c', `"${batchCommandLine(file, args)}"`]
}
