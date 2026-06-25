# Fusion Methods Bootstrap

**Target repo:** `claw-deck` (Electron + TS/React, Node 24)
**Scope:** Patch the existing `crucible` session mode; add four new methods (`foundry`, `foundry-design`, `assay`, `prospect`) plus two lightweight ones (`relay`, `scatter`); wire in the deterministic pre-gate lint module.
**Status:** ready to implement.

---

## 0. How to execute this bootstrap (instructions to Claude Code)

You are implementing this against the live `claw-deck` Fusion orchestrator. Do **discovery first** — do not assume file layout.

1. **Stage in a worktree.** Create a `fusion-methods` worktree, write a `CHANGE_PLAN.md` mapping every section below to the files you will touch, and produce a `changes.diff` artifact at the end. Do not modify `main` directly.
2. **Discover the orchestrator.** Grep for how `crucible` is defined and run today:
   - `rg -n "crucible" src/` — find the mode registry and the phase runner.
   - Identify: (a) where session modes are registered, (b) the phase/round loop, (c) how an agent call is made (the Ollama + Claude Code + Codex harness), (d) how artifacts pass between phases, (e) where `--allowedTools` read-only advisor enforcement lives, (f) the Atlas query interface (`.fusion/atlas.db`).
   - Read `docs/fusion/BOOTSTRAP.md` for established conventions before changing anything.
3. **Order of operations** (each step testable):
   1. §1.4 Lint module (provided — drop + wire).
   2. §1.1 Roster/roles config.
   3. §1.2 No-abort contract + §1.3 artifact integrity (shared infra).
   4. §2 Crucible patch (proves the infra against the existing mode).
   5. §3 New methods (each registers as a pipeline; reuse shared infra).
   6. §4 Registry + printed descriptions.
4. **GLOBAL RULE — NO ABORTS.** Nothing may terminate a run on error. Every failure path is *fix-or-fallback* (§1.2). The only terminal state is "completed with a final artifact + report," possibly degraded and clearly labeled.

---

## 1. Shared foundation (all methods depend on this)

### 1.1 Roster & role-eligibility config

Evidence-based, from the Crucible run that designed the SporeSpore evaluator (10 rounds, 6 agents). Encode as a config table the methods read; do not hard-code model names inside each method.

| Model (advisor id) | Eligible roles | NOT eligible | Evidence |
|---|---|---|---|
| **Kimi K2.7** | `critic`, `builder`, `consolidator-backup`, `qa-wholedoc` | — | 3 new blocking bugs as critic; complete builds; correct Dijkstra; large context |
| **Qwen3.5 397B** | `critic`, `builder` | — | 3 new blocking bugs (precision critic); thorough builds |
| **Gemini 3 Flash @ temp 1.1** | `diverger`, `wildcard-critic`, `ideator` | `builder`, `final-qa`, `consolidator`, `judge` | Found 1 subtle bug others missed; outputs thin (122-line stubs). High temp = high variance |
| **Qwen3 Coder 480B** | `builder`, `repair-hand`, `extractor`, `qa-wholedoc` | **`critic` / `red-team`** | NO_FURTHER_ISSUES x3 — useless as critic. Strong builder; had the hinge fix; large context |
| **deepseek-v4-pro** | `qa-focused` (chunked), `builder` | `qa-wholedoc` (smaller window) | Strong debt/physics rigor; bounced on truncated whole-doc input — chunk its reviews |
| **Claude (Claude Code)** | `framer`, `consolidator`, `judge-tiebreak`, `qa-code` | budget-limited | Best consolidator; tip-angle + robust convex test adopted by others. **Max 10 calls/run.** |
| **Codex** | `verify`, `judge-primary`, `qa-code` | budget-limited | Trusted code correctness. **Max 10 calls/run.** |
| `minimax-m3:cloud`, `nemotron-3-ultra:cloud` | `diverger`, `ideator` (when reachable) | — | Fetch-failed last run; optional, never required |

**Rules the config enforces:**
- `critic`/`red-team` may never be Qwen-Coder.
- `builder`/`final-qa`/`consolidator`/`judge` may never be Gemini@1.1.
- `qa-wholedoc` (full large artifact) only large-context models (Kimi, Qwen-Coder, Claude). deepseek is `qa-focused` only and must receive chunked input.
- A critic never red-teams its own draft (rotation; `critic != author`).
- Per-run budget assert: `claudeCalls <= 10 && codexCalls <= 10`. Exceeding -> log + downgrade optional trusted steps (e.g. skip Claude tie-break), never error.

