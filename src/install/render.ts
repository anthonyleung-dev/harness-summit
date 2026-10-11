// Renderers: command files for every harness and the Claude Code plugin, all from templates.ts.
import { jsonText } from '../core/fsx.js'
import { SUMMIT_NAME, type Harness } from '../core/schemas.js'
import { SUMMIT_VERSION } from '../core/version.js'
import { COMMANDS, GENERATED_MARKER, type CommandTemplate } from './templates.js'

// How a registration starts the CLI: absolute node + absolute cli in installs, `node` +
// `${CLAUDE_PLUGIN_ROOT}`-relative cli in the repo's dev plugin. `env` holds the absolute harness CLI
// paths install found (SUMMIT_CODEX_BIN, SUMMIT_OPENCODE_BIN); absent in the dev plugin.
export interface Launch {
    node: string
    cli: string
    env?: Record<string, string>
}

// Purpose: the one pretty-JSON form of rendered config files (4-space indent, final newline).
function prettyJson(value: unknown): string {
    return jsonText(value, 4)
}

export interface RenderedFile {
    rel: string
    content: string
}

// Purpose: command, args and (when install found harness CLIs) env of the MCP server registration
// for one harness.
export function mcpLaunch(
    launch: Launch,
    harness: Harness,
): { command: string; args: string[]; env?: Record<string, string> } {
    const base = { command: launch.node, args: [launch.cli, 'mcp', '--harness', harness] }
    return launch.env !== undefined && Object.keys(launch.env).length > 0 ? { ...base, env: launch.env } : base
}

// Purpose: YAML frontmatter block from ordered key/value pairs (values JSON-quoted, valid YAML).
function frontmatter(pairs: [string, string | boolean | null][]): string {
    const lines = pairs
        .filter(([, v]) => v !== null)
        .map(([k, v]) => `${k}: ${typeof v === 'boolean' ? v : JSON.stringify(v)}`)
    return `---\n${lines.join('\n')}\n---\n`
}

const CODEX_NOTE =
    'Codex note: if `$ARGUMENTS` above is shown literally, the user text is the text that follows this skill mention in the user message.'

// Purpose: render one command for one harness, as a path relative to that harness's command dir.
export function renderCommand(harness: Harness, cmd: CommandTemplate): RenderedFile {
    const body = `${GENERATED_MARKER}\n\n${cmd.body}\n`
    switch (harness) {
        case 'claude':
            return {
                rel: `skills/${cmd.name}/SKILL.md`,
                content:
                    frontmatter([
                        ['name', cmd.name],
                        ['description', cmd.description],
                        ['argument-hint', cmd.argumentHint],
                        ['disable-model-invocation', true],
                    ]) + body,
            }
        case 'codex':
            return {
                rel: `${cmd.name}/SKILL.md`,
                content:
                    frontmatter([
                        ['name', cmd.name],
                        ['description', cmd.description],
                    ]) +
                    body +
                    `\n${CODEX_NOTE}\n`,
            }
        case 'pi':
        case 'omp':
            return {
                rel: `${cmd.name}.md`,
                content:
                    frontmatter([
                        ['description', cmd.description],
                        ['argument-hint', cmd.argumentHint],
                    ]) + body,
            }
        case 'opencode':
            return { rel: `${cmd.name}.md`, content: frontmatter([['description', cmd.description]]) + body }
    }
}

// Purpose: every command file (one per template in COMMANDS) for one harness.
export function renderCommands(harness: Harness): RenderedFile[] {
    return COMMANDS.map((c) => renderCommand(harness, c))
}

// Purpose: one hook in exec form (`command` + `args`, XPLAT-AUDIT B5): Claude Code spawns node directly
// with no shell on every OS, so no shell parses the paths (PowerShell on Windows cannot run a quoted
// path followed by a second string) and the hook's parent is the claude process itself (the ppid
// fallback of `claudePid`, src/cli/hooks.ts). Path placeholders (`${CLAUDE_PLUGIN_ROOT}`) are expanded
// in each `args` element.
function hookCommand(launch: Launch, sub: string): { type: 'command'; command: string; args: string[] } {
    return { type: 'command', command: launch.node, args: [launch.cli, 'hook', sub] }
}

// Purpose: every file of the Claude Code plugin (manifest, MCP server, hooks, skills).
export function renderClaudePlugin(launch: Launch): RenderedFile[] {
    const manifest = {
        name: SUMMIT_NAME,
        version: SUMMIT_VERSION,
        description: 'harness-summit: message other coding-agent sessions on this machine',
    }
    const mcp = { mcpServers: { [SUMMIT_NAME]: mcpLaunch(launch, 'claude') } }
    const hooks = {
        hooks: {
            SessionStart: [{ hooks: [{ ...hookCommand(launch, 'claude-session-start'), timeout: 20 }] }],
            // Refreshes the session file on every prompt (a reconnected server trusts it again).
            UserPromptSubmit: [{ hooks: [{ ...hookCommand(launch, 'claude-prompt-submit'), timeout: 10 }] }],
            FileChanged: [
                {
                    hooks: [
                        {
                            ...hookCommand(launch, 'claude-file-changed'),
                            asyncRewake: true,
                            timeout: 20,
                        },
                    ],
                },
            ],
        },
    }
    return [
        { rel: '.claude-plugin/plugin.json', content: prettyJson(manifest) },
        { rel: '.mcp.json', content: prettyJson(mcp) },
        { rel: 'hooks/hooks.json', content: prettyJson(hooks) },
        ...renderCommands('claude'),
    ]
}

// Purpose: marketplace manifest that lists the plugin in sub-folder `claude/`.
export function renderMarketplace(): RenderedFile {
    const market = {
        name: SUMMIT_NAME,
        owner: { name: SUMMIT_NAME },
        plugins: [{ name: SUMMIT_NAME, source: './claude', description: 'harness-summit for Claude Code' }],
    }
    return { rel: '.claude-plugin/marketplace.json', content: prettyJson(market) }
}
