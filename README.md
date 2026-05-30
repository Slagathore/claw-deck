# Claw Deck

A simple, robust desktop GUI to run **OpenClaw** and/or **Claude Code** on top of
**Ollama**, with persistent settings, searchable history, thinking-pattern display,
image understanding (incl. desktop screenshots), and a hardened upgrade pipeline
with malware / bad-actor checks before any update is installed.

## Stack

- **Electron + React + TypeScript + Vite** (renderer)
- **Node main process** with IPC + `better-sqlite3` persistence
- **Vitest** for tests

## Features

| Area | What you get |
|---|---|
| Chat / Run | Ollama native chat, OpenAI-compat vision (Gemini-flash workaround), CLI runner for OpenClaw / Claude Code |
| Thinking pane | Parses `<think>…</think>` blocks (DeepSeek-R1 / QwQ) + native Anthropic-style `thinking` |
| Images | Multi-image attach + 1-click **desktop screenshot** |
| History | SQLite, searchable, deletable |
| Settings | Persistent — Ollama URL, OpenAI-compat URL/key, model names, CLI paths, policy |
| OpenClaw Upgrades | Manifest install → allowlist → hash → AV scan → install → ledger |
| Self-Upgrade | Same hardened path, scoped to Claw Deck itself |
| Security & Audit | Append-only, **hash-chained tamper-evident** log |
| Command Palette | `Ctrl+K` everywhere |
| Air-gapped mode | One toggle disables all upgrade downloads |

## Gemini-flash through Ollama (OpenAI path)

Gemini-flash variants frequently break tool-calling on the native Anthropic-shaped
endpoint. Forum-recommended workaround: route through the **OpenAI-compatible**
endpoint (`/v1/chat/completions`) and pass images as `image_url` parts with
base64 data URIs. This app does that by default for the **Vision** backend.

Configure in Settings:

```
Ollama base URL            : http://localhost:11434
OpenAI-compatible URL      : http://localhost:11434/v1     (or your LiteLLM proxy)
OpenAI-compatible API key  : ollama                        (any non-empty value)
Vision model               : gemini-flash-3-preview        (or whatever your proxy exposes)
```

If your local Ollama doesn't carry a Gemini-flash tag, point the OpenAI-compat URL
at a LiteLLM / Google OpenAI-compat endpoint and put the real model id there.

## Install & Run

```powershell
cd claw-deck
npm install
npm run dev          # vite + electron in dev
# or
npm run start        # build + run
npm test             # vitest
```

## Security Model

Every upgrade is gated, in order:

1. **Air-gap check** — blocked if enabled.
2. **HTTPS + allowlist** — host must be in `settings.policy.allowlist`.
3. **Download to quarantine** — `userData/quarantine/<ts>-<file>`.
4. **SHA-256 hash compare** vs expected.
5. **Signature** (informational; can be marked required by policy).
6. **AV scan** — Windows Defender (`MpCmdRun.exe`) + ClamAV if available.
7. **Ledger entry + tamper-evident audit append**.
8. **Rollback** available from the Upgrades tab.

## Data Locations

- DB: `%APPDATA%/claw-deck/data/clawdeck.db`
- Quarantine: `%APPDATA%/claw-deck/quarantine/`

## License

MIT