### 1.2 No-abort / fix-or-fallback contract (global)

Wrap every phase. No `throw` ends a run.

- **Model/fetch failure:** retry **once**; on second failure **drop that advisor**, log `WARN: advisor <id> dropped (fetch failed), quorum now N`, **proceed**. Never refuse for low quorum.
- **Gate failure (lint/compile/contract):** route specific failures into a **bounded auto-repair loop** (`maxRepairRounds: 2`) via a `builder`/`repair-hand`, then re-gate. Still failing -> **attach residual findings to the report and continue** (ship-with-warnings).
- **QA "major":** route findings into **one** bounded fix round (consolidator patches only flagged sections), re-QA once. Still major -> ship best artifact + prominent `UNRESOLVED` section. (The "bounce -> fix-loop," kept.)
- **Disagreement/contradiction:** resolve by panel/tiebreak, not by stopping.
- **Anything unexpected:** catch, log, fall back to last good artifact, mark report `DEGRADED`. Completion is mandatory.

Implement as `runPhase(name, fn, { fallback, retries: 1 })` that guarantees a return value.

### 1.3 Artifact handoff integrity (fixes the bounce root-cause)

The Crucible bounce was an artifact **inline-truncated** into the QA prompt (cut at ~15%, mid-word at "...happens in `val"). Fix everywhere artifacts move:

1. **Pass by reference, not inline string.** Write each phase artifact to `.fusion/run-<id>/<phase>-<agent>.md`; pass the **path** (+ short summary) downstream. Inline only if it provably fits the receiving model's context with margin.
2. **Assert integrity on every handoff.** Before a downstream model reasons: `received.length >= source.length * 0.98` and matching sha256-prefix. Mismatch -> re-read/re-select (fix-or-fallback); log as a plumbing error, **never** as a content verdict.
3. **Echo + verify.** Reviewers/judges must begin output with `REVIEWING: <sha12> | <first80>...<last80>`; orchestrator asserts it matches. Mismatch -> re-feed.
4. **Whole-doc QA only on large-context models** (§1.1). `qa-focused` models receive **chunked** input (per section), findings merged.

### 1.4 The pre-gate lint module (`fusion-lint.ts`)

Implemented and unit-verified against the three real defect classes from the run. Place at `src/fusion/lint/fusion-lint.ts` (provided with this bootstrap).

**Deterministic and free** — run on every consolidated artifact *before* any QA model call. Catches:
- `handoff-truncation` / `truncation-midtoken` / `truncation-dangling` — the bounce cause.
- `dead-code-correction` / `dead-code-correction-prose` — wrong code left under a "BUG/should be/CORRECTION/Fixed:" note (executor would ship the broken version).
- `bracket-imbalance` / `code-fence-unclosed` — truncated functions.
- `changelog-contradiction` (warn) — "replaced X with Dijkstra" while code still calls `pop_front`.

Wire as **P5**:
```ts
import { lintArtifact, formatFindings } from "../lint/fusion-lint";
const lint = lintArtifact(consolidated, { source: rawConsolidated });
if (!lint.passed) {
  consolidated = await repairLoop(consolidated, formatFindings(lint), { maxRounds: 2 });
  // re-lint; if still failing, attach to report.UNRESOLVED and continue.
}
```
Add a regression test feeding the actual gist defect strings, asserting they flag.

---

## 2. Crucible patch (keep the mode, fix it)

Apply to existing `crucible` (round1 -> 3x steelman/redteam -> synthesize -> harden -> qa -> blind judge -> build):

