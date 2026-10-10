# harness-summit: notes for agents working in this repo

Read `~/.claude/CLAUDE.md` first if it exists. SPEC.md is the source of truth. References in comments
and in SPEC.md such as `probes/<harness>.md`, `REVIEW M1` or `DELTA-REVIEW-1 F9` point to the
development notes, which stay outside this repository (see `.gitignore`).

## Stack

- TypeScript (ESM, `module: nodenext`). Node 22 or later. The build runs on Node 23.11.0.
- Linux, macOS and Windows. Never inspect OS processes: no `/proc`, `ps`, PowerShell, wmic or native
  FFI. Liveness is the heartbeat file, locks are leases, both by file mtime. CI runs all three OSes
  (`.github/workflows/ci.yml`); live runs happened on Linux only.
- `@modelcontextprotocol/sdk` 1.32.1. Use `registerTool`, because `tool()` is deprecated. The stdio
  import is `@modelcontextprotocol/sdk/server/stdio.js`.
- `zod` 4.6.5 validates every tool input and output, every file read and the CLI arguments.
- `smol-toml` 1.9.1 parses `~/.codex/config.toml` before install edits it (it never writes TOML).
- `jsonc-parser` makes key-level edits in JSON and JSONC files. It is called without
  `formattingOptions` on purpose: with them, it reformats whole lines and changes foreign keys.
- `typescript` 7.0.2 (the native `tsc`), `vitest` 5.0.3, `tsx` 4.23.15, `prettier` 3.9.9 with
  `@trivago/prettier-plugin-sort-imports` 6.0.2 (it reads the `importOrder` keys of `.prettierrc`).
  TS 7 works with this setup: vitest and tsx strip types themselves and never call `tsc`.
- vitest 5 could not be installed with npm 10.9.2 (arborist error `Cannot read properties of null
(reading 'edgesOut')`). It was installed with `npx npm@latest install -D vitest@latest`.

## Commands

```sh
npm run build       # tsc -> dist/, then regenerate plugins/claude from the templates
npm run typecheck   # tsc --noEmit over src, test, adapters
npm test            # build + vitest (unit + integration)
npx prettier --check .
npm run dev -- <args>   # run the CLI from source with tsx
```

## Harness facts that are easy to get wrong

- The harness comes ONLY from the `--harness` flag. Never infer harness or session from inherited env.
  An OpenCode MCP child inherits `CLAUDE_CODE_SESSION_ID` from whoever started the service, and that
  env value is stale after `/clear` anyway. The one exception is `SUMMIT_SESSION_ID` with
  `--harness pi`: our own pi extension sets it on the child it registers.
