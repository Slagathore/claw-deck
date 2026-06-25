# claw-bridge

A minimal VS Code extension that publishes **editor-only signals** to Claw Deck over a localhost HTTP server
(default `127.0.0.1:39217`). Claw Deck's Atlas/Council read these when VS Code is open and degrade to
filesystem+git when it isn't — there is no hard dependency in either direction.

## What it exposes (read-only)

| Endpoint | Returns |
|---|---|
| `GET /status` | extension version + open workspace folders |
| `GET /selection` | active editor file + selected text + line |
| `GET /diagnostics[?file=]` | live Problems (errors/warnings) |
| `GET /symbols?file=` | document symbols for a file |
| `GET /lm/models` | `vscode.lm.selectChatModels()` metadata |
| `POST /lm/invoke` | `{ model, messages }` → invokes a chat model, returns `{ content }` |
| `GET /mcp` | MCP servers from each folder's `.vscode/mcp.json` |

## Build & run

```bash
cd claw-bridge
npm install
npm run compile
```

Then press **F5** in VS Code (Run Extension) or package with `vsce package` and install the `.vsix`. The port is
configurable via the `clawBridge.port` setting and must match Claw Deck's `clawBridgePort` (Settings → it defaults
to `39217`). In Claw Deck, roster agents with transport `vscode-lm` are proxied through `POST /lm/invoke`.

> Built as part of Fusion Phase 6. It is intentionally observational — it never edits files; all writes still go
> through Claw Deck's worktree executor.
