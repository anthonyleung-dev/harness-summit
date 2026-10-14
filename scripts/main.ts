// The one entry guard of the build scripts: run a script's main function only when node (or tsx) started
// that file, not when a test imports it. A failure prints the error and sets exit code 1.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Purpose: run `main` when the module at `metaUrl` is the script node was started with.
export async function runIfMain(metaUrl: string, main: () => unknown): Promise<void> {
    const started = process.argv[1]
    if (started === undefined || path.resolve(started) !== fileURLToPath(metaUrl)) return
    try {
        await main()
    } catch (err) {
        console.error(err)
        process.exitCode = 1
    }
}