- Host keys (`src/core/hostKey.ts` is the only implementation) follow the harness SESSION, never a
  process (owner decision 2026-10-10: a session resumed days later gets its agent back):
    - Claude: `claude-<sessionId>`. The SessionStart hook writes `.sessions/claude-<claudePid>.json`
      (`src/core/sessions.ts`; pid = the hook's ppid, `$CLAUDE_PID` only confirms); the server reads it
      via its parent pid on EVERY call and trusts it only when written after its own start minus 30 s
      (a reused pid must not adopt a dead session's file). UserPromptSubmit refreshes the file from its
      stdin `session_id` (same writer), so a `/mcp` reconnect recovers on the next prompt; FileChanged only
      renews `at` when its stdin id is the recorded one (it must never switch the session).
    - OMP renews its session file on `agent_start` too (`hook ext-session`).
    - pi: `pi-<sessionId>` from env `SUMMIT_SESSION_ID`: the extension calls `registerMcpServer` on every
      `session_start`. Install writes NO pi mcp.json entry (a same-name entry would win) and retires an
      old one (`kind: 'retire'` action).
    - OMP: `omp-<sessionId>`. The extension (only with `ctx.hasUI`) writes `.sessions/omp-<ompPid>.json`
      on `session_start` and `session_switch` through `hook ext-arm`; the server reads it per call.
    - Codex `codex-<_meta.threadId>`, OpenCode `opencode-<_meta["ai.opencode/sessionID"]>`.
    - The server reads `process.ppid` ONCE at start (`hostPid` in CallContext): after the host dies,
      Linux reparents to init. Missing session → `SUMMIT_NO_HOST_KEY` with a message that says why.
    - Codex and OpenCode send no id on `initialize` or `tools/list`. A call without the id fails with
      `SUMMIT_NO_HOST_KEY`.
- Identity is read from `<root>/.hosts/<hostKey>.json` on every call and never cached; a read repairs
  a record whose folder sits in another group (`src/core/identity.ts`). Records never go stale; only
  `summit_bye` deletes one.
- Liveness (`src/core/heartbeat.ts`): every server `utimes` `<root>/.alive/<hostKey>.json` every 2 s and
  on every call (`beatCaller` in `src/flows/context.ts`): claude/omp the current session from the
  session file each tick, pi its env session, codex every thread a call registered, opencode none.
  `alive` = beat fresh (`isStaleMtime` in `src/core/freshness.ts`: ≤ 10 s in the past or future) →
  true, stale or missing → false, OpenCode always "unknown". A "gone" decision (forced takeover, lock break) takes the second look (`confirmGone`, 2.5 s;
  any mtime change = alive). A name takeover needs `force` for every holder that is not alive now.
  `agent.json.pid` is informational. Every write of an existing `agent.json` goes through
  `updateAgent` (`src/core/agents.ts`). `summit_group` holds the new group's `members.lock` from the
  name claim until the folder has moved, so a map entry whose uuid has no folder in that group is
  always a leftover: it is free and every claim drops it. The same hold covers the old group's lock
  (`lockGroups`, sorted key order), and the move re-reads `agent.json` under it, so a parallel
  rename never leaves `agent.json` and the new map with different names. Undoing a claim (failed move,
  or a rename whose folder left) goes through `restoreHolder` in `src/flows/rename.ts`.
- A lock is a lease (owner line `<token> <ISO time>`): `withLock` refreshes the lock's mtime every 2 s
  while it holds it, for at most `LOCK_MAX_HOLD_MS` = 60 s (`src/core/lease.ts`); stale = not refreshed
  for 10 s and confirmed by the second look, or a token this process abandoned. Breakers are
  serialized by `<lock>.break` (`src/core/lock.ts`, SPEC §5). Renames go through
  `renameRetry` (`src/core/fsx.ts`), which retries EPERM/EBUSY/EACCES (Windows) and never reports a
  failed rename as done.
- Claude Code sends `server/discover` before `initialize`. The SDK answers -32601 and goes on (an
  integration test covers this).
- Claude hooks:
    - Exec form in hooks.json (`command` = node, `args` = [cli, "hook", sub]): no shell on any OS, so
      the hook's ppid is claude. Follows the Claude Code docs; not yet run live on any OS.
    - SessionStart records the session (pid = its parent pid; `$CLAUDE_PID` only confirms) and arms
      `.wake/claude-<sessionId>.signal`; FileChanged reads the session file to find the current signal.
    - FileChanged has no matcher. It sets `asyncRewake: true` and `timeout: 20`. It exits 0 when
      nothing is unread, else it prints the notice on stderr and exits 2.
    - FileChanged never prints `watchPaths`, because that replaces the watch list.
    - Never use `rewakeMessage` or `rewakeSummary`. They are internal fields.
    - Hooks log to the file only. Claude shows hook stderr to the model.
- pi needs `exposure: "direct"` on the server the extension registers, or the model never sees the
  tools. OMP has no `registerMcpServer` and no `omp mcp add` (it keeps the mcp.json entry).
- The pi and OMP wake shapes are different:
    - pi when idle: parent-wake (a custom message, then a steer user line, with a 10 s dedupe).
    - pi when busy: a followUp.
    - OMP: always `triggerTurn` with `deliverAs: "followUp"`.
    - OMP also re-arms on `session_switch`.
- Run `codex queue` once and wait for it to exit (15 s), with no retry. A retry duplicates the
  message. `sent` means exit 0. The binary comes from `SUMMIT_CODEX_BIN` (`SUMMIT_OPENCODE_BIN` for
  opencode), which install writes into every registration's env; a recorded path that is no longer
  executable falls back to PATH.
- The wake decision holds the receiver's `.cursor.lock` and writes its debounce claim to `.lastwake`
  before the wake command runs; a failed wake removes only its own claim (`src/core/wake.ts`).
- The rules for mail: `JOIN_INSTRUCTION` (user's words, in the `/summit-join` body) and
  `SUMMIT_GUIDANCE` (neutral, the `guidance` field of `summit_join` and `summit_read`). Both come from
  `src/core/notice.ts`; their text is an owner decision (FIXES.md rounds 2 and 3). Do not reword them.
  A reply needs no answer: `summit_read` gives `replyHint` only on a record without `replyTo`.
- Never write the OpenCode JSONC by hand. Install uses `opencode mcp add --global`. It writes
  `opencode.json` if it exists, else `opencode.jsonc` if it exists, else a new `opencode.json`
  (verified in a temp HOME; see FIXES-LOG.md m11).
- The MCP server never writes logs to stdout. stdout is the protocol.

## One function, one door

Before you write anything, search for an existing helper and extend it with a parameter. Each of
these has exactly one implementation:

| What                | Where                                                            |
| ------------------- | ---------------------------------------------------------------- |
| Notice text         | `src/core/notice.ts`                                             |
| Signal protocol     | `src/core/signal.ts`, with the path in `src/core/paths.ts`       |
| Host-key resolution | `src/core/hostKey.ts`                                            |
| Wake argv           | `src/core/wake.ts`                                               |
| External CLI spawns | `src/core/exec.ts` (`spawnPlan`, `cliBin`, `findOnPath`)         |
| cmd.exe quoting     | `src/core/winCmd.ts`                                             |
| Lock files          | `src/core/lock.ts` (`withLock`, `formatLockOwner`, `isTaken`)    |
| Freshness, sleep    | `src/core/freshness.ts` (`isStaleMtime`, `confirmGone`, `sleep`) |
| Busy errno (Win)    | `isBusyErrno` in `src/core/fsx.ts`                               |
| Name case, devices  | `nameKey` in `members.ts`, `isReservedName` in `schemas.ts`      |
| File modes          | `DIR_MODE`, `FILE_MODE` in `src/core/paths.ts`                   |
| Lock lease refresh  | `src/core/lease.ts`                                              |
| Rename (retrying)   | `renameRetry` in `src/core/fsx.ts`                               |
| agent.json update   | `updateAgent` in `src/core/agents.ts`                            |
| Group lock          | `lockGroup` (`lockGroups` for several) in `src/core/members.ts`  |
| Claim undo          | `restoreHolder` in `src/flows/rename.ts`                         |
| Heartbeat           | `src/core/heartbeat.ts`, `isAlive` in `src/core/agents.ts`       |
| Project root key    | `normalizeRootPath` in `src/core/project.ts`                     |
| Session harnesses   | `SIGNAL_HARNESSES`, `SESSION_FILE_HARNESSES` in `hostKey.ts`     |
| Session files       | `src/core/sessions.ts` (`writeSession(Sync)`, `readSession`)     |
| Host key format     | `joinHostKey` in `src/core/hostKey.ts`                           |
| File read/write     | `src/core/fsx.ts` (`readTextFile`, `pathExists`, JSON)           |
| CLI arguments       | `src/cli/args.ts`                                                |
| Product name        | `SUMMIT_NAME` in `src/core/schemas.ts`                           |
| Uuid / name schema  | `UuidSchema`, `NameSchema` in `src/core/schemas.ts`              |
| Command bodies      | `src/install/templates.ts`                                       |
| Test helpers        | `test/helpers/` (`env.ts`, `state.ts`, `mcp.ts`)                 |

The pi/OMP extension is a separate door, and this is the written reason: the installed copy lives
alone in the harness's extension dir. So it gets the host key, the signal path and the notice from
the CLI, and it checks the CLI output by hand (`parseArmed`), because it cannot import Zod there. It
has no copy of the spawn door either: it starts only the node `.exe` with the CLI, and every other
command runs inside the CLI through `src/core/exec.ts`.

Test helpers are portable: no `sleep`, `true`, `sh` or procfs. `callFor(root, harness, { session,
hostPid })` records the session as the host side would (session file or pi env); host pids come from
`fakePid()`; an ended session is `ageBeat(root, hostKey, ms)`; a distinct ppid for a real CLI or server
comes from the Node parent of `cliCommand(..., viaParent)` (`McpProc.start` writes the session file for
that parent); a fake CLI is `fakeBin` (a `.cmd` shim on Windows). Signal tests skip on Windows (a
signal there terminates at once).

## Never install into the real home in tests

- Tests set `HARNESS_SUMMIT_HOME` to a temp dir (`test/setup.ts` does this for every file). Install
  tests use `--home <tmpdir>` and a stubbed Exec, or `HARNESS_SUMMIT_EXEC_LOG`, which records
  commands and runs nothing.
- Never run `harness-summit install` against the real home. Never edit `~/.claude`, `~/.codex`,
  `~/.pi`, `~/.omp`, `~/.config/opencode` or `~/.claude.json`. The owner runs the real install.
- Never start model turns in a harness. You may run harness CLIs only with `--help` or `--version`.
