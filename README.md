# playwright-mcp-multi

> **Run multiple Playwright browsers in parallel from one MCP connection — and stop fighting the Chromium profile lock when several MCP clients share a workspace.**

`playwright-mcp-multi` is a thin **multi-session proxy** that sits in front of [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp). It speaks MCP to your client (Claude Code, Cursor, etc.) on stdio and, behind the scenes, spawns one upstream `@playwright/mcp` child process per browser session — each with its own Chromium window, its own user-data-dir, and its own MCP connection.

[![CI](https://github.com/zane-programs/playwright-mcp-multi/actions/workflows/ci.yml/badge.svg)](https://github.com/zane-programs/playwright-mcp-multi/actions/workflows/ci.yml)

## Why?

The stock `@playwright/mcp` server has two limitations that bite as soon as you use it from more than one chat:

1. **Cross-process profile lock.** Every MCP client computes the same default user-data-dir (something like `~/Library/Caches/ms-playwright/mcp-{channel}-{sha256(cwd).slice(0,7)}`). Chromium's `SingletonLock` blocks the second client with `Browser is already in use for {dir}, use --isolated to run multiple instances of the same browser`.
2. **One browser per MCP connection.** Upstream's `BrowserBackend` holds a single context with a single current tab. There's no first-class concept of running two browsers in one chat.

`playwright-mcp-multi` fixes both. Each browser session is its own child process with its own profile dir, so:

- **Multiple MCP clients on the same machine** (e.g. two Claude Code chats) can each open their own browsers, with no profile collision — sessions are keyed by *session name*, not by cwd.
- **Within a single client**, you can `browser_session_new {name:"left"}` and `browser_session_new {name:"right"}` to drive two browsers side-by-side. Every existing `browser_*` tool gets an optional `session` argument to pick which one to act on.

## Install

```bash
git clone https://github.com/zane-programs/playwright-mcp-multi.git
cd playwright-mcp-multi
npm install
npm run install-browser   # fetches the Chromium build that @playwright/mcp expects
```

Then point your MCP client at it. For Claude Code, edit `~/.claude.json`:

```json
{
  "mcpServers": {
    "playwright": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/playwright-mcp-multi/multi-cli.js"]
    }
  }
}
```

For other MCP clients (Cursor, Windsurf, Cline, Copilot, etc.), use the same `command`/`args` pair under whatever schema they use.

## How it works

```
Claude chat A  ──stdio──┐
                         ├──> multi-cli.js (this proxy)
                         │       ├── default child: @playwright/mcp --user-data-dir=…/mcp-multi/default
                         │       ├── session "left":  @playwright/mcp --user-data-dir=…/mcp-multi/left
                         │       └── session "right": @playwright/mcp --user-data-dir=…/mcp-multi/right
Claude chat B  ──stdio──┘   (a separate proxy process; its own children)
```

- Each browser session = one full `@playwright/mcp` child process = one Chromium = one persistent profile dir.
- The proxy never owns a Playwright browser itself; it only owns MCP clients to its children.
- The tool list is discovered once at proxy startup from the default child, augmented with the optional `session` field, then cached.
- The three `browser_session_*` management tools are owned by the proxy.

## Tools

Every tool that `@playwright/mcp` ships gets one extra optional argument:

```
session: string  // omit to use the default session
```

Plus three new tools added by the proxy:

### `browser_session_new`

Create a new browser session. Returns `{name, browser, profileDir, isolated, status}`.

```jsonc
{
  "name": "left",                       // required, unique within this proxy
  "browser": "chromium",                // optional override
  "isolated": false,                    // optional; true = ephemeral profile
  "userDataDir": "/some/path",          // optional override
  "viewport": {"width": 1280, "height": 720},
  "device": "iPhone 15",
  "executablePath": "/path/to/chrome",
  "proxyServer": "http://myproxy:3128",
  "storageState": "/path/to/storage.json"
}
```

If another playwright-mcp instance is holding the same profile dir's `SingletonLock`, this returns a structured error containing `"locked"` rather than crashing — pick a different session name, pass `isolated: true`, or stop the other process.

### `browser_session_list`

Returns every active session with status (`ready` | `failed` | `closed`), browser, profile directory, and whether it's the default.

### `browser_session_close`

Close a named session. The default session can't be closed via this tool — shut down the MCP server itself to release it.

## Example

```jsonc
// In Claude (or any MCP client):
{ "tool": "browser_session_new", "arguments": { "name": "left" } }
{ "tool": "browser_session_new", "arguments": { "name": "right" } }
{ "tool": "browser_navigate",    "arguments": { "session": "left",  "url": "https://example.com" } }
{ "tool": "browser_navigate",    "arguments": { "session": "right", "url": "https://wikipedia.org" } }
{ "tool": "browser_session_list" }
// ↳ two ready sessions, two Chromium windows on screen
```

## CLI flags (`multi-cli.js`)

All flags below are *defaults* applied to every spawned session unless overridden via `browser_session_new`. They mirror the single-session `@playwright/mcp` flags:

`--browser`, `--headless`, `--no-sandbox`, `--isolated`, `--config`, `--output-dir`, `--viewport-size`, `--device`, `--executable-path`, `--proxy-server`, `--ignore-https-errors`, `--storage-state`, `--save-session`, `--user-agent`, `--init-script`, `--init-page`, `--caps`.

Plus three flags specific to the proxy:

| Flag | Description |
|---|---|
| `--profile-root <path>` | Root dir for per-session persistent profiles. Defaults to `~/Library/Caches/ms-playwright/mcp-multi` on macOS, `%LOCALAPPDATA%\ms-playwright\mcp-multi` on Windows, `~/.cache/ms-playwright/mcp-multi` on Linux. |
| `--default-session <name>` | Name of the implicit default session (default: `default`). |
| `--max-sessions <n>` | Soft cap on concurrent sessions (default: `8`). |

`--port` is intentionally not supported in multi-session mode — the proxy is stdio-only. For HTTP transport, use `@playwright/mcp` directly.

## Profile path scheme

Persistent profiles live under `<profile-root>/<sanitized-session-name>`:

- macOS: `~/Library/Caches/ms-playwright/mcp-multi/<name>`
- Linux: `~/.cache/ms-playwright/mcp-multi/<name>`
- Windows: `%LOCALAPPDATA%\ms-playwright\mcp-multi\<name>`

Two MCP clients (chats) that pick different session names never collide. Two MCP clients that pick the same name *will* collide on the SingletonLock — the second one's `browser_session_new` returns a clean error so you can rename and retry.

## Development

```bash
npm install
npm run install-browser
npm run ctest          # run the multi-session test suite headless on Chromium
```

The suite covers:

- schema augmentation (every `browser_*` tool exposes `session`)
- session tool registration
- default session auto-creation
- two named sessions navigating independently
- close-then-call-fails-cleanly
- cross-process collision returning a structured error
- default session close rejected
- duplicate session name rejected
- `--help` smoke
- per-session browser override
- `profileDir` reporting
- isolated sessions reporting null `profileDir`

## Credits

This project is a thin proxy on top of [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp) and [Playwright](https://github.com/microsoft/playwright), both © Microsoft Corporation, both Apache-2.0. See [`NOTICE`](./NOTICE).

## License

Apache-2.0. See [`LICENSE`](./LICENSE).
