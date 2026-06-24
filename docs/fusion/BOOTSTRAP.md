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
**approve** → apply onto live tree + `audit.ts` append + persist; **reject** → `git worktree remove --force`.
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
