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
| Chat / Run | Ollama native chat (streaming), OpenAI-compat vision (Gemini-flash workaround), `Auto` backend that picks chat/vision/reasoning by rules + `/vision` `/reason` `/chat` slash commands |
| CLI Console | Multi-session runners for OpenClaw / Claude Code: per-session stdout/stderr stream, start/stop, cwd picker, shell-style arg parser |
| Live metrics | Tok/s · TTFT · elapsed shown live in the chat header, persisted into history |
| Thinking pane | Parses `<think>…</think>` blocks (DeepSeek-R1 / QwQ) + native Anthropic-style `thinking` |
| Images | Multi-image attach + 1-click **desktop screenshot** + **region-select** crop |
| History | SQLite, searchable, deletable, **branch** (↳) reuses a prior prompt as the new input |
| Reproducibility | Each turn auto-records model, backend, base URL, timestamp into `history.meta.snapshot` |
| Settings | Persistent — Ollama URL, OpenAI-compat URL/key, model names, CLI paths, upgrade policy, signing keys, GitHub PAT, VirusTotal key |
| Release feeds | GitHub Releases poller per `kind` (openclaw / self); release notes shown before install; "Use" button prefills install form |
| OpenClaw / Self-Upgrade | Manifest install → allowlist → quarantine → SHA-256 → **Ed25519 sig verify** → AV scan → **VirusTotal hash lookup** → copy to `installPath` with backup → ledger → **real rollback** |
| Security & Audit | Append-only, **hash-chained tamper-evident** log of every gate decision |
| Command Palette | `Ctrl+K` everywhere |
| Air-gapped mode | One toggle disables all upgrade downloads (incl. feed polling) |

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
5. **Ed25519 signature verify** — when the manifest carries `signature`, it is checked against `policy.signingKeys` (PEM or raw 32-byte hex). `policy.requireSignature` rejects unsigned manifests.
6. **AV scan** — Windows Defender (`MpCmdRun.exe`) + ClamAV if available.
7. **VirusTotal hash lookup** (optional) — when `virusTotalApiKey` is set, the file SHA-256 is queried against VT v3 (no upload); non-zero malicious/suspicious blocks the install.
8. **Install with backup** — when manifest carries `installPath`, the vetted file is copied there and any pre-existing file is backed up to `<path>.bak-<ts>`.
9. **Ledger entry + tamper-evident audit append**.
10. **Real rollback** — restores the backed-up file (or removes the installed file when no backup exists).

## Data Locations

- DB: `%APPDATA%/claw-deck/data/clawdeck.db`
- Quarantine: `%APPDATA%/claw-deck/quarantine/`

## Headless CLI

Once installed, `claw-deck` is available as a CLI for scripting (it reads the
same settings DB the GUI writes):

```powershell
claw-deck run --task "Summarize this PR" --model llama3
claw-deck run --task "Describe this image" --image ./screenshot.png
claw-deck settings --json
claw-deck help
```

## Building Installers (Phase 4)

```powershell
npm run dist           # builds renderer + electron + NSIS installer + portable .exe
npm run dist:portable  # portable only
npm run dist:nsis      # NSIS installer only
```

Outputs land in `dist-installer/`. Configure code-signing via
[electron-builder env vars](https://www.electron.build/code-signing):

```powershell
$env:CSC_LINK          = "C:\path\to\cert.pfx"   # or base64 contents
$env:CSC_KEY_PASSWORD  = "<password>"
npm run dist
```

Without those vars, electron-builder produces unsigned binaries.

## Auto-Update Channel

The **Self-Upgrade** tab includes a "Check for updates" button that:

1. Polls the GitHub release feeds configured under
   *Settings → Upgrade Feeds → Self-upgrade feeds* (default
   `Slagathore/claw-deck`).
2. Compares the latest release version to `app.getVersion()` using semver.
3. Auto-picks the right asset for your platform/architecture (`.exe` on Windows,
   `.dmg` on macOS, `.AppImage` on Linux; arm64/x64 disambiguated).
4. Runs the asset through the full Phase-2 gate (allowlist → hash → Ed25519 →
   AV+YARA → VirusTotal → install with backup → ledger).

The manual install form remains available for one-off upgrades that aren't
published as a GitHub release.

## License

MIT
