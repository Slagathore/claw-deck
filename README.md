<div align="center">

# 🦞 Claw Deck

### A local-first desktop command deck for **OpenClaw** & **Claude Code** — running on your own **Ollama** models, with a hardened, malware-scanned upgrade pipeline.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![React](https://img.shields.io/badge/React-18-61DAFB?logo=react&logoColor=black)
![TypeScript](https://img.shields.io/badge/TypeScript-5.5-3178C6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-355%20passing-4ade80)
![Local-first](https://img.shields.io/badge/local--first-no%20cloud%20inference-8b5cf6)

<img src="docs/media/claw-deck-demo.gif" alt="Claw Deck walkthrough" width="900" />

</div>

---

## What is this?

**Claw Deck** wraps your local **Ollama** stack in a real desktop GUI — then adds the parts most local-LLM front-ends skip: a **multi-agent council**, a queryable **code map**, an **OpenClaw skills** pipeline, and a **security gate** that scans, hashes, and signature-checks anything before it touches your machine.

Everything runs against `localhost`. **No account, no cloud inference, no telemetry** — the only outbound calls are the ones you opt into (GitHub release polling and optional VirusTotal *hash* lookups).

## ✨ Highlights

| | |
|---|---|
| 💬 **Chat** | Streaming Ollama chat with an **`Auto`** backend that routes to chat / vision / reasoning by content — plus `/vision` `/reason` `/chat` overrides. Flip on **Agent mode** and it writes a JSON plan → you approve → it executes each step and feeds results back to itself. |
| 📚 **Library** | One-click installs for **21 popular models**, **20 real MCP servers** (verified `npx`/`uvx` packages), **12 OpenClaw plugins**, and system tools — each **scanned before install**. |
| ⚖️ **Council** | Multi-workspace **agent council**: assign panelists / judge / QA from a roster, run a debate protocol, watch the "theater," and approve or reject the resulting diff in-tab. |
| 🧠 **Project Brain** | **Atlas** — a queryable map of any codebase: symbols, call/reference edges, and active / orphaned / deprecated / superseded status tags. Powers the `code-brain` MCP server. |
| 🧩 **Skills** | Full **OpenClaw `SKILL.md`** pipeline — scaffold, organize, and publish skills, with **semantic search** and install/inspect via the real **ClawHub** registry. |
| 🐚 **Console** | OpenClaw / Claude Code **and** any shell (PowerShell / cmd / Git Bash / WSL) in a **real pseudo-terminal** (node-pty + xterm.js — colors, line editing, `isatty`), with UAC-elevated launch. |
| 🛡️ **Secure upgrades** | Every install runs a gate: **allowlist → quarantine → SHA-256 → Ed25519 signature → AV + YARA → VirusTotal → install with backup → tamper-evident ledger → real rollback**. |
| 📜 **History** | SQLite-backed, searchable log of **every** turn — chat, agent plans, console sessions — with one-click branch (↳) to reuse a prior prompt. |
| 🖼️ **Vision** | Multi-image attach + one-click **desktop screenshot** and **region-crop**, routed through the OpenAI-compatible path for reliable tool-calling. |
| ⌨️ **Command palette** | `Ctrl+K` from anywhere. Plus a live status bar (tok/s · TTFT · VRAM) and an **air-gapped mode** that kills all outbound calls with one toggle. |

## 📸 Screenshots

| Library — models, MCP servers & plugins | Secure upgrade gate |
|---|---|
| <img src="docs/media/library.png" width="440" /> | <img src="docs/media/upgrades.png" width="440" /> |

| Skills — `SKILL.md` + ClawHub | Security — deep scan & tamper-evident log |
|---|---|
| <img src="docs/media/skills.png" width="440" /> | <img src="docs/media/security.png" width="440" /> |

| Settings | Chat |
|---|---|
| <img src="docs/media/settings.png" width="440" /> | <img src="docs/media/chat.png" width="440" /> |

## 🚀 Quickstart

**Prerequisites:** [Ollama](https://ollama.com) running locally, Node.js 20+, and Windows.

```powershell
git clone https://github.com/Slagathore/claw-deck.git
cd claw-deck
npm install
npm run dev      # Vite + Electron in dev (hot reload)
# or
npm start        # build + run
npm test         # vitest — 355 tests
```

First launch runs a 3-step tour that finds your Ollama, confirms a default model, and gets you chatting. Pull a model from the **Library** tab (or `ollama pull llama3.2`) and go.

## 🛡️ Security model

Claw Deck treats **every** update — OpenClaw plugins, MCP servers, its own self-upgrades — as untrusted until proven otherwise. The gate runs in order:

1. **Air-gap check** — hard-blocked when air-gapped mode is on.
2. **HTTPS + allowlist** — host must be in `settings.policy.allowlist`.
3. **Quarantine download** — lands in `userData/quarantine/<ts>-<file>`, never executed.
4. **SHA-256 compare** vs the expected hash.
5. **Ed25519 signature verify** — checked against `policy.signingKeys`; `requireSignature` rejects anything unsigned.
6. **AV scan** — Windows Defender (`MpCmdRun.exe`) + ClamAV when present, plus **YARA** rules.
7. **VirusTotal hash lookup** *(optional)* — queries the file's SHA-256 against VT v3 (no upload); any malicious/suspicious verdict blocks it.
8. **Install with backup** — vetted file copied to its target; any prior file backed up to `<path>.bak-<ts>`.
9. **Tamper-evident ledger** — every decision appended to a **hash-chained** audit log; altering any entry breaks the chain.
10. **Real rollback** — restores the backup (or removes the file) on demand.

The same scan engine powers the standalone **Deep folder scan** (Security tab) — point it at any downloaded extension or npm package before you trust it.

## 🏗️ Architecture

- **Electron 42 + React 18 + TypeScript 5.5 + Vite 8** renderer, strict TS throughout.
- **Node main process** with a fully typed IPC bridge (`contextIsolation`, no `nodeIntegration`) and **`better-sqlite3`** persistence.
- **Atlas** code-intelligence engine (tree-sitter/TS-program parsing → SQLite + vector search via `sqlite-vec`).
- **355 tests** across 42 files (Vitest).

<details>
<summary><strong>🖥️ Headless CLI</strong></summary>

Once installed, `claw-deck` doubles as a CLI (it reads the same settings DB the GUI writes):

```powershell
claw-deck run --task "Summarize this PR" --model llama3
claw-deck run --task "Describe this image" --image ./screenshot.png
claw-deck settings --json
claw-deck help
```
</details>

<details>
<summary><strong>📦 Building installers</strong></summary>

```powershell
npm run dist           # renderer + electron + NSIS installer + portable .exe
npm run dist:portable  # portable only
npm run dist:nsis      # NSIS installer only
```

Outputs land in `dist-installer/`.
</details>

<details>
<summary><strong>🔏 Code signing</strong></summary>

Signing is wired into the build via `build.win.certificateSubjectName` (`"Claw Deck Dev"`), so electron-builder signs every produced `.exe` with a matching cert in the `CurrentUser\My` store.

```powershell
npm run cert:dev   # create + trust a self-signed "Claw Deck Dev" test identity
npm run dist       # build + sign
```

`npm run cert:dev` ([scripts/make-dev-cert.ps1](scripts/make-dev-cert.ps1)) writes a portable, gitignored `certs/clawdeck-dev.pfx` and trusts it locally — a **test identity only**, so SmartScreen still warns end users. For a trusted build, point `certificateSubjectName` at an OV/EV cert on a hardware token, use **Azure Trusted Signing**, or supply a `.pfx` via [electron-builder env vars](https://www.electron.build/code-signing) (`CSC_LINK` / `CSC_KEY_PASSWORD`).
</details>

<details>
<summary><strong>🔄 Auto-update channel</strong></summary>

The **Update Claw Deck** tab polls the GitHub release feeds under *Settings → Upgrade Feeds*, compares the latest release to `app.getVersion()` via semver, auto-picks the right asset for your platform/arch, and runs it through the full security gate before installing.

**Update visibility.** On launch, Claw Deck checks the self-update feed and shows an *"Update available"* banner when a newer release exists. You can silence it two ways — **Later** (snooze until a newer version ships) or **Don't remind me** (mute forever) — both remembered across restarts.

**Emergency updates override silence.** A release can mark itself urgent by putting a marker in its GitHub release notes; Claw Deck then shows a blocking message *regardless* of a user's snooze/mute. The marker is an HTML comment (invisible in GitHub's rendered notes):

```
<!-- clawdeck:emergency: Fixes a critical RCE — please update immediately. -->
```

**Close-window behavior** is configurable under *Settings → UX*: **Minimize to taskbar**, **Hide to system tray** (keep running in the background), or **Quit**.
</details>

<details>
<summary><strong>💡 Gemini-flash through Ollama (OpenAI path)</strong></summary>

Gemini-flash variants frequently break tool-calling on the native Anthropic-shaped endpoint. The forum-recommended workaround — routing through the **OpenAI-compatible** endpoint (`/v1/chat/completions`) and passing images as base64 `image_url` parts — is what Claw Deck does by default for the **Vision** backend.

```
Ollama base URL            : http://localhost:11434
OpenAI-compatible URL      : http://localhost:11434/v1     (or your LiteLLM proxy)
OpenAI-compatible API key  : ollama                        (any non-empty value)
Vision model               : gemini-flash-3-preview        (or whatever your proxy exposes)
```
</details>

## 📂 Data locations

- **DB:** `%APPDATA%/claw-deck/data/clawdeck.db`
- **Quarantine:** `%APPDATA%/claw-deck/quarantine/`

## ❤️ Support

Claw Deck is free and MIT-licensed. If it saved you time, you can fuel more free tools:

<a href="https://ko-fi.com/sparklemuffin"><img src="https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?logo=ko-fi&logoColor=white" alt="Donate on Ko-fi" /></a>

## 📄 License

[MIT](LICENSE) © Slagathore
