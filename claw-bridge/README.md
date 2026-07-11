# claw-bridge

A small VS Code extension that publishes editor-only signals to Claw Deck over a localhost HTTP server
(default `127.0.0.1:39217`). Claw Deck's Atlas and Council read these when VS Code is open, and fall back to
the filesystem and git when it isn't. Neither side hard-depends on the other.

## What it exposes (read only)

| Endpoint | Returns |
|---|---|
| `GET /status` | extension version + open workspace folders |
| `GET /selection` | active editor file + selected text + line |
| `GET /diagnostics[?file=]` | live Problems (errors/warnings) |
| `GET /symbols?file=` | document symbols for a file |
| `GET /lm/models` | `vscode.lm.selectChatModels()` metadata |
| `POST /lm/invoke` | `{ model, messages }`, invokes a chat model, returns `{ content }` |
| `GET /mcp` | MCP servers from each folder's `.vscode/mcp.json` |

## Build and run

```bash
cd claw-bridge
npm install
npm run compile
```

Then press F5 in VS Code (Run Extension), or package with `vsce package` and install the `.vsix`. The port is
configurable via the `clawBridge.port` setting and has to match Claw Deck's `clawBridgePort` (Settings, defaults
to `39217`). In Claw Deck, roster agents with transport `vscode-lm` are proxied through `POST /lm/invoke`.

> Built as part of Fusion Phase 6. It only observes. It never edits files, and all writes still go
> through Claw Deck's worktree executor.
