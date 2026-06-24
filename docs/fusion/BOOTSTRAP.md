# Fusion Council + Atlas — Build Bootstrap for `claw-deck`

> **Hand-off brief for a coding agent (Claude Code / Codex) working inside the `claw-deck` repo.**
> Repo root: `C:\Users\dev\CodeStuff\claw-deck`. Windows / PowerShell host. Node 24, Electron 42.
> Read this whole document once before writing anything. Then execute phase by phase.
> Do **not** skip Phase 0. Do **not** reinvent what already exists (Section 1).
>
> **Decisions are LOCKED (Section 8).** Where this doc says "locked", do not re-litigate — build it that way.

---

## 0. Mission & non-negotiables

### What we are building
Three subsystems on top of the existing claw-deck Electron app, turning it into a **multi-workspace,
multi-agent software council** that can **discuss, audit, and fix** code in selected project folders:

1. **Atlas** — a complete, queryable map of a target codebase (symbol graph + embeddings + summaries +
   staleness tags). Built *before* any work happens. Both Cole (visual) and the agents (MCP tools) read it.
   **One Atlas per workspace** (locked: multiple workspaces open at once, as tabs).
2. **Proposal + Worktree Executor** — every code change is staged in an isolated git worktree and must emit
   **two artifacts before merge**: a `CHANGE_PLAN.md` (intent/approach per file) and a full `changes.diff`.
   Nothing touches the live working tree without review + approval.
3. **Council Orchestrator** — a cheap **Ollama-cloud advisor swarm** debates to consensus, feeding an
   **actor pipeline** (Codex = QA gate, Claude Code = judge/executor) that gates and applies the change.
   Agents are assigned **per workspace tab** from a global roster (Section 4.5).

### Prime directives (priority order)
1. **Complete project understanding.** An agent must never be unaware of an existing feature, and must never
   confuse an old/orphaned code path for a current one. The Atlas exists to make that structurally hard.
2. **Two artifacts before any write.** `CHANGE_PLAN.md` + `changes.diff`, always, for every change set.
3. **Isolation before trust.** All edits happen in a git worktree; the live tree is only updated on approval.
4. **Reuse over reinvention.** Build on the modules in Section 1. Breaking existing tabs/IPC is a failure.
5. **Burn Ollama credits, spare premium tokens.** Push high-volume work (debate, embeddings, summaries) onto
   the Ollama swarm. Touch Claude Code / Codex as few times as possible.

### Rules of engagement (agent operating contract)
- Branch per phase: `fusion/phase-<N>-<slug>`. One phase = one reviewable PR-sized change.
- TypeScript **strict** in both processes. `npm run lint` (two `tsc --noEmit`) must pass before "done".
- `npm test` (vitest) green before declaring a phase complete. Add tests for all new logic.
- Never change an existing IPC contract without updating **all three**: `electron/ipc/*` handler,
  `electron/preload.ts`, and `src/types.d.ts` — plus every caller. New IPC is a **superset**, never a mutation.
- No new heavy deps beyond those pre-approved per phase. Anything else → stop, list it for Cole.
- Until Phase 2 exists, **you (the agent) still follow directive #2 manually**: post a plan + a diff before
  applying each change set.
- Windows-first: see Section 6 every time you spawn a process or touch a path.

### Reality check — existing CLIs on this machine (verified)
- `clawhub@0.23.0`, `openclaw@2026.5.28` are **installed globally** and on PATH. `clawhub` is Cole's own
  package; its version flag is `--cli-version` (not `--version`). A stale probe in `SkillsTab.tsx` that ran
  `clawhub --version` has been corrected to `--cli-version` — do not reintroduce `--version` as a liveness probe.
- **`codex` as a spawnable CLI is unconfirmed.** The VS Code "CODEX" panel is an extension, not necessarily a
  PATH binary. **Phase 0 must verify** a real `codex` executable exists (`where.exe codex`); if not, treat the
  Codex role as "via apply-mode diff" or substitute another actor until a CLI is available.
- OpenClaw is **kept only as the budget/fallback executor** (locked), never as a routing layer.

---

## 1. Repo facts you must know (read from the live source — do not guess)

**Stack:** Electron `^42`, React `^18`, Vite `^8`, TypeScript `^5.5` strict. Renderer built by Vite, main by
`tsc -p electron/tsconfig.json`. Entry `dist-electron/main.js`. Dev: `npm run dev` (Vite :5173 + Electron).

**IPC pattern.** Handlers in `electron/ipc/*.ts` as `ipcMain.handle('ns:action', ...)`, exposed to the
renderer via `electron/preload.ts` `contextBridge` as `window.api.*` (no nodeIntegration / no remote), typed in
`src/types.d.ts`. Register new handler modules from `electron/main.ts`. Follow this exactly.

**Database.** `electron/ipc/db.ts` → `getDb()` (better-sqlite3, WAL, schema auto-migrates on launch). Settings
are key→JSON-string rows in a `settings` table (`mcp.ts:loadSettings()` shows the read pattern). NOTE: this DB
lives in Electron `userData` and is for app/global state. **Per-workspace Atlas data lives in its own DB inside
the target repo** (see Phase 1) — do not put Atlas tables in the userData DB.

