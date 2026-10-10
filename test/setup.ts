// Runs before every test file: point the summit root at a temp dir so no test (and no log line)
// ever touches the real ~/.harness-summit. Tests that need their own root call tmpRoot(). Harness CLI
// paths from the developer's env are dropped so wake argv stays the bare `codex` / `opencode`.
import { tmpDir } from './helpers/env.js'

process.env.HARNESS_SUMMIT_HOME = tmpDir('setup')
delete process.env.HARNESS_SUMMIT_EXEC_LOG
delete process.env.SUMMIT_CODEX_BIN
delete process.env.SUMMIT_OPENCODE_BIN
