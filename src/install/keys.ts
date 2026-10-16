// The registration keys install writes in harness configs, in one place: the server name, and the key path of
// the server in each config format.
import { SUMMIT_NAME } from '../core/schemas.js'

// Registration key in every harness config, and the Claude plugin + marketplace name.
export const SERVER_KEY = SUMMIT_NAME
// The server in a JSON `mcpServers` map (Claude's .mcp.json, the pi and OMP mcp.json).
export const JSON_KEY = ['mcpServers', SERVER_KEY]
// The server table in the Codex config.toml.
export const CODEX_KEY = ['mcp_servers', SERVER_KEY]
// Where `opencode mcp add` puts the server in opencode.json(c).
export const OPENCODE_KEY = ['mcp', 'servers', SERVER_KEY]