1. **Single canonical artifact before QA.** Today `harden` fans out and QA consumes `outputs[0]` (the weakest, last time). Insert a **Consolidate** step (1 Claude, `consolidator`) after `harden` that merges all hardened drafts into **one** artifact. QA reviews *that*, never an arbitrary index.
2. **Artifact integrity** (§1.3) on harden->consolidate->QA->judge. This alone prevents the bounce.
3. **Pre-QA lint gate** (§1.4) before the QA model call.
4. **Whole-doc QA on a large-context model** (Kimi or Claude), not deepseek; if deepseek used, chunk (§1.3.4).
5. **No aborts / fix-or-fallback** (§1.2) everywhere. Remove any `throw`/early-return that ends a run.
6. **Bounce -> fix-loop** (keep): QA major -> one bounded repair -> re-QA -> else ship-with-`UNRESOLVED`.
7. **Surface dropped advisors** (§1.2): silent `minimax/nemotron fetch failed` becomes a logged WARN + quorum count; run proceeds.
8. **Assign by strength** (§1.1): stop sending red-team to Qwen-Coder; stop sending full builds to Gemini@1.1.

---

## 3. New methods

Each registers as a declarative pipeline (phases + role-based assignments + gates + end-prompt). Costs asserted vs trusted-call budget. All inherit §1.2/§1.3/§1.4.

### 3.1 `foundry` — hard design + code (flagship)

For problems with a compilable/checkable deliverable.

| Phase | Role -> advisor | Trusted | Gate |
|---|---|---|---|
| P0 Frame | `framer` -> Claude | 1 Claude | contract + invariant laws + **3-5 runnable golden tests** |
| P1 Diverge (parallel) | `diverger` x5 -> Kimi, Qwen3.5, Qwen-Coder, deepseek, Gemini@1.1 | 0 | — |
| P2 Gauntlet (parallel, rotated) | `critic` -> Kimi, Qwen3.5, Gemini@1.1 (critic!=author; **no Qwen-Coder**) | 0 | structured findings only |
| P3 Repair (parallel) | `repair-hand` -> authors + Qwen-Coder | 0 | finding->fix changelog |
| P4 Consolidate | `consolidator` -> Claude | 1 Claude | ONE canonical artifact |
| P5 Hard gate | deterministic | 0 (free) | **lint (§1.4) + compile-check + contract-check + run P0 golden tests**; fail -> auto-repair <=2 -> re-gate |
| P6 Panel QA | `qa-wholedoc` -> Kimi + `qa-code` -> Codex (chunked, hash-verified) | 1 Codex | blocking -> 1 bounce-fix (Claude <=1) |
| P7 Blind judge | `judge-primary` -> Codex; `judge-tiebreak` -> Claude only if contested | 1 Codex (+<=1 Claude) | score blind vs P0 rubric/tests |
| P8 Build | `builder` -> Qwen-Coder/Kimi | 0 | worktree + CHANGE_PLAN.md + diff |

**Budget:** ~3 Claude, ~2 Codex. **End-prompt:** "Ship this build?" `[apply diff / open PR / discard]`.

### 3.2 `foundry-design` — design with no compilable output

For architecture/spec/policy/algorithm docs. Restores objectivity three ways.

| Phase | Role -> advisor | Trusted | Gate |
|---|---|---|---|
| P0 Frame | `framer` -> Claude | 1 Claude | **weighted rubric + invariant "must-not-violate" laws** (replaces golden tests) |
| P1 Diverge (parallel) | `diverger` x4 -> Kimi, Qwen3.5, deepseek, Gemini@1.1 | 0 | — |
| P2 Gauntlet (rotated) | `critic` -> Kimi, Qwen3.5, Gemini@1.1 | 0 | each blocking finding must be explicitly closed later |
| P3 Repair (parallel) | `repair-hand` -> authors | 0 | finding->fix changelog |
| P4 Consolidate | `consolidator` -> Claude | 1 Claude | ONE canonical design |
| P5 Consistency lint | deterministic | 0 (free) | **lint (§1.4) + design-consistency: every referenced term defined, every declared output produced, every changelog claim maps to a section, no section contradicts another**; fail -> auto-repair <=2 |
| P6 Panel QA | `qa-wholedoc` -> Kimi + `qa-focused` -> deepseek (chunked sections) | 0 | blocking -> 1 bounce-fix (Claude <=1) |
| P7 Triple blind judge | `judge` x3 -> 2 Ollama + Codex; `judge-tiebreak` -> Claude if variance high | 1 Codex (+<=1 Claude) | score vs rubric; **low variance = confident pass, high variance = contested -> tiebreak** |

