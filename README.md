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
| Chat | Ollama native chat (streaming), OpenAI-compat vision (Gemini-flash workaround), `Auto` backend that picks chat/vision/reasoning by rules + `/vision` `/reason` `/chat` slash commands. **Agent mode** toggle turns Chat into a plan-and-execute agent (writes a JSON plan → you approve → it runs each step and feeds results back to itself) |
| Console | One tab for OpenClaw / Claude Code **and** shells (PowerShell / cmd / Git Bash / WSL / custom). Shells run in a **real pseudo-terminal** (node-pty + xterm.js — colors, line editing, isatty), with graceful fallback to piped stdio. Per-session streaming, start/stop, cwd picker, arg parser, UAC-elevated launch, MCP status chips. Library tool-installs stream here too |
| Live metrics | Tok/s · TTFT · elapsed shown live in the chat header, persisted into history |
| Thinking pane | Parses `<think>…</think>` blocks (DeepSeek-R1 / QwQ) + native Anthropic-style `thinking` |
| Images | Multi-image attach + 1-click **desktop screenshot** + **region-select** crop |
| Library | One-click Ollama model pulls; a catalog of **real MCP servers** (verified npm `npx` + PyPI `uvx` packages — filesystem, git, fetch, github, playwright, context7, …) with **Install & scan**; a **real OpenClaw plugin** catalog (GitHub-verified — lobster, secureclaw, composio, …) that installs via the real `openclaw plugins install git:…` CLI and can fetch-and-scan source first; and system-tool installers (winget/choco) |
| Skills | OpenClaw **SKILL.md** pipeline: scaffold new skills (real frontmatter), organize/edit/delete what's in your `skills/` folder, and use the real **ClawHub** registry — **structured browse** (`clawhub explore --json`, sortable by trending/downloads/installs + filter), per-skill **install** / **inspect** (file list), semantic **search**, and **publish** |
| History | SQLite, searchable, deletable, **branch** (↳) reuses a prior prompt. Logs **every** run — chat, Agent plans, and Console sessions |
| Security | **Deep folder scan** (eval / child_process / secret reads / obfuscation / exfil heuristics) shared with the upgrade gate + Library audit, plus the hash-chained audit log |
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

Outputs land in `dist-installer/`.

## Code Signing

Signing is **wired into the build**: `package.json` → `build.win.certificateSubjectName`
is `"Claw Deck Dev"`, so electron-builder signs every produced `.exe` (app,
elevate, uninstaller, NSIS installer, portable) with a cert found in the
`CurrentUser\My` store whose subject contains that name.

### Local dev (self-signed test identity)

```powershell
npm run cert:dev   # creates the "Claw Deck Dev" cert, exports certs/*.pfx|cer, trusts it locally
npm run dist       # builds + signs; verify with Get-AuthenticodeSignature
```

`npm run cert:dev` ([scripts/make-dev-cert.ps1](scripts/make-dev-cert.ps1)) generates a
self-signed code-signing cert, writes a portable `certs/clawdeck-dev.pfx`
(password `clawdeck-dev`, gitignored) and trusts it in this machine's
`CurrentUser\Root` + `TrustedPublisher` stores so signatures verify as **Valid**
locally. This is a **test identity only** — other machines don't trust it, so
Windows SmartScreen still warns end users. Run it once per machine/checkout
(the cert lives in the Windows store, not in the repo).

### Shipping for real

Self-signed signatures do **not** remove the SmartScreen warning. For a trusted
build use one of:

- **OV/EV cert on a hardware token / HSM** (DigiCert, Sectigo, …). Since June 2023
  the private key must live on FIPS-140 hardware, so point
  `build.win.certificateSubjectName` at that cert's subject (or use a custom
  `win.sign` hook driving `signtool`), plug in the token, and `npm run dist`.
- **Azure Trusted Signing** — cloud signing, no token; add the Trusted Signing
  dlib/endpoint config.
- **Portable `.pfx`** (CI / another machine) via
  [electron-builder env vars](https://www.electron.build/code-signing) — overrides
  the store lookup:

  ```powershell
  $env:CSC_LINK          = "certs/clawdeck-dev.pfx"  # path or base64 contents
  $env:CSC_KEY_PASSWORD  = "clawdeck-dev"
  npm run dist
  ```

To build **unsigned**, remove `certificateSubjectName` from `build.win` (or build
on a machine without the cert).

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