**Subprocess runner — `electron/ipc/runner.ts` (how actors are spawned).**
- `runner:start { backend:'openclaw'|'claude'|'shell', binary, args?, cwd?, env?, pty?, cols?, rows? }`
  → `{ id, pty }`. Streams `runner:event { id, kind:'stdout'|'stderr'|'exit'|'error', data, ts }`.
- Already handles **Windows bare-name resolution** (shell for names without a path separator) and **injects
  `getActiveMcpEnv()`** into every child. `runner:input|stop|resize` exist; `node-pty` with pipe fallback.
- **Add `'codex'` to the backend union** when wiring the QA actor (and a captured/one-shot run helper).

**MCP host — `electron/ipc/mcp.ts`.** Servers in `settings.mcpServers` (`{name,command,args?,env?,cwd?,enabled?}`);
`mcp:list|start|stop|startAll|stopAll`; `getActiveMcpEnv()` exports `MCP_SERVERS_JSON` to child CLIs.
**Register the per-workspace `code-brain` server as a `settings.mcpServers` entry** — claw-deck spawns/tracks/
injects it automatically. (The server takes a `--db` arg pointing at that workspace's Atlas; see Phase 1.)

**Planner reuse — `src/lib/planner.ts`.** Reuse for proposals: `extractPlanJson`, `repairJsonish`, `parsePlan`,
`isDestructive`, `describeStep`, `PLANNER_SYSTEM_PROMPT`. (Robust messy-LLM-JSON handling — do not rewrite it.)

**Edit-safety reuse — `electron/selfUpgrade/`.** `sandbox.ts` → `runInSandbox({ sourceRoot, timeoutMs })`
(clones source, junctions node_modules, runs `npm test`, returns `SandboxResult`); plus `snapshot.ts`,
`patcher.ts`, `risk.ts`, `gate.ts`, `exec.ts` (`run(cmd,args,{cwd,timeoutMs})`).

**Model I/O — `electron/ipc/ollama.ts` + OpenAI-compat path.** Streaming reader handles Ollama NDJSON **and**
OpenAI SSE. Local OpenAI-compat `http://localhost:11434/v1`. **Ollama Cloud** is OpenAI-compatible at
`https://ollama.com/v1` with an API key; cloud tags use the `*:cloud` suffix.

**Routing — `src/lib/router.ts`.** `routeRequest()` is a *single-call* resolver. The Council fan-out is a **new
layer above it**, not a change to it.

**UI.** Tabs registered in `src/App.tsx`. Existing tabs: `Chat, Console, History, Library, PromptVault,
Security, SelfUpgrade, Settings, Skills, Upgrades`. Stores: `src/store/ui.ts`, `src/store/console.ts`
(zustand). Reusable view bits: `components/TerminalView.tsx`, `src/lib/thinking.ts` (`<think>` parsing),
`components/{RiskBadge,SlashMenu,CommandPalette}.tsx`.

---

## 2. Architecture & glossary

```
 VS Code (+ claw-bridge ext) ──localhost JSON──┐   (Phase 6, optional but high-value)
   diagnostics · lm models · selection · MCP cfg│
                                                ▼
 Ollama Cloud  ◀─ advisors ─  CLAW-DECK ORCHESTRATOR  ─ actors ─▶  Claude Code / Codex / OpenClaw
 (cheap swarm)                 ├ Workspace tabs (N open at once)   (premium + budget executors, via runner.ts)
                               ├ Atlas per workspace (graph/MCP)
                               ├ Protocol engine (phase graph)
                               ├ Proposal + worktree executor
                               ├ Autonomous goal loop
                               └ Run log (sqlite) + audit (hash-chain)
                                                │
                                  each workspace = a target repo: filesystem + git (full, direct)
```

**Glossary** — *Atlas* (code map), *Cartographer* (the role that builds/maintains it), *Advisor* (text-only
Ollama model), *Actor* (agentic edit-capable CLI), *Judge* (final authority, default Claude Code), *QA gate*
(pre-judge, default Codex), *Protocol* (ordered phase graph), *Phase primitive*
(`independent|debate|synthesize|gate|relay|vote|propose|execute`), *Proposal* (`CHANGE_PLAN.md` + `changes.diff`),
*Workspace* (one open target folder = one tab, with its own Atlas + session), *Roster* (global pool of agents
you assign from), *claw-bridge* (thin VS Code extension publishing editor-only signals).

---

## 3. Phase plan  (build order: **Atlas → Executor → Orchestrator → UI → Loop → Bridge**)

### Phase 0 — Recon (no production code)
Read the Section-1 files; confirm or flag drift in `docs/fusion/RECON.md`. **Also verify:** `where.exe codex`
(does a spawnable CLI exist?), the exact `window.api.*` surface, current `settings` keys, and that `git` is on
PATH. **Acceptance:** RECON.md exists; no code changed; drift + the codex-CLI finding listed for Cole.

### Phase 1 — Atlas (the code-comprehension layer) ← start here, dogfood on claw-deck itself
**Goal:** for a target folder, build a complete, incrementally-updatable map: every symbol, every edge, a card
per symbol, embeddings for semantic search, and a status tag (active/orphaned/deprecated/superseded). Expose to
Cole (a tab) and to agents (an MCP server). **One Atlas DB per workspace**, stored at `<workspace>/.fusion/atlas.db`.

**Locked deps:** `cytoscape` (graph viz, renderer), `web-tree-sitter` + grammar WASM (ts/tsx/python/bash/
gdscript), `sqlite-vec` (vectors in better-sqlite3). Embeddings: **`nomic-embed-text` via Ollama, 768-dim**
(the `vec0` column is `FLOAT[768]`). Use the **TypeScript compiler API** (`typescript`, already a dep) for
resolved refs on `.ts/.tsx`. `chokidar` for the watcher (or `fs.watch` — note the choice).
> ⚠️ **sqlite-vec load risk (verify before committing the `vec0` schema):** `sqlite-vec` loads as a *runtime
> extension* into the Electron-rebuilt `better-sqlite3@^12` binary via `db.loadExtension(sqliteVec.getLoadablePath())`.
> Confirm that actually loads on this Windows/Electron build first. If it doesn't, fall back to a plain
> `atlas_embeddings(symbol_id, vec BLOB)` table (float32 blobs) + JS cosine behind the same `find_similar` query
> interface — keep the query API identical so callers don't care which backend won.
> **Phase-1-as-shipped note:** the structural index (files/symbols/edges via the TS compiler API), reachability
> staleness, queries, MCP server, and graph UI need **neither** Ollama **nor** tree-sitter WASM. Build that core
> first and dogfood it; embeddings/summaries (Ollama) and polyglot tree-sitter grammars are an additive second pass.

**New files**
```
electron/ipc/atlas.ts                 # IPC: atlas:open(workspace), atlas:index, atlas:status, atlas:query, atlas:graph, atlas:card, atlas:close
electron/atlas/db.ts                  # opens/migrates <workspace>/.fusion/atlas.db; one handle per workspace (Map)
electron/atlas/schema.ts              # SQLite DDL + migration for atlas_* tables (Section 4.1)
electron/atlas/parse/treeSitter.ts    # polyglot structural parse → symbols + raw edges
electron/atlas/parse/tsProgram.ts     # TS compiler API → resolved call/import/reference edges
electron/atlas/index.ts               # full + incremental index pass (the Cartographer)
electron/atlas/summarize.ts           # nomic? no — cheap CHAT model writes per-symbol cards (batched, background)
electron/atlas/embed.ts               # nomic-embed-text embeddings → sqlite-vec (batched, background, resumable)
electron/atlas/staleness.ts           # reachability + duplicate-cluster + git-recency → status tags
electron/atlas/query.ts               # locate/find_symbol/who_calls/calls_what/get_card/find_similar/is_current
electron/atlas/watch.ts               # FS watcher → incremental re-index of changed files
mcp/code-brain/server.ts             # stdio MCP server (--db <path>) exposing query.ts as tools (Section 4.4)
src/tabs/ProjectBrainTab.tsx          # cytoscape graph + symbol cards + status filters (per active workspace)
src/lib/atlasClient.ts                # renderer typed wrappers over window.api.atlas.*
```
**Modified:** `electron/main.ts` (register atlas handlers), `preload.ts` + `src/types.d.ts`
(`window.api.atlas.*`), `src/App.tsx` (Project Brain tab, scoped to active workspace),
`electron/ipc/settings.ts` (append a `code-brain` `mcpServers` entry per opened workspace, with `--db` arg).

**Implementation notes**
- Full index = structure first (instant): populate `atlas_files`, `atlas_symbols`, `atlas_edges`. Background
  passes fill `summary` (summarize.ts) + `embedding` (embed.ts) — the Ollama-credit sinks; batch + resumable.
- `tsProgram.ts` = resolved edges for TS; `treeSitter.ts` = structural for the rest. Tag each edge
  `resolved 0|1`.
- **Status tags (old-vs-new guarantee):** reachability BFS from entrypoints (`package.json#main`/`bin`, tab
  roots, exported handlers) → unreachable internal symbol = `orphaned`. Embedding cosine clusters where one
  sibling has refs and another has zero → zero-ref one = `superseded` (+`superseded_by`). `@deprecated` →
  `deprecated`. Else `active`. Store `ref_count` + `git_last_date` so cards show the evidence.
- Incremental: on change re-parse only that file, diff its symbols, update touching edges, mark clusters dirty,
  re-summarize/re-embed changed symbols only.

**Acceptance:** `atlas:index` on claw-deck completes; `atlas:status` reports counts; ProjectBrainTab renders a
navigable cytoscape graph with working active/orphaned/deprecated filters + a card panel; the per-workspace
`code-brain` MCP server starts and answers all Section-4.4 tools; `locate("screenshot region cropping")`
returns the right symbol in `screenshot.ts`/`RegionSelect.tsx`; `is_current` on a seeded orphan returns
`orphaned`. **Tests (`tests/atlas.*`):** parser extracts known symbols; a known caller→callee edge resolves;
an unreferenced duplicate flags `superseded`; queries return expected rows; migration is idempotent.

### Phase 2 — Proposal + Worktree executor
**Goal:** make "isolation before trust" + "two artifacts before write" structural.
**New:** `electron/ipc/executor.ts` (`exec:beginRun|proposal|validate|approve|reject`),
`electron/executor/worktree.ts`, `electron/executor/applyDiff.ts`, `electron/executor/validate.ts`
(wraps `runInSandbox`), `src/components/DiffReview.tsx` (renders CHANGE_PLAN.md + changes.diff, Approve/Reject).
**Modified:** `runner.ts` (add `'codex'`; add a captured one-shot run helper), preload+types for `window.api.exec.*`.
**Worktree lifecycle:** `git -C <repo> worktree add .fusion/wt/<runId> -b fusion/run-<runId>`; actors run with
`cwd=<wt>` (delegate) or `applyDiff.ts` writes a diff there (apply); `git -C <wt> add -A && diff --cached` →
`changes.diff`; author writes `CHANGE_PLAN.md` into the wt; validate via `runInSandbox({sourceRoot:<wt>})`;
**approve** → apply onto live tree + `appendAudit('exec:approved', …)` + persist; **reject** → `git worktree remove --force`.
**Audit reuse note:** the append-only sha256 hash-chain ledger is `appendAudit(kind, payload)` exported from
`electron/ipc/security.ts` (already used by `upgrades.ts`) — reuse it. `electron/ipc/audit.ts` is an unrelated
security *scanner* IPC, **not** an append target; do not write the ledger there.
**Executor modes + fallback chain:** (1) **delegate** CLI edits in wt; (2) **apply** any model's diff via
`applyDiff`; (3) **fallback** — on a designated actor's quota/auth error (401/403/429 or "out of credits/rate
limit" stderr) drop to the next actor, final fallback = apply-mode using the best available `*-coder:cloud`.
**Acceptance:** a scripted edit runs end-to-end in delegate AND apply mode, emits both artifacts, validates,
merges only on approval; reject leaves `git status` clean. **Tests:** diff round-trip; reject cleanup; 429 fallback.

### Phase 3 — Council orchestrator (engine, no UI)
**New:** `electron/council/agents.ts` (registry + resolution), `electron/council/transport.ts`
(`call(agent,messages)` → ollama-cloud / runner-capture / vscode-lm), `electron/council/protocol.ts` (phase
primitives + presets, Section 4.3), `electron/council/run.ts` (state machine, emits events, writes run log),
`electron/ipc/council.ts` (`council:start|event|cancel|approveGate`). **Modified:** preload+types; a
`council_runs` table.
**Notes:** advisors run in **parallel** (`Promise.allSettled`; degrade to k-of-n). A **scribe** condenses each
phase before passing downstream (no raw transcript dumps into Codex/Claude). `debate` stops at `rounds` cap OR a
cheap checker votes "converged" (default cap 3). Gates return `{verdict:'approve'|'minor'|'major'|'veto', notes,
patch?}`; `minor`→apply+forward, `major`/`veto`→bounce with notes injected. Every phase emits a `council:event`.
**Acceptance:** the **Pair** protocol drives Codex⇄Claude through the executor and lands an approved diff.
**Tests:** phases run in order; a stubbed `major` bounces; one failed advisor tolerated; early convergence stops.

### Phase 4 — Council tab (debate theater) + Settings  (multi-workspace + roster dropdowns)
**New:** `src/tabs/CouncilTab.tsx`, `src/components/WorkspaceTabs.tsx` (the open-folders tab strip),
`src/components/CouncilSettings.tsx`, `src/components/DebateTheater.tsx`, `src/store/workspaces.ts`,
`src/store/council.ts`. **Modified:** `src/App.tsx`, `SettingsTab.tsx` (the global **Agent Roster** editor +
Ollama-cloud key).
- **Workspaces:** a tab strip; "Open folder" → new workspace tab → kicks Atlas index → its own session state.
  Multiple open at once (locked). Each tab owns: target path, Atlas handle, `code-brain` server, session config.
- **Agent Roster (global, in Settings):** the pool of available agents (Section 4.5) — add/edit entries
  (transport, model/binary, cost tier).
- **Per-tab session config (CouncilSettings):** **dropdowns populated from the roster** for each position —
  panelists (multi-select), judge, QA gate, scribe — plus protocol, mode, visibility, edit policy, caps. Locks
  on "Start session". Includes a **"full council first-pass"** toggle (default off; warns it multiplies premium spend).
- **Theater:** lanes per agent, phase headers, inline proposals/diffs, live token/cost line; reuse `thinking.ts`
  + `TerminalView`. "summary" = one scribe line/phase; "silent" = final diff only. **UI copy must note hiding the
  stream does not speed the run.**
**Acceptance:** Cole can open 2+ workspaces, assign agents per tab from the roster, run a session, watch the
debate, and approve/reject the diff in-tab.

### Phase 5 — Autonomous goal loop
**New:** `electron/council/autoloop.ts`. **Modified:** `run.ts`, `CouncilTab`. Loop: branch → run protocol →
execute approved change → **commit checkpoint per iteration** → a goal-checker agent (prompted to fail by
default, pass only on evidence) decides met/not-met → derive next sub-task on not-met. **Rails:** max-iterations,
cost ceiling, **oscillation detector** (same change proposed↔reverted twice → stop + surface), optional human
checkpoint every N. **Acceptance:** a small goal converges, checkpoints each iteration, halts cleanly on
success/cap/oscillation. **Tests:** halts on cap; oscillation trips on a stubbed flip-flop.

### Phase 6 — `claw-bridge` VS Code extension (optional, high-value)
A minimal extension (own `package.json`) running a localhost server exposing: workspace folders, open files +
selection, **diagnostics** (Problems), symbols on request, `vscode.lm.selectChatModels()` + an invoke proxy,
and the configured MCP servers (`.vscode/mcp.json` + user settings). claw-deck connects when present and
degrades to filesystem+git when absent. **Acceptance:** with VS Code open, Atlas/Council read live diagnostics
and list `vscode.lm` models; with it closed, everything still runs minus those signals.

---

## 4. Consolidated data models

### 4.1 Atlas SQLite schema (`electron/atlas/schema.ts`) — one DB per workspace at `<workspace>/.fusion/atlas.db`
```sql
CREATE TABLE IF NOT EXISTS atlas_files (
  id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, lang TEXT NOT NULL,
  hash TEXT NOT NULL, mtime INTEGER NOT NULL, git_last_date INTEGER
);
CREATE TABLE IF NOT EXISTS atlas_symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES atlas_files(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,            -- function|method|class|interface|type|const|module|component
  name TEXT NOT NULL, qualified_name TEXT NOT NULL, signature TEXT,
  start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  doc TEXT, summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',          -- active|orphaned|deprecated|superseded
  superseded_by INTEGER REFERENCES atlas_symbols(id),
  ref_count INTEGER NOT NULL DEFAULT 0, last_seen_run INTEGER
);
CREATE TABLE IF NOT EXISTS atlas_edges (
  id INTEGER PRIMARY KEY,
  src INTEGER NOT NULL REFERENCES atlas_symbols(id) ON DELETE CASCADE,
  dst INTEGER NOT NULL REFERENCES atlas_symbols(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,           -- calls|imports|references|extends|implements
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS atlas_runs (
  id INTEGER PRIMARY KEY, started INTEGER, finished INTEGER,
  files_indexed INTEGER, symbols INTEGER, mode TEXT
);
-- vectors (nomic-embed-text = 768 dims):
-- CREATE VIRTUAL TABLE atlas_vec USING vec0(symbol_id INTEGER PRIMARY KEY, embedding FLOAT[768]);
CREATE INDEX IF NOT EXISTS idx_sym_file ON atlas_symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_edge_src ON atlas_edges(src);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON atlas_edges(dst);
```

### 4.2 Council types (`electron/council/agents.ts`)
```ts
export type Transport =
  | 'ollama-cloud' | 'ollama-local' | 'openai-compat'   // advisors (text)
  | 'claude-code'  | 'codex'        | 'openclaw'         // actors (agentic CLIs)
  | 'vscode-lm';                                          // via claw-bridge
export type Role = 'panelist' | 'critic' | 'scribe' | 'qa-gate' | 'judge' | 'executor';
export type CostTier = 'cheap' | 'mid' | 'expensive';

export interface RosterAgent {                 // a global, reusable definition (Settings → Roster)
  id: string; displayName: string;
  transport: Transport; model?: string; binary?: string;
  capabilities: { canEdit: boolean; canRunTools: boolean; costTier: CostTier };
}
export interface SessionAssignment {           // per workspace tab; references roster ids
  panelists: string[]; judge: string; qaGate: string; scribe?: string;
}
export interface GateVerdict { verdict: 'approve'|'minor'|'major'|'veto'; notes: string; patch?: string; }
```

### 4.3 Protocols & phase primitives (`electron/council/protocol.ts`)
```ts
export type PhaseKind = 'independent'|'debate'|'synthesize'|'gate'|'relay'|'vote'|'propose'|'execute';
export interface Phase {
  kind: PhaseKind; agents?: string[]; rounds?: number; stopOn?: 'cap'|'converge';
  by?: string; onMinor?: 'apply-forward'; onMajor?: 'bounce'; maxTurns?: number;
  method?: 'majority'|'judge-pick'; editPolicy?: 'dry-run'|'review-each'|'auto-checkpoint';
}
export interface Protocol { id: string; name: string; phases: Phase[]; }
// Ship all five: COUNCIL, PCRSR (Propose→Critique→Revise→Synthesize→Ratify),
// GCRJ (Generate→Cross-critique→Rebuttal→Judge), REDTEAM, PAIR.
// COUNCIL = independent(@panelists) → debate(@panelists,3,converge) → synthesize(@scribe)
//           → gate(@qa-gate,minor:apply,major:bounce) → relay(@qa-gate,@judge,4)
//           → gate(@judge,...) → execute(@judge,review-each)
// PAIR    = relay(@qa-gate,@judge,4) → execute(@judge,review-each)   (quick fix; skips the swarm)
```
Role refs (`@panelists`, `@judge`, `@qa-gate`, `@scribe`) resolve at runtime from the tab's `SessionAssignment`.

### 4.4 `code-brain` MCP tools (`mcp/code-brain/server.ts`, started with `--db <workspace>/.fusion/atlas.db`)
`locate(description)` · `find_symbol(name)` · `who_calls(symbol)` · `calls_what(symbol)` ·
`get_card(symbol)` (→ signature, summary, location, status, ref_count, git_last_date, callers, callees) ·
`find_similar(symbol)` · `is_current(symbol)` (→ status + superseded_by). All return `file:line`. The
orchestrator also auto-injects the target symbol's card + 1-hop neighbors into each advisor's prompt.

### 4.5 Agent Roster (Settings, global) → per-tab dropdowns
- The **Roster** is a `settings.fusionRoster: RosterAgent[]` list edited in Settings. Seed it with: the chosen
  Ollama `*:cloud` panelists, `claude-code` (binary `claude`), `codex` (if a CLI exists — else omit), `openclaw`
  (fallback executor). Each workspace tab's CouncilSettings renders **dropdowns from this roster** to fill a
  `SessionAssignment`. Changing the roster updates every tab's available options; assignments are per tab.

---

## 5. Config & secrets
- **Ollama Cloud:** base `https://ollama.com/v1` (OpenAI-compatible), key from Settings/env `OLLAMA_API_KEY`;
  cloud tags `*:cloud`. Reuse the existing OpenAI-compat client. **Embeddings:** `nomic-embed-text` (768-dim).
- **Binary paths (Settings):** `claudeCodePath` (default `claude`), `codexPath` (add; verify a CLI exists),
  `openclawPath` (default `openclaw`). Bare names now resolve via the runner's shell fallback; absolute is safest.
- Never log API keys. Key-bearing calls go through the main process, never the renderer.

## 6. Windows gotchas
- Spawn with absolute binary paths where possible; the runner shells bare names. Use `path.join`, never hardcode
  slashes. `node-pty` is ABI-bound to Electron (already `asarUnpack`-ed); pipe fallback covers load failure.
- Git worktrees under `.fusion/wt/<id>`; add `.fusion/` to `.gitignore` (also where each Atlas DB lives).
  **Also exclude `.fusion/` from packaging:** `scripts/stage-source.mjs` (the `stage:source` step) and the
  electron-builder `files` / `extraResources` globs must not sweep worktrees or Atlas DBs into `staging-source`
  or the asar. When dogfooding on claw-deck itself, `.fusion/` lives inside the repo being packaged — verify a
  `dist` run does not bundle it.
  Junction symlinks may need permissions — mirror `sandbox.ts`'s `npm ci` fallback.
- Long command lines / big diffs: pass via temp files, not giant argv (previously hit).
- **CLI version probes:** never assume `--version`. Some CLIs (e.g. clawhub → `--cli-version`) remap it; probe
  with `--help` or the tool's actual flag, and treat exit 0 OR non-empty output as "present".

## 7. Definition of done (every phase)
- [ ] `npm run lint` clean (both tsconfigs). · [ ] `npm test` green; new logic tested.
- [ ] No existing tab/IPC/contract broken (superset, not mutation). · [ ] New IPC mirrored across handler +
  preload + `types.d.ts`. · [ ] `CHANGE_PLAN.md` + `changes.diff` produced and reviewed before merge.
- [ ] Acceptance criteria demonstrably met (state how verified).

## 8. Locked decisions (resolved with Cole)
1. **Graph viz:** `cytoscape`. **Locked.**
2. **Embeddings:** `nomic-embed-text` via Ollama, **768-dim** (`vec0 FLOAT[768]`). **Locked.**
3. **Workspaces:** **multiple open at once, as tabs.** One Atlas DB + one `code-brain` server + one session per
   tab. **Locked.**
4. **Agent selection:** a **global Roster in Settings**; each workspace tab assigns positions via **dropdowns**
   populated from the roster (panelists multi-select; judge / QA / scribe single-select). **Locked.**
5. **OpenClaw:** **keep as the budget/fallback executor only**, never the routing layer. **Locked.**
6. **clawhub/openclaw are real + installed.** clawhub probe bug fixed (`--cli-version`). **Verify `codex` CLI**
   in Phase 0; if absent, run the Codex role via apply-mode diff or substitute until a CLI exists.

### Still genuinely open (ask Cole if it blocks you)
- Default panelist roster: which 3–4 `*:cloud` models. (Pick sensible coder-leaning defaults; let Cole edit.)
- `claw-bridge` now or later (Phase 6 optional; Atlas runs on filesystem+git without it).

---

## 9. Build progress log (agent-maintained)
> Running record of what's been built/touched, per phase. Newest at top. Keep honest — note partials.

### 2026-06-24 — Phase 3 (Council Orchestrator engine) SHIPPED — branch `fusion/phase-1-atlas`
Engine + tests complete (222/222 green, lint clean). No UI yet (Phase 4).
- `electron/council/agents.ts`: Transport/Role/CostTier/RosterAgent/SessionAssignment/GateVerdict types +
  role-ref resolution (`@panelists`/`@judge`/`@qa-gate`/`@scribe`, scribe→judge fallback) + `validateAssignment`.
- `electron/council/protocol.ts`: all five protocols (COUNCIL, PCRSR, GCRJ, REDTEAM, PAIR) + `parseGateVerdict`
  (safe-default major), `isConverged`, `extractDiff`.
- `electron/council/run.ts`: the state machine — `runProtocol` over the phase graph with an **injected**
  TransportFn + ExecutorHooks (so it's fully unit-tested with stubs). independent/debate(converge)/synthesize/
  gate(bounce on major·veto)/relay/vote/propose/execute; advisors parallel + k-of-n tolerant; emits a
  `CouncilEvent` stream.
- `electron/council/transport.ts`: real transport — OpenAI-compat HTTP for ollama-cloud/local/openai-compat;
  `runCaptured` one-shots for claude-code/codex/openclaw; vscode-lm throws (Phase 6).
- `electron/ipc/council.ts`: `council:start|cancel|list`; runs in background, streams `council:event`, persists
  `council_runs` (new table in db.ts). Execute phase drives a real worktree run (createWorktree→applyDiff→
  capture→validate→approve onto live tree) with `appendAudit` at each step.
- `settings`: `codexPath`, `ollamaCloudUrl`, `ollamaCloudKey` (falls back to `OLLAMA_API_KEY` env).
- Tests: `council.run.test.ts` (5: phase order, major→bounce, advisor tolerance, convergence stop, PAIR→execute
  lands an approved diff) + `council.agents.test.ts` (5). The §3 Phase-3 acceptance.
- *Deferred:* interactive `council:approveGate` (gates auto-parse now; every verdict is streamed). Actor CLI
  invocation flags (claude `--print` / codex `exec` / openclaw `run`) are best-effort one-shots — verify against
  the real CLIs. The isQuotaError→nextActor fallback chain exists + is tested but isn't yet wired as automatic
  mid-run actor swapping (a transport-wrapper refinement).


### 2026-06-24 — Phase 2 (Worktree Executor) SHIPPED — branch `fusion/phase-1-atlas`
Engine + tests complete (211/211 green, lint clean). "Isolation before trust" + "two artifacts before write"
are now structural.
- `electron/ipc/runner.ts`: `'codex'` added to the backend union; `runCaptured()` one-shot helper (MCP env +
  Windows bare-name shell, captured stdout/stderr) for driving apply-mode actors.
- `electron/executor/`: `git.ts` (reuses `selfUpgrade/exec.run`), `worktree.ts` (create/capture/writeArtifacts/
  applyToLiveTree/remove), `applyDiff.ts` (apply-mode), `validate.ts` (wraps `runInSandbox`), `fallback.ts`
  (`isQuotaError` 401/403/429 + credit/quota/rate-limit; `nextActor`).
- `electron/ipc/executor.ts`: `exec:beginRun|proposal|validate|approve|reject`. Worktree at `.fusion/wt/<runId>`,
  branch `fusion/run-<runId>`; artifacts (CHANGE_PLAN.md + changes.diff) persist under `.fusion/runs/<runId>/`
  (kept out of the wt so they don't pollute the captured diff). **Approve writes to `appendAudit` (the real
  hash-chain in security.ts)** — the corrected ledger ref. Registered in `main.ts`; `window.api.exec.*` in
  preload + types.
- `src/components/DiffReview.tsx`: renders both artifacts (diff color-coded) + Validate → Approve/Reject.
- Tests: `executor.fallback.test.ts` (4) + `executor.worktree.test.ts` (2, real-git temp-repo round-trip:
  create→edit→capture→approve onto live tree; reject leaves `git status` clean). Diff round-trip ✅, reject
  cleanup ✅, 429 detection ✅ — the §3 Phase-2 acceptance tests.
- *Deferred:* the full delegate/apply actor-driving + fallback *orchestration* (chaining real CLIs with
  `runCaptured` on quota errors) lands with Phase 3's council/transport; the executor primitives + DiffReview UI
  are ready for it. DiffReview isn't mounted in a tab yet — Phase 4 wires it into the Council tab.


### 2026-06-24 — Phase 0 ✅ + Phase 1 (in progress) — branch `fusion/phase-1-atlas`
**Phase 0 (done):** Recon complete → `docs/fusion/RECON.md`. Verified node 24 / git 2.53 / clawhub 0.23 /
openclaw / claude all present. **`codex` CLI absent** (confirmed) → roster omits it; QA-gate runs apply-mode.
Three BOOTSTRAP corrections applied (audit→`appendAudit`, sqlite-vec load risk, `.fusion/` packaging) and
`.fusion/` added to `.gitignore`.

**Phase 1 (Atlas) — structural core SHIPPED + dogfood-verified.** Scope decision (locked by the §3 Phase-1
note): ship the structural core first — none of it needs Ollama or tree-sitter WASM.

*Built (all lint-clean, 200/200 tests green incl. 20 new atlas tests):*
- `electron/atlas/types.ts`, `driver.ts` (Queryable shared by better-sqlite3 + node:sqlite), `schema.ts`,
  `parse/tsProgram.ts` (TS compiler API → symbols + resolved edges), `staleness.ts`, `query.ts`, `index.ts`
  (`writeIndex` agnostic + `scanWorkspace`), `db.ts` (per-workspace better-sqlite3), `embed.ts` (gated
  nomic-embed + embedding-cluster superseded), `summarize.ts` (gated), `watch.ts` (fs.watch), `codeBrainServer.ts`.
- `electron/ipc/atlas.ts` IPC (`atlas:open/index/status/query/graph/card/enrich/close`), wired into
  `main.ts` / `preload.ts` / `src/types.d.ts` (new `window.api.atlas.*`, superset).
- `src/lib/atlasClient.ts` + `src/tabs/ProjectBrainTab.tsx` (cytoscape graph + status filters + cards + locate),
  registered as the **Project Brain** tab in `App.tsx` (`store/ui.ts` Tab union extended).
- Tests: `tests/atlas.parse.test.ts` (7), `tests/atlas.staleness.test.ts` (6), `tests/atlas.index.test.ts` (7,
  full parse→persist→tag→query on node:sqlite).

*Dogfood acceptance (verified by indexing claw-deck itself, headless):* 113 files / 590 symbols / 1409 edges in
~0.9s; 459 active / 18 orphaned. `locate("screenshot region cropping")` → `screenshot.ts` + `RegionSelect.tsx` ✅.
The compiled `code-brain` server completed a full MCP stdio handshake (initialize→tools/list→tools/call) and
answered all 7 tools ✅.

*Key build decisions (deviations from the doc, all justified):*
1. **node:sqlite (Node 24, unflagged) verified** → the whole data layer is driver-agnostic over a tiny
   `Queryable`, so the real SQL is unit-tested under vitest (better-sqlite3 is Electron-ABI-bound and can't load
   in node) and the MCP server reuses `query.ts` verbatim.
2. **sqlite-vec NOT added** — shipped the float32-blob + JS-cosine fallback (per the §3 risk note). Revisit once
   it's verified to load in the Electron `better-sqlite3@^12` build.
3. **code-brain server relocated** to `electron/atlas/codeBrainServer.ts` (compiles via the existing electron
   tsconfig → `dist-electron/atlas/codeBrainServer.js`) instead of `mcp/code-brain/server.ts`, and is
   **hand-rolled JSON-RPC** (no `@modelcontextprotocol/sdk` dep — that dep was NOT in the Phase-1 locked list).
4. **fs.watch (recursive)** instead of chokidar — avoids a dep; §3 explicitly allows it.
5. **codex CLI absent** (RECON) — no `'codex'` backend added in Phase 1 (it's a Phase-2 concern).

*Phase-1 refinements added (2026-06-24, post-review answers from Cole):*
- **Auto-enrichment after every index** — `atlas:index` + the watcher now kick a guarded, gated, non-blocking
  background pass: embeddings → `applySupersededFromEmbeddings` → summaries. `embedModel` setting added
  (default `nomic-embed-text`). Still fails soft if Ollama/the model is down.
- **Polyglot done — python / bash / gdscript** via `parse/polyglot.ts` (205 tests now; +5 polyglot). **Deviation:**
  line/indentation structural extractor, NOT web-tree-sitter — gdscript has no prebuilt grammar wasm on npm
  (tree-sitter-gdscript is C-source-only) and the python/bash wasms carry ABI/packaging risk vs web-tree-sitter
  0.26. The line parser ships all three now (symbols + intra-file structural edges, resolved=0) with zero
  native/wasm surface; swapping python/bash to tree-sitter later is a drop-in precision upgrade behind the same
  ParseResult. Merged into `scanWorkspace` (TS via compiler API for resolved edges; polyglot for the rest).
- **fusionRoster seeded** in settings defaults: kimi-k2.7-code / qwen3.5-397b / gemini-3-flash / qwen3-coder-480b
  (`*:cloud` panelists) + claude-code / codex / openclaw actors. (Cole is installing a real `codex` CLI → it's
  in the roster and gets a real `'codex'` runner backend in Phase 2.)

*Not done / deferred (flagged, not silently dropped):*
- **Embeddings/summaries need Ollama** — now auto-run after index, but unverified end-to-end (no model pulled in
  this session). `superseded` stays 0 until embeddings exist.
- **Incremental re-index** — watch.ts triggers a *full* re-index (correct, simple); per-file diff is a refinement.
- **git_last_date** — column exists, populated null (no `git log` shell-out yet).
- **Packaging** — `dist-electron/atlas/codeBrainServer.js` runs via `node` (dev-verified). Packaged builds will
  need `asarUnpack` of that file (or `process.execPath`+`ELECTRON_RUN_AS_NODE`, pending a check that Electron 42's
  bundled Node ships `node:sqlite`). Dev dogfooding — the Phase-1 target — works now.
- **Phases 2–6** not started.