**Why three judges:** no compiler means consensus *is* the objectivity proxy. One judge can be confidently wrong (the bounce proved it); three converging cannot, cheaply. **Budget:** ~3 Claude, ~1 Codex. **End-prompt:** "Write a bootstrap to implement this design?" `[yes / refine first / no]`.

> Extend §1.4 lint with a **design-consistency** pass for P5: (a) collect backtick-quoted identifiers + `## headings`; flag referenced-but-never-defined terms; (b) parse the declared "Output contract" list and assert each field is produced/used; (c) reuse `changelog-contradiction`; (d) flag two sentences asserting opposite values for the same named quantity. Same text engine.

### 3.3 `assay` — repo audit (heuristic or targeted)

Ingest-and-analyze. **Targeted** when the user names things (`assay --focus "auth flow, SkillsTab version detection"`), else **heuristic** sweep.

| Phase | Role -> advisor | Trusted | Notes |
|---|---|---|---|
| P0 Ingest | `extractor` -> Qwen-Coder (or free) | 0 | read README/`docs`/architecture; build function + call-graph map. **Query Atlas (`.fusion/atlas.db`) first; fall back to doc-walk + `rg` + AST** if absent |
| P1 Scope | deterministic | 0 | targeted -> focus list; heuristic -> full dimension sweep |
| P2 Specialist sweep (parallel, by lens) | Kimi=logic/correctness; Qwen3.5=error-handling/edge cases; deepseek=performance+security; Gemini@1.1=non-obvious smells/architectural drift; Qwen-Coder=inventory/dead-code/doc-drift (extraction) | 0 | each finding: `file:line` + evidence + suggested fix |
| P3 Dedup + rank | `consolidator` -> Claude | 1 Claude | merge overlaps; rank by **severity x effort** |
| P4 **Verify** | `verify` -> Codex (high-sev only) + deterministic | 1 Codex | **re-check each checkable finding against actual code before reporting** — kills phantom findings |
| P5 Report | deterministic | 0 | heuristic -> ranked register; targeted -> direct answers |

**Budget:** ~1 Claude, ~1 Codex. No-abort: missing Atlas -> grep fallback; lens model fails -> redistribute its dimension, log the coverage gap. **End-prompt:** "Write a bootstrap to fix/add these?" `[all / pick which / none]` -> selected items seed a `foundry` run.

### 3.4 `prospect` — repo ideation

Generative/advisory. Maximize divergence, ground in feasibility, present a ranked board.

| Phase | Role -> advisor | Trusted | Notes |
|---|---|---|---|
| P0 Ingest | `extractor` -> Qwen-Coder (or free) | 0 | what the repo *is*: architecture, roadmap, TODOs, gaps (Atlas-first) |
| P1 Ideate (parallel, by flavor) | **Gemini@1.1**=bold/novel; Kimi=high-value pragmatic fits; Qwen3.5=DX/robustness/missing-infra; deepseek=perf/scale extensions; Qwen-Coder=quick wins | 0 | each idea: one-line "why" |
| P2 Feasibility gauntlet (rotated) | `critic` -> Kimi + Qwen3.5 | 0 | per idea: fit, effort, risk, deps, conflicts (red-team the *ideas*) |
| P3 Cluster + rank | `consolidator` -> Claude | 1 Claude | dedup, cluster into themes, rank by **value x feasibility**; each: what / why / how-to-build / effort / risks |
| P4 Present | deterministic | 0 | opportunity board |

**Budget:** ~1 Claude, 0 Codex (cheapest). Gemini@1.1 is the star — its thin-implementation weakness is irrelevant; Prospect never implements. **End-prompt:** "Build these?" `[pick which]` -> each chosen idea launches a `foundry` run pre-seeded with its spec.

### 3.5 `relay` (fast) & 3.6 `scatter` (greenfield) — optional

- **`relay`:** linear chain — Ollama draft -> different Ollama critic -> Ollama repair -> Claude x1 consolidate+gate -> build. ~4 Ollama + 1 Claude. For tasks not worth the full tournament.
- **`scatter`:** maximize divergence, **refuse to converge** — all reachable agents (Gemini@1.1 cranked) generate deliberately different architectural bets in parallel -> Claude x1 *clusters* into 2-3 directions with tradeoffs -> **human picks**. No QA, no winner forced. For "what should we even build." ~6-8 Ollama + 1 Claude.

