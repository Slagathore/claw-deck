<div align="center">

# Claw Deck

A local desktop command deck for OpenClaw and Claude Code that runs on your own Ollama models, with an upgrade pipeline that scans everything for malware before it lands.

[![CI](https://github.com/Slagathore/claw-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/Slagathore/claw-deck/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[Download the latest release](https://github.com/Slagathore/claw-deck/releases/latest)

<img src="docs/media/claw-deck-demo.gif" alt="Claw Deck walkthrough" width="900" />

</div>

---

## What is this?

Claw Deck wraps your local Ollama stack in a real desktop GUI, then adds the parts most local-LLM front-ends skip: an agent council, a queryable code map, an OpenClaw skills pipeline, and a security gate that scans, hashes, and signature-checks anything before it touches your machine.

Everything runs against `localhost`. No account, no cloud inference, no telemetry. The only outbound calls are the ones you opt into: GitHub release polling and optional VirusTotal hash lookups.

## What it does

| | |
|---|---|
| **Chat** | Streaming Ollama chat with an `Auto` backend that routes to chat, vision, or reasoning by content, plus `/vision` `/reason` `/chat` overrides. Turn on Agent mode and it writes a JSON plan, you approve it, then it runs each step and feeds the results back to itself. |
| **Library** | One-click installs for 21 models, 20 real MCP servers (verified `npx`/`uvx` packages), 12 OpenClaw plugins, and system tools. Each one gets scanned before it installs. |
| **Council** | An agent council across workspaces. Assign panelists, judge, and QA from a roster, run a debate protocol, watch the theater, and approve or reject the resulting diff in the tab. |
| **Project Brain** | Atlas, a queryable map of any codebase: symbols, call and reference edges, and active / orphaned / deprecated / superseded status tags. Powers the `code-brain` MCP server. |
| **Skills** | The full OpenClaw `SKILL.md` pipeline. Scaffold, organize, and publish skills, with semantic search and install/inspect through the real ClawHub registry. |
| **Console** | OpenClaw or Claude Code, and any shell (PowerShell, cmd, Git Bash, WSL) in a real pseudo-terminal (node-pty + xterm.js, so colors, line editing, and `isatty` all work), with UAC-elevated launch. |
| **Secure upgrades** | Every install runs a gate: allowlist, quarantine, SHA-256, Ed25519 signature, AV plus YARA, VirusTotal, install with backup, tamper-evident ledger, real rollback. |
| **History** | A SQLite-backed searchable log of every turn (chat, agent plans, console sessions), with one click to branch off a prior prompt and reuse it. |
| **Vision** | Attach multiple images, or grab a desktop screenshot and region crop in one click, routed through the OpenAI-compatible path so tool-calling stays reliable. |
| **Command palette** | `Ctrl+K` from anywhere. Plus a live status bar (tok/s, TTFT, VRAM) and an offline mode that kills every outbound call with one toggle. |

## Screenshots

| Library: models, MCP servers, plugins | Secure upgrade gate |
|---|---|
| <img src="docs/media/library.png" width="440" /> | <img src="docs/media/upgrades.png" width="440" /> |

| Skills: `SKILL.md` and ClawHub | Security: deep scan and tamper-evident log |
|---|---|
| <img src="docs/media/skills.png" width="440" /> | <img src="docs/media/security.png" width="440" /> |

| Settings | Chat |
|---|---|
| <img src="docs/media/settings.png" width="440" /> | <img src="docs/media/chat.png" width="440" /> |

## Install

You need [Ollama](https://ollama.com) running locally first. That is where your models live.

Grab a build from the [latest release](https://github.com/Slagathore/claw-deck/releases/latest):

| Platform | Asset | Notes |
|---|---|---|
| Windows | `Claw.Deck-…-x64.exe` | Installer, Authenticode-signed (publisher: Charles Chambers) |
| Windows (portable) | `Claw.Deck-…-portable-x64.exe` | Single standalone exe, no install needed, also signed |
| macOS | `Claw.Deck-…-mac-arm64.dmg` / `-x64.dmg` | Apple Silicon or Intel. Unsigned, so right-click and Open on first launch |
| Linux | `Claw.Deck-…-linux-x86_64.AppImage` | `chmod +x` and run |

First launch runs a 3-step tour that finds your Ollama, confirms a default model, and gets you chatting. Pull a model from the Library tab (or `ollama pull llama3.2`) and go. In-app updates come through the same security gate as everything else: hash-checked and scanned before install.

## Run from source

You need Node.js 20 or newer. Windows is the primary target, but macOS and Linux build too.

```powershell
git clone https://github.com/Slagathore/claw-deck.git
cd claw-deck
npm install
npm run dev      # Vite + Electron in dev (hot reload)
# or
npm start        # build + run
npm test         # vitest, 367 tests
```

## Security model

Claw Deck treats every update, whether it is an OpenClaw plugin, an MCP server, or its own self-upgrade, as untrusted until proven otherwise. The gate runs in order:

1. Air-gap check: hard-blocked when offline mode is on.
2. HTTPS and allowlist: the host has to be in `settings.policy.allowlist`.
3. Quarantine download: lands in `userData/quarantine/<ts>-<file>`, never executed.
4. SHA-256 compare against the expected hash.
5. Ed25519 signature verify against `policy.signingKeys`. Set `requireSignature` and it rejects anything unsigned.
6. AV scan: Windows Defender (`MpCmdRun.exe`) plus ClamAV when present, plus YARA rules.
7. VirusTotal hash lookup (optional): queries the file's SHA-256 against VT v3 (no upload). Any malicious or suspicious verdict blocks it.
8. Install with backup: the vetted file is copied to its target, and any prior file is backed up to `<path>.bak-<ts>`.
9. Tamper-evident ledger: every decision is appended to a hash-chained audit log, so altering any entry breaks the chain.
10. Real rollback: restores the backup, or removes the file, on demand.

The same scan engine powers the standalone Deep folder scan on the Security tab. Point it at any downloaded extension or npm package before you trust it.

## Architecture

- Electron 42, React 18, TypeScript 5.5, and Vite 8 for the renderer, strict TS throughout.
- A Node main process with a fully typed IPC bridge (`contextIsolation`, no `nodeIntegration`) and `better-sqlite3` for persistence.
- Atlas, the code-intelligence engine (tree-sitter and TS-program parsing into SQLite, with vector search via `sqlite-vec`).
- 367 tests across 42 files (Vitest).

<details>
<summary><strong>Headless CLI</strong></summary>

Once installed, `claw-deck` doubles as a CLI. It reads the same settings DB the GUI writes:

```powershell
claw-deck run --task "Summarize this PR" --model llama3
claw-deck run --task "Describe this image" --image ./screenshot.png
claw-deck settings --json
claw-deck help
```
</details>

<details>
<summary><strong>Building installers</strong></summary>

```powershell
npm run dist           # renderer + electron + NSIS installer + portable .exe
npm run dist:portable  # portable only
npm run dist:nsis      # NSIS installer only
```

Outputs land in `dist-installer/`.
</details>

<details>
<summary><strong>Code signing</strong></summary>

Official Windows releases are Authenticode-signed through Azure Artifact Signing (publisher: Charles Chambers), with RFC-3161 timestamps, so signatures stay valid after a certificate rotates. Verify any downloaded exe:

```powershell
Get-AuthenticodeSignature '.\Claw Deck-*.exe' | Format-List Status, SignerCertificate
# Expect: Status Valid, CN=Charles Chambers
```

Signing is maintainer-only, gated behind `CLAW_SIGN=1` (see [SIGNING.md](SIGNING.md)):

```powershell
npm run dist          # unsigned local build
npm run dist:signed   # Azure-signed build (requires az login + signing role)
```

The hook lives at [scripts/azure-sign.js](scripts/azure-sign.js), wired via `build.win.signtoolOptions.sign`. One thing to know: SmartScreen reputation on a certificate builds with download volume, so early downloads may see a soft "not commonly downloaded" notice, with the publisher shown as verified.
</details>

<details>
<summary><strong>Auto-update channel</strong></summary>

The Update Claw Deck tab polls the GitHub release feeds under Settings, Upgrade Feeds, compares the latest release to `app.getVersion()` via semver, picks the right asset for your platform and arch, and runs it through the full security gate before installing.

Update visibility: on launch, Claw Deck checks the self-update feed and shows an "Update available" banner when a newer release exists. You can silence it two ways, Later (snooze until a newer version ships) or Don't remind me (mute forever), and both stick across restarts.

Emergency updates override silence. A release can mark itself urgent by putting a marker in its GitHub release notes, and Claw Deck then shows a blocking message no matter what a user's snooze or mute says. The marker is an HTML comment, invisible in GitHub's rendered notes:

```
<!-- clawdeck:emergency: Fixes a critical RCE, please update immediately. -->
```

Close-window behavior is configurable under Settings, UX: Minimize to taskbar, Hide to system tray (keep running in the background), or Quit.
</details>

<details>
<summary><strong>Gemini-flash through Ollama (OpenAI path)</strong></summary>

Gemini-flash variants often break tool-calling on the native Anthropic-shaped endpoint. The forum-recommended workaround is to route through the OpenAI-compatible endpoint (`/v1/chat/completions`) and pass images as base64 `image_url` parts, and that is what Claw Deck does by default for the Vision backend.

```
Ollama base URL            : http://localhost:11434
OpenAI-compatible URL      : http://localhost:11434/v1     (or your LiteLLM proxy)
OpenAI-compatible API key  : ollama                        (any non-empty value)
Vision model               : kimi-k2.7-code:cloud          (or whatever your proxy exposes)
```
</details>

## Data locations

- DB: `%APPDATA%/claw-deck/data/clawdeck.db`
- Quarantine: `%APPDATA%/claw-deck/quarantine/`

## Support

Claw Deck is free and MIT-licensed. If it saved you time, you can fuel more free tools:

<a href="https://ko-fi.com/sparklemuffin"><img src="https://img.shields.io/badge/Ko--fi-Buy%20me%20a%20coffee-FF5E5B?logo=ko-fi&logoColor=white" alt="Donate on Ko-fi" /></a>

## License

[MIT](LICENSE) © Slagathore
