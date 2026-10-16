// The fix commands that user-facing error messages name (hostKey.ts, the install marketplace check). One
// place, so every message gives the same steps. Each step is its own command, never joined with `&&`:
// Windows PowerShell 5.1 rejects `&&`.
import { SUMMIT_NAME, SUMMIT_REPO } from './schemas.js'

// The Claude plugin id of both marketplaces (the public one and the one install writes).
export const PLUGIN_ID = `${SUMMIT_NAME}@${SUMMIT_NAME}`

// Purpose: the install command for one harness.
function installCommand(harness: string): string {
    return `${SUMMIT_NAME} install --harness ${harness}`
}

// Purpose: the npm route for one harness, as two commands in order.
export function npmInstallFix(harness: string): string {
    return `run \`npm i -g ${SUMMIT_NAME}\`, then \`${installCommand(harness)}\``
}

// Purpose: the fix for a registration that starts another node or CLI than the one running (doctor): install
// again with the CLI the harness should start.
export function reinstallFix(harness: string): string {
    return `run \`${installCommand(harness)}\``
}

// The in-session steps that remove the public plugin and its marketplace (both named SUMMIT_NAME).
export const PUBLIC_PLUGIN_REMOVAL = `in Claude Code run /plugin uninstall ${PLUGIN_ID}, then /plugin marketplace remove ${SUMMIT_NAME}`

// The in-session steps that add the public plugin.
export const PUBLIC_PLUGIN_ADD = `/plugin marketplace add ${SUMMIT_REPO}, then /plugin install ${PLUGIN_ID}`