---

## 4. Mode registry + printed descriptions

Register each method; on start, print its block to the user:

```
FOUNDRY - multi-agent build (design + code)
Use for: hard problems with a checkable deliverable - evaluators, modules, algorithms with tests.
Runs: criteria + golden tests first; 5 models draft in parallel; rotating critics tear down; authors repair;
Claude merges to one artifact; a FREE gate lints + compiles + runs the tests; panel QA; Codex judges blind.
Errors trigger repair loops, never a hard stop. You get: one built artifact + diff + judge scorecard.
Ends asking: Ship this build? [apply diff / open PR / discard]

FOUNDRY-DESIGN - multi-agent design synthesis (no build target)
Use for: architecture, specs, policy/algorithm design - the deliverable is a document.
Runs: rubric + invariant laws first; 4 models design in parallel; rotating critics; Claude merges to one design;
a FREE consistency lint; panel review; THREE blind judges score (consensus = confidence). Repair loops, no hard stop.
You get: one consolidated design + a findings ledger (every weakness raised and how it was closed) + judge scores.
Ends asking: Write a bootstrap to implement this design? [yes / refine first / no]

ASSAY - repo health audit
Use for: "is this codebase sound?" - logic bugs, weak error-handling, perf/security, dead code, doc drift.
Targeted: assay --focus "auth flow, SkillsTab version detection"
Runs: maps the repo (Atlas if available); five specialists each sweep a different lens; findings merged and ranked
by severity-vs-effort; EACH issue verified against real code before reporting (no phantom findings).
You get: a ranked register - every issue with file:line, evidence, severity, suggested fix. Targeted runs answer directly.
Ends asking: Write a bootstrap to fix/add these? [all / pick which / none]

PROSPECT - find new things worth building
Use for: "what should I add to this repo?" - high-value features, missing infra, quick wins that fit the architecture.
Runs: reads the repo (Atlas if available); five models brainstorm from different angles (bold / pragmatic / DX /
perf / quick wins); ideas stress-tested for fit, effort, risk; clustered and ranked by value-vs-feasibility.
You get: a ranked opportunity board - what / why / how-to-build sketch / effort / risks per idea.
Ends asking: Build these? [pick which]
```

---

## 5. Chaining

- `assay` -> `foundry`: selected fix items become a pre-seeded P0 (finding + file:line + suggested fix *is* the spec). No re-explaining context.
- `prospect` -> `foundry`: a chosen idea's how-to-build sketch seeds P0.
- `foundry-design` -> `foundry`: an approved design's invariant laws become `foundry`'s P0 contract; its rubric feeds the golden-test design.

Implement: each method's end-prompt, on selection, builds the next method's `seed` object (`{ contract, focus, artifacts[] }`) and launches it without a fresh ingest.

---

## 6. Acceptance checklist (verify before opening the PR)

- [x] `fusion-lint.ts` placed (`electron/council/fusionLint.ts`), unit test passes, **regression test feeds the gist defect strings and asserts they flag** (`tests/fusion.lint.test.ts`). Wired as a pre-gate in `run.ts` (emits a `lint` event, folds findings into the gate prompt). *Repair loop still pending — §2.*
- [ ] No `throw`/early-return ends any run; every phase returns via the fix-or-fallback helper.
- [ ] Every cross-phase handoff passes artifacts by reference + asserts length/hash; no inline-truncation path remains.
- [ ] Reviewers/judges emit the `REVIEWING:` echo and the orchestrator asserts it.
- [ ] Role config rejects: Qwen-Coder as critic; Gemini@1.1 as builder/final-qa/judge; deepseek as whole-doc QA.
- [ ] Trusted-budget guard asserts `claude <= 10 && codex <= 10` per run and downgrades optional trusted steps rather than erroring.
- [ ] `crucible` consolidates to one artifact before QA, runs the lint gate, surfaces dropped advisors.
- [ ] All four new methods registered; printed descriptions render on start.
- [ ] `assay`/`prospect` query Atlas first and fall back to grep/AST when `.fusion/atlas.db` is absent.
- [ ] Chaining (`assay`/`prospect`/`foundry-design` -> `foundry`) passes a seed without re-ingest.
- [ ] `CHANGE_PLAN.md` + `changes.diff` produced in the worktree.
