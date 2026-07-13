# Security

## Reporting a vulnerability

Open a [private security advisory](https://github.com/Slagathore/claw-deck/security/advisories/new) on this repo, or open a regular GitHub issue if it's not sensitive. I'm one person maintaining this in my spare time, so no SLA, but I'll look at it.

## What Claw Deck is

A local Electron desktop app: chat and vision against your own Ollama, an agent council, a codebase map, an OpenClaw skills pipeline, a real terminal (node-pty), and a self-upgrade pipeline that lets the app patch and test its own source. It's a power tool for one user on their own machine, not a hosted service, and the threat model below reflects that.

## Trust model: this is a single-user desktop app

Claw Deck assumes whoever is running it is the same person who configured it. There's no login, no multi-user separation, and no attempt to defend against another local account or process running as you. If something else on your machine is already malicious and running as your user, it can read the same files Claw Deck can. That's true of basically every desktop app and isn't specific to this one, but it's worth being explicit about.

What that means concretely:

- **Settings, history, and the audit log live in a plaintext SQLite DB** at `%APPDATA%/claw-deck/data/clawdeck.db`. Any API key you paste in (GitHub token, VirusTotal key, a remote LLM key, MCP server env vars) sits there unencrypted. There's no OS-keyring integration. If you don't want a credential on disk in plaintext, don't put it in Settings.
- **The Console tab is a real terminal.** PowerShell, cmd, bash, WSL, with full line editing and an elevate-with-UAC option. This is intentional. It means Claw Deck can do anything you can do from a terminal, because that's the point of the feature.
- **MCP servers you add are local child processes.** Whatever command and env vars you configure for one, it runs with your user's permissions. Vet anything you add the same way you'd vet a random npm package.

## What leaves the machine, and when

By default, nothing but Ollama traffic to `localhost:11434`. Everything else is opt-in:

- **Model calls** go to your local Ollama unless you point a model slot at `*:cloud` (Ollama's own hosted models) or configure a remote OpenAI-compatible endpoint. Check Settings for which models are set to a `:cloud` variant if you care where your prompts go.
- **GitHub release polling** for the Library/Upgrades feeds you configure, and for the self-upgrade update channel.
- **VirusTotal hash lookups** are optional and only run if you set an API key. It's a hash lookup, not a file upload.
- **The self-upgrade probe** spawns a child Electron process to boot-test a patched build and talks to it over a loopback-only HTTP listener (`127.0.0.1`, random port, random per-run token). Not reachable from the network, and it only exists for the duration of one probe run.
- **Air-gapped mode** (Settings) is a real kill switch: it hard-blocks the upgrade-feed and install network calls.

Claw Deck does not run any server that listens on your LAN or a non-loopback address. There's nothing here for a stranger on your network to reach.

## The self-upgrade pipeline: what it actually defends against

The self-upgrade feature reads Claw Deck's own source, proposes a patch (via a local or remote model), and can apply it to the live source tree. Here's the honest version of what guards that:

- **Every run starts with a snapshot** (git commit or full copy) before anything is touched.
- **A patch is applied to the live tree**, then gated: typecheck, the full test suite, and a delta scan comparing security-pattern findings before and after the patch. A high-risk patch (touches `electron/main.ts`, `preload.ts`, the security/self-upgrade code, `package.json`, or introduces something like `eval`/`child_process`/`shell:true`) is cloned to a tempdir and gated there *first*, before the live tree is written at all.
- **Any gate or probe failure auto-rolls back** to the pre-run snapshot.
- **There is no human approval step**, by design. The intent is apply-live-then-verify, not a staging queue nobody reviews. If a patch passes every gate but you don't like the result anyway, use **Revert last upgrade** on the Self-Upgrade tab to restore the pre-run snapshot on demand, whether the run "succeeded" or not.

What it does *not* defend against: a patch that's wrong in a way the existing tests don't catch. Typecheck and tests are the actual bar, and that bar can miss things, same as it can for a human-written commit. The risk scorer flags edits to trust-boundary files so those specifically get sandboxed first, but a subtle bug in an otherwise low-risk file can still pass the gate and land live. That's what the revert button is for.

## The upgrade/install gate (binary installs, OpenClaw plugins, OTA updates)

Every binary install, whether it's an OpenClaw plugin, an MCP server package, or a Claw Deck update, goes through the same gate in `electron/ipc/upgrades.ts`:

1. Host allowlist + HTTPS only.
2. Download to a quarantine directory, never executed in place.
3. SHA-256 check against the expected hash, if one was provided.
4. Ed25519 signature verification. **Signatures are required by default** (`requireSignature: true`). An unsigned manifest is blocked unless you explicitly click through "install unsigned anyway" for that one install, e.g. for your own unsigned test builds. That's a deliberate per-install override, not a setting that silently turns the check off.
5. AV scan: Windows Defender, ClamAV, and YARA, run in parallel. Each engine reports whether it actually ran. If none of them are installed or configured, the result says **unscanned**, not clean. A green "passed" badge means an engine actually looked at the file.
6. VirusTotal hash lookup, optional, only if you set a key.
7. Install with backup, and a real rollback that restores the backed-up file on demand.
8. Every step writes to a hash-chained audit log. The Security tab has a **Verify chain integrity** button that walks the whole chain and recomputes every hash, so tampering with a row (or deleting one) actually gets caught instead of just being theoretically detectable.

## IPC and preload surface

The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. It has zero direct Node or Electron API access. Everything it can do goes through `window.api`, a fixed set of methods exposed by `electron/preload.ts` over `contextBridge`, each backed by an `ipcMain.handle` in `electron/ipc/*.ts`. A compromised renderer (e.g. a bug in how chat or vision content gets rendered) is limited to that surface, not arbitrary Node code. `app:openExternal` is allowlisted to `http(s)://` only, so a compromised renderer can't hand the OS shell a `file://` path or a custom protocol.

## Known limitations

- **No OS-keyring encryption for secrets.** Covered above, listing it again because it's the one people ask about most.
- **macOS builds are unsigned.** You'll need to right-click and Open on first launch. Windows builds are Authenticode-signed; see [SIGNING.md](SIGNING.md).
- **AV scanning is soft by design.** A missing engine doesn't block an install, it shows as unscanned. If you want a real AV pass on every install, install Defender/ClamAV or point Claw Deck at YARA rules.
- **The self-upgrade gate trusts your test suite.** If your tests don't cover something, a patch that breaks it can still pass. This is true of any CI gate anywhere; it isn't special to this app, but it's worth saying plainly.
- **Windows batch launchers (`.cmd`/`.bat`) are spawned through a shell** (`exec.ts`, `runner.ts`, `cliResolve.ts`) because Node itself throws on spawning them directly. Every current caller passes fixed, developer- or user-typed arguments, never scraped or model-generated text, which is what keeps that safe. It's commented at each call site as a guardrail for future changes.
