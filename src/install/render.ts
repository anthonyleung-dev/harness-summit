// Renderers: command files for every harness and the Claude Code plugin, all from templates.ts.
import { jsonText } from '../core/fsx.js'
import { HARNESSES, SUMMIT_NAME, SUMMIT_REPO, type Harness } from '../core/schemas.js'
import { SUMMIT_VERSION } from '../core/version.js'
import { COMMANDS, GENERATED_MARKER, type CommandTemplate } from './templates.js'

// How a registration starts the CLI: absolute node + absolute cli in installs, `node` +
// `${CLAUDE_PLUGIN_ROOT}`-relative cli in the repo's dev plugin and in the public npm plugin. `env` holds the absolute harness CLI
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

// The Claude plugin's description (the dev/installed plugin and the public npm plugin).
const PLUGIN_DESCRIPTION = `${SUMMIT_NAME}: message other coding-agent sessions on this machine`
// The GitHub owner of SUMMIT_REPO: the public plugin's author and the server.json namespace.
const REPO_OWNER = SUMMIT_REPO.split('/')[0]!

// Purpose: the Claude hook event map (SessionStart, UserPromptSubmit, FileChanged), with no `hooks`
// wrapper: the inline shape of plugin.json `hooks`. hooks/hooks.json wraps it in `{ hooks: ... }`.
export function claudeHooks(launch: Launch): Record<string, unknown> {
    return {
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
    }
}

// Purpose: every file of the Claude Code plugin (manifest, MCP server, hooks, skills).
export function renderClaudePlugin(launch: Launch): RenderedFile[] {
    const manifest = { name: SUMMIT_NAME, version: SUMMIT_VERSION, description: PLUGIN_DESCRIPTION }
    const mcp = { mcpServers: { [SUMMIT_NAME]: mcpLaunch(launch, 'claude') } }
    return [
        { rel: '.claude-plugin/plugin.json', content: prettyJson(manifest) },
        { rel: '.mcp.json', content: prettyJson(mcp) },
        { rel: 'hooks/hooks.json', content: prettyJson({ hooks: claudeHooks(launch) }) },
        ...renderCommands('claude'),
    ]
}

// Where the public plugin's skills sit inside the npm package (the dev plugin's generated skills).
export const PUBLIC_PLUGIN_SKILLS = './plugins/claude/skills'

// Purpose: the public plugin's manifest at the repo root (`.claude-plugin/plugin.json`, shipped in the npm
// package). The MCP server and the hooks are inline, so the repo root has no `.mcp.json` (that file would
// be this repo's own project MCP config); the skills are the dev plugin's generated ones.
export function renderPublicPlugin(launch: Launch): RenderedFile {
    const manifest = {
        name: SUMMIT_NAME,
        version: SUMMIT_VERSION,
        description: PLUGIN_DESCRIPTION,
        mcpServers: { [SUMMIT_NAME]: mcpLaunch(launch, 'claude') },
        hooks: claudeHooks(launch),
        skills: PUBLIC_PLUGIN_SKILLS,
        author: { name: REPO_OWNER },
    }
    return { rel: '.claude-plugin/plugin.json', content: prettyJson(manifest) }
}

// A marketplace entry's `source`: a relative path or a source object such as `{ source: 'npm', ... }`.
export type PluginSource = string | Record<string, string>

// Purpose: marketplace manifest that lists the plugin. Default: the install's sub-folder `claude/`. The
// public marketplace also passes a marketplace `description` (shown in /plugin; `claude plugin validate`
// warns without one); install's local marketplace keeps none, so its file stays as earlier installs wrote it.
export function renderMarketplace(
    source: PluginSource = './claude',
    description = `${SUMMIT_NAME} for Claude Code`,
    marketDescription?: string,
): RenderedFile {
    const market = {
        name: SUMMIT_NAME,
        ...(marketDescription === undefined ? {} : { description: marketDescription }),
        owner: { name: SUMMIT_NAME },
        plugins: [{ name: SUMMIT_NAME, source, description }],
    }
    return { rel: '.claude-plugin/marketplace.json', content: prettyJson(market) }
}

// Purpose: the public marketplace at the repo root (`/plugin marketplace add <SUMMIT_REPO>`). Its one
// entry fetches this release of the npm package, which carries the public plugin.json.
export function renderPublicMarketplace(): RenderedFile {
    return renderMarketplace(
        { source: 'npm', package: SUMMIT_NAME, version: SUMMIT_VERSION },
        PLUGIN_DESCRIPTION,
        PLUGIN_DESCRIPTION,
    )
}

// The MCP Registry description (max 100 characters): it says that setup is needed.
export const SERVER_DESCRIPTION = `Let coding agents on one machine message and wake each other. Run \`${SUMMIT_NAME} install\` first.`

// Purpose: server.json, the MCP Registry entry. Name and repository come from SUMMIT_REPO, both versions
// from SUMMIT_VERSION, the `--harness` choices from HARNESSES.
export function renderServerJson(): RenderedFile {
    const repoUrl = `https://github.com/${SUMMIT_REPO}`
    const server = {
        $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
        name: `io.github.${REPO_OWNER}/${SUMMIT_NAME}`,
        title: SUMMIT_NAME,
        description: SERVER_DESCRIPTION,
        repository: { url: repoUrl, source: 'github' },
        websiteUrl: `${repoUrl}#readme`,
        version: SUMMIT_VERSION,
        packages: [
            {
                registryType: 'npm',
                registryBaseUrl: 'https://registry.npmjs.org',
                identifier: SUMMIT_NAME,
                version: SUMMIT_VERSION,
                transport: { type: 'stdio' },
                packageArguments: [
                    {
                        type: 'positional',
                        value: 'mcp',
                        description: 'The sub-command that runs the MCP stdio server.',
                    },
                    {
                        type: 'named',
                        name: '--harness',
                        description: `The harness that starts this server. Run \`${SUMMIT_NAME} install\` to register it with the wake hooks.`,
                        isRequired: true,
                        choices: [...HARNESSES],
                    },
                ],
            },
        ],
    }
    return { rel: 'server.json', content: prettyJson(server) }
}
