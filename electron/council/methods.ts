// Fusion-methods §3/§4 — declarative method pipelines + registry.
//
// Each METHOD is a declarative list of steps with role-based assignment (via roles.ts),
// deterministic gates (fusionLint), and the no-abort contract (fusionInfra). The engine
// (`runMethod`) interprets the steps over an INJECTED transport, so it is unit-testable
// with stubs. Exotic capabilities (compile-check, golden tests, Atlas, build) are passed
// in deps and DEGRADE GRACEFULLY when absent — never abort (§1.2).

import { RosterAgent, Msg } from './agents';
import { TransportFn, CouncilEvent } from './run';
import { FusionRole, pickAdvisors, Budget, makeBudget } from './roles';
import { lintArtifact, formatFindings } from './fusionLint';
import { boundedRepair, runPhase, sha12, echoMatches, artifactStore } from './fusionInfra';

// ----------------------------- declarative method spec -----------------------------

export type StepKind =
  | 'frame'        // 1 trusted framer → contract / rubric / golden tests
  | 'ingest'       // extractor reads the repo (Atlas-first) → a map
  | 'scope'        // deterministic: targeted vs heuristic
  | 'diverge'      // N advisors draft in parallel
  | 'ideate'       // N advisors brainstorm in parallel (by flavor)
  | 'gauntlet'     // N critics (rotated) surface findings
  | 'repair'       // repair-hands address the findings
  | 'consolidate'  // 1 consolidator merges drafts → ONE artifact
  | 'cluster'      // 1 consolidator clusters ideas/bets → ranked themes
  | 'lint-gate'    // deterministic lint (+optional compile/golden) + repair loop
  | 'qa'           // panel QA (whole-doc + code/focused)
  | 'verify'       // re-check checkable findings against real code
  | 'judge'        // blind judge(s) score; optional tiebreak
  | 'build'        // builder → worktree diff
  | 'report';      // deterministic assembly of the final report

export interface MethodStep {
  kind: StepKind;
  label: string;
  role?: FusionRole;       // primary role assigned for this step
  count?: number;          // how many advisors (diverge/ideate/gauntlet)
  rotated?: boolean;       // critic != author (exclude prior authors)
  judges?: number;         // judge-panel size
  tiebreak?: boolean;      // allow a Claude tiebreak when contested
  blind?: boolean;         // judge sees only task + artifact
  optional?: boolean;      // skip (don't degrade the report) if unassignable
}

export interface Method {
  id: string;
  name: string;
  use: string;             // "Use for: …"
  summary: string;         // one-paragraph "Runs: …"
  endPrompt: string;       // "Ends asking: …"
  budget: string;          // "~3 Claude, ~2 Codex"
  phases: MethodStep[];
}

// ----------------------------- engine deps -----------------------------

export interface MethodDeps {
  task: string;
  focus?: string;                       // assay/prospect targeted focus
  roster: RosterAgent[];                // available advisors
  transport: TransportFn;
  emit?: (ev: CouncilEvent) => void;
  signal?: { aborted: boolean };
  budget?: Budget;
  runDir?: string;                      // §1.3 — write each phase artifact here (pass-by-reference)
  seed?: { contract?: string; artifacts?: string[]; focus?: string }; // §5 chaining — pre-seed P0, skip re-ingest
  // Optional capabilities — degrade gracefully when absent (§1.2 no-abort).
  compileCheck?: (artifact: string) => Promise<{ ok: boolean; output: string }>;
  goldenTests?: (artifact: string, contract: string) => Promise<{ ok: boolean; output: string }>;
  atlasQuery?: (q: string) => Promise<string | null>;
  readFiles?: (paths: string[]) => Promise<Record<string, string>>; // real-code grounding for assay/prospect
  build?: (artifact: string, builder: RosterAgent) => Promise<{ ok: boolean; diff?: string; error?: string }>;
}

export interface MethodResult {
  methodId: string;
  artifact: string;
  contract: string;
  findings: string[];
  report: string;
  degraded: boolean;
  warnings: string[];
  scores: { agentId: string; verdict: string }[];
  diff?: string;
  seed: { task: string; focus?: string; contract: string; artifacts: string[] };  // §5 chaining
}

const SYS = {
  frame: 'You are the framer. Produce a tight CONTRACT for this task: the invariants/laws it must not violate, the output contract (named fields it must produce), and 3–5 concrete, runnable acceptance checks ("golden" criteria). Be specific and checkable. No preamble.',
  rubric: 'You are the framer. Produce a weighted RUBRIC (criteria + weights) plus the invariant "must-not-violate" laws this design must satisfy. Make every criterion objectively checkable. No preamble.',
  diverge: 'You are one of several engineers drafting INDEPENDENTLY. Produce your best complete attempt at the task. Do not hedge or defer; commit to concrete choices.',
  ideate: 'You are brainstorming opportunities for this repo from your assigned angle. Produce several concrete ideas; for each, a one-line "why it is worth building". Favor genuinely valuable, fitting ideas over filler.',
  critic: 'You are an adversarial critic. Find concrete, NEW problems in the artifact (bugs, missing cases, wrong assumptions, deprecated APIs, security). For each: a specific location/aspect + why it is wrong + a suggested fix. If you genuinely find nothing new, reply EXACTLY: NO_FURTHER_ISSUES.',
  feasibility: 'You are stress-testing IDEAS for feasibility. For each idea: fit with the codebase, effort, risk, dependencies, and conflicts. Be concrete; kill ideas that do not fit.',
  repair: 'You are a repair hand. Apply the listed findings to the artifact and return the COMPLETE corrected artifact. Fix the findings; do not redesign or add scope. No commentary.',
  consolidate: 'You are the consolidator. Merge the drafts into ONE canonical artifact — take the strongest parts of each, resolve conflicts, drop redundancy. Output the single consolidated artifact only.',
  cluster: 'You are the consolidator. Cluster these candidates into 2–4 coherent themes/directions. For each: a name, what it is, why it matters, a how-to-build sketch, effort, and risks. Rank by value × feasibility. Output a ranked board.',
  ingest: 'You are mapping a repository. From the provided context, summarize what the repo IS: architecture, key modules, roadmap/TODOs, and gaps. Build a concise function/call map. No preamble.',
  qaWhole: 'You are reviewing the FULL artifact for blocking problems (correctness, completeness, contract violations). List blocking issues with locations; if none, reply EXACTLY: NO_BLOCKING_ISSUES.',
  qaCode: 'You are a code-correctness reviewer. Check the code in the artifact compiles in principle and matches the contract. List blocking defects with locations; if none, reply EXACTLY: NO_BLOCKING_ISSUES.',
  verify: 'You are verifying findings against the ACTUAL code. For each finding, mark CONFIRMED or PHANTOM with a one-line reason. Drop phantoms. Output only confirmed findings.',
  judge: 'You are a BLIND judge. You see only the task/contract and the artifact — no discussion. Score it 0–10 against the contract and give a one-line justification. Start your reply with "SCORE: <n>".',
};

// ----------------------------- the engine -----------------------------

const aborted = (deps: MethodDeps) => !!deps.signal?.aborted;

/** One transport call wrapped to never throw + charge the trusted budget (downgrade, not error). */
async function call(deps: MethodDeps, budget: Budget, agent: RosterAgent, system: string, user: string, phase: string): Promise<string | null> {
  if (!budget.canAfford(agent)) { deps.emit?.({ type: 'warn', phase, content: `budget reached — skipping trusted ${agent.displayName} call (downgraded)`, ok: true }); return null; }
  budget.charge(agent);
  try {
    deps.emit?.({ type: 'agent-start', phase, agentId: agent.id });
    const msgs: Msg[] = [{ role: 'system', content: system }, { role: 'user', content: user }];
    const out = await deps.transport(agent, msgs, (d) => deps.emit?.({ type: 'agent-delta', phase, agentId: agent.id, content: d }));
    deps.emit?.({ type: 'agent', phase, agentId: agent.id, content: out });
    return out;
  } catch (e: any) {
    deps.emit?.({ type: 'agent-error', phase, agentId: agent.id, content: String(e?.message ?? e).slice(0, 800), ok: false });
    return null;
  }
}

/** Assign advisors for a step; emit + record a coverage-gap warning instead of aborting. */
function assign(deps: MethodDeps, role: FusionRole, count: number, exclude: string[], warnings: string[], phase: string): RosterAgent[] {
  const { picks, warning } = pickAdvisors(deps.roster, role, count, { exclude });
  if (warning) { warnings.push(warning); deps.emit?.({ type: 'warn', phase, content: warning, ok: picks.length > 0 }); }
  return picks;
}

/** §1.3.3 — ask a reviewer/judge that MUST echo `REVIEWING: <sha12>` so we can detect a
 *  truncated handoff. On a mismatch (or a missing header) we re-feed the full artifact ONCE
 *  and log it as a plumbing warning, never as a content verdict. */
async function askVerified(deps: MethodDeps, budget: Budget, agent: RosterAgent, system: string, artifact: string, base: string, phase: string): Promise<string | null> {
  const sha = sha12(artifact);
  const hdr = `You MUST begin your reply with exactly "REVIEWING: ${sha}" (then a newline) to confirm you received the COMPLETE artifact.`;
  let reply = await call(deps, budget, agent, system, `${base}\n\n${hdr}`, phase);
  if (reply && !echoMatches(reply, artifact)) {
    deps.emit?.({ type: 'warn', phase, content: `${agent.displayName} did not echo REVIEWING:${sha} — possible truncated handoff; re-feeding the full artifact once`, ok: true });
    reply = await call(deps, budget, agent, system, `${base}\n\n${hdr}\nYour previous reply omitted the header — you may have seen a truncated copy. Here is the full artifact again; start with the header.`, `${phase} · re-feed`);
  }
  return reply;
}

export async function runMethod(method: Method, deps: MethodDeps): Promise<MethodResult> {
  const budget = deps.budget ?? makeBudget();
  const warnings: string[] = [];
  const onWarn = (m: string) => warnings.push(m);
  // capture downgrade/coverage warnings emitted by call()/assign() into the result
  const emit = (ev: CouncilEvent) => { if (ev.type === 'warn' && ev.content) warnings.push(ev.content); deps.emit?.(ev); };
  const ldeps: MethodDeps = { ...deps, emit };
  const store = deps.runDir ? artifactStore(deps.runDir) : undefined;
  let degraded = false;
  // §5 chaining — a seed pre-loads the contract + prior artifacts so we don't re-ingest.
  let contract = deps.seed?.contract ?? '';
  let artifact = deps.seed?.artifacts?.length ? deps.seed.artifacts.join('\n\n') : '';
  let map = '';
  let codeContext = '';   // actual source of the key files (real-code grounding for audits)
  let findings: string[] = [];
  const scores: { agentId: string; verdict: string }[] = [];
  let lastAuthors: string[] = [];
  let lastWritten = '';
  let diff: string | undefined;
  if (deps.seed) emit({ type: 'agent', phase: method.name, kind: 'seed', content: `Seeded from a prior run — skipping re-ingest. ${deps.seed.contract ? 'Contract carried forward.' : ''}` });

  deps.emit?.({ type: 'phase', phase: method.name, kind: 'method' });

  for (const step of method.phases) {
    if (aborted(deps)) break;
    if (deps.seed && step.kind === 'ingest') { emit({ type: 'agent', phase: step.label, kind: 'skip', content: '(skipped — seeded from prior run)' }); continue; }
    deps.emit?.({ type: 'phase', phase: step.label, kind: step.kind });

    const outcome = await runPhase<void>(step.label, async () => {
      switch (step.kind) {
        case 'frame': {
          const [framer] = assign(ldeps, step.role ?? 'framer', 1, [], warnings, step.label);
          if (!framer) return;
          const out = await call(ldeps, budget, framer, step.role === 'framer' ? SYS.frame : SYS.rubric, `Task:\n${deps.task}`, step.label);
          if (out) contract = out;
          return;
        }
        case 'ingest': {
          const [ex] = assign(ldeps, 'extractor', 1, [], warnings, step.label);
          let atlas: string | null = null;
          if (deps.atlasQuery) { try { atlas = await deps.atlasQuery(deps.focus || deps.task); } catch { /* fall back */ } }
          if (!atlas) { warnings.push('Atlas unavailable — extractor falls back to doc/grep walk'); deps.emit?.({ type: 'warn', phase: step.label, content: 'Atlas (.fusion/atlas.db) unavailable — falling back to doc/grep walk', ok: true }); }
          // Real grounding: pull the actual source of the top files the Atlas surfaced so
          // the extractor + the later sweep audit real code, not just a summary. Degrades
          // (no readFiles capability) to summary-only.
          if (atlas && deps.readFiles) {
            const files = [...new Set(atlas.split('\n').map((l) => l.split(' — ')[0].replace(/:\d+$/, '').trim()).filter(Boolean))].slice(0, 6);
            try {
              const contents = await deps.readFiles(files);
              const parts = Object.entries(contents).filter(([, c]) => c).map(([f, c]) => `// ===== FILE: ${f} =====\n${c.slice(0, 8000)}`);
              if (parts.length) { codeContext = parts.join('\n\n'); deps.emit?.({ type: 'agent', phase: step.label, kind: 'files', content: `read ${parts.length} file(s) for grounding: ${files.slice(0, parts.length).join(', ')}` }); }
            } catch { /* summary-only */ }
          } else if (atlas && !deps.readFiles) { warnings.push('no file-read capability — sweep audits the summary, not full source'); }
          if (ex) { const out = await call(ldeps, budget, ex, SYS.ingest, `Task:\n${deps.task}\n\nAtlas symbol map:\n${atlas ?? '(none — describe from the task + your knowledge of the repo)'}${codeContext ? `\n\nActual source of the key files:\n${codeContext}` : ''}`, step.label); if (out) map = out; }
          return;
        }
        case 'scope': {
          const mode = deps.focus ? `TARGETED (focus: ${deps.focus})` : 'HEURISTIC (full sweep)';
          deps.emit?.({ type: 'agent', phase: step.label, kind: 'scope', content: mode });
          contract = contract || `Scope: ${mode}`;
          return;
        }
        case 'diverge':
        case 'ideate': {
          const n = step.count ?? 4;
          const advisors = assign(ldeps, step.role ?? (step.kind === 'ideate' ? 'ideator' : 'diverger'), n, [], warnings, step.label);
          const base = `Task:\n${deps.task}${contract ? `\n\nContract/Rubric:\n${contract}` : ''}${map ? `\n\nRepo map:\n${map}` : ''}${artifact ? `\n\nCurrent material:\n${artifact}` : ''}`;
          const settled = await Promise.all(advisors.map((a) => call(ldeps, budget, a, step.kind === 'ideate' ? SYS.ideate : SYS.diverge, base, step.label)));
          const got = advisors.map((a, i) => settled[i] ? `### ${a.displayName}\n${settled[i]}` : '').filter(Boolean);
          if (got.length < advisors.length) deps.emit?.({ type: 'warn', phase: step.label, content: `${advisors.length - got.length} advisor(s) dropped; quorum ${got.length}/${advisors.length}`, ok: got.length > 0 });
          if (got.length) { artifact = got.join('\n\n'); lastAuthors = advisors.filter((_, i) => settled[i]).map((a) => a.id); }
          return;
        }
        case 'gauntlet': {
          const n = step.count ?? 3;
          const critics = assign(ldeps, step.role ?? 'critic', n, step.rotated ? lastAuthors : [], warnings, step.label);
          // Review the draft artifact when there is one (foundry/relay/prospect); for an
          // audit sweep with no draft (assay) review the ingested repo map + the actual
          // source pulled in during ingest, so the critics audit real code, not a summary.
          const subject = artifact || [codeContext && `Actual source:\n${codeContext}`, map && `Repo map:\n${map}`].filter(Boolean).join('\n\n---\n\n') || '(no draft — audit the repository from the task/focus and your knowledge)';
          const base = `Task:\n${deps.task}${deps.focus ? `\nFocus: ${deps.focus}` : ''}\n\nMaterial to review:\n${subject}`;
          const replies = await Promise.all(critics.map((a) => call(ldeps, budget, a, step.label.toLowerCase().includes('feasib') ? SYS.feasibility : SYS.critic, base, step.label)));
          const fresh = replies.map((r, i) => r && !/NO_FURTHER_ISSUES/i.test(r) ? `- (${critics[i].displayName}) ${r.trim().slice(0, 10000)}` : '').filter(Boolean);
          findings.push(...fresh);
          if (fresh.length) artifact += `\n\n## Findings (round: ${step.label})\n${fresh.join('\n')}`;
          return;
        }
        case 'repair': {
          if (!findings.length) return;
          const [hand] = assign(ldeps, step.role ?? 'repair-hand', 1, [], warnings, step.label);
          if (!hand) return;
          const out = await call(ldeps, budget, hand, SYS.repair, `Artifact:\n${artifact}\n\nFindings to address:\n${findings.join('\n')}\n\nReturn the complete corrected artifact.`, step.label);
          if (out) { artifact = out; findings = []; }
          return;
        }
        case 'consolidate':
        case 'cluster': {
          const [con] = assign(ldeps, step.role ?? 'consolidator', 1, [], warnings, step.label);
          if (!con) { warnings.push(`no consolidator available for '${step.label}' — keeping concatenated material`); return; }
          const out = await call(ldeps, budget, con, step.kind === 'cluster' ? SYS.cluster : SYS.consolidate, `Task:\n${deps.task}\n\nMaterial:\n${artifact}`, step.label);
          if (out) artifact = out;
          return;
        }
        case 'lint-gate': {
          let lint = lintArtifact(artifact);
          deps.emit?.({ type: 'lint', phase: step.label, content: formatFindings(lint), ok: lint.passed });
          if (!lint.passed) {
            const [hand] = assign(ldeps, 'repair-hand', 1, [], warnings, step.label);
            if (hand) {
              const rr = await boundedRepair(artifact,
                { passed: false, findings: lint.findings, report: formatFindings(lint) },
                async (art, report) => (await call(ldeps, budget, hand, SYS.repair, `Artifact:\n${art}\n\nDeterministic findings:\n${report}\n\nReturn the complete corrected artifact.`, step.label)) || art,
                (art) => { const l = lintArtifact(art); return { passed: l.passed, findings: l.findings, report: formatFindings(l) }; },
                { maxRounds: 2});
              artifact = rr.artifact; lint = lintArtifact(artifact);
              deps.emit?.({ type: 'lint', phase: `${step.label} · repaired`, content: rr.passed ? `clean in ${rr.rounds} round(s)` : formatFindings(lint), ok: rr.passed });
            }
            // §1.2 — still failing after the repair budget → ship, but surface it as UNRESOLVED.
            if (!lint.passed) findings.push(`lint (UNRESOLVED after ${'≤2'} repair rounds): ${formatFindings(lint).replace(/\s+/g, ' ').slice(0, 300)}`);
          }
          // optional deterministic gates — degrade to a note when absent
          if (deps.compileCheck) { const c = await deps.compileCheck(artifact); deps.emit?.({ type: 'validate', phase: `${step.label} · compile`, ok: c.ok }); if (!c.ok) findings.push(`compile: ${c.output.slice(0, 300)}`); }
          else warnings.push('no compile-check capability — lint-only gate');
          if (deps.goldenTests && contract) { const g = await deps.goldenTests(artifact, contract); deps.emit?.({ type: 'validate', phase: `${step.label} · golden`, ok: g.ok }); if (!g.ok) findings.push(`golden: ${g.output.slice(0, 300)}`); }
          return;
        }
        case 'qa': {
          const whole = assign(ldeps, 'qa-wholedoc', 1, [], warnings, step.label);
          const code = assign(ldeps, 'qa-code', 1, [], warnings, step.label);
          const base = `Task:\n${deps.task}\n\nArtifact:\n${artifact}`;
          const reviewers = [...whole, ...code];
          const replies = await Promise.all(reviewers.map((a, i) => askVerified(ldeps, budget, a, i < whole.length ? SYS.qaWhole : SYS.qaCode, artifact, base, step.label)));
          const blocking = replies.map((r, i) => r && !/NO_BLOCKING_ISSUES/i.test(r) ? `- (${reviewers[i].displayName}) ${r.trim().slice(0, 10000)}` : '').filter(Boolean);
          if (blocking.length) { findings.push(...blocking); artifact += `\n\n## QA blocking (one bounce-fix)\n${blocking.join('\n')}`; }
          return;
        }
        case 'verify': {
          if (!findings.length || !deps.roster.length) return;
          const [v] = assign(ldeps, 'verify', 1, [], warnings, step.label);
          if (!v) return;
          const out = await call(ldeps, budget, v, SYS.verify, `Findings:\n${findings.join('\n')}\n\nVerify each against the real code; drop phantoms.`, step.label);
          if (out) findings = out.split('\n').filter((l) => l.trim());
          return;
        }
        case 'judge': {
          const n = step.judges ?? 1;
          const judges = assign(ldeps, n >= 3 ? 'judge' : 'judge-primary', n, [], warnings, step.label);
          const base = `Task/contract:\n${contract || deps.task}\n\nArtifact:\n${artifact}`;
          const replies = await Promise.all(judges.map((a) => askVerified(ldeps, budget, a, SYS.judge, artifact, base, step.label)));
          replies.forEach((r, i) => { if (r) { const m = r.match(/SCORE:\s*(\d+)/i); const verdict = m ? `score ${m[1]}` : 'unscored'; scores.push({ agentId: judges[i].id, verdict }); deps.emit?.({ type: 'verdict', phase: step.label, agentId: judges[i].id, verdict }); } });
          const nums = scores.map((s) => Number(s.verdict.replace(/\D/g, ''))).filter((x) => !Number.isNaN(x));
          const variance = nums.length > 1 ? Math.max(...nums) - Math.min(...nums) : 0;
          if (step.tiebreak && variance >= 3) {
            const [tb] = assign(ldeps, 'judge-tiebreak', 1, [], warnings, step.label);
            if (tb) { const r = await call(ldeps, budget, tb, SYS.judge, base, `${step.label} · tiebreak`); if (r) { const m = r.match(/SCORE:\s*(\d+)/i); scores.push({ agentId: tb.id, verdict: m ? `score ${m[1]} (tiebreak)` : 'tiebreak' }); } }
          }
          return;
        }
        case 'build': {
          const [builder] = assign(ldeps, 'builder', 1, [], warnings, step.label);
          if (!builder) { warnings.push('no builder available — skipping build'); return; }
          if (!deps.build) { warnings.push('no build capability wired — artifact produced, not applied'); deps.emit?.({ type: 'warn', phase: step.label, content: 'no build capability — produced the artifact but did not apply', ok: true }); return; }
          const b = await deps.build(artifact, builder);
          diff = b.diff;
          deps.emit?.({ type: 'propose', phase: step.label, ok: b.ok, agentId: builder.id });
          return;
        }
        case 'report': {
          deps.emit?.({ type: 'agent', phase: step.label, kind: 'report', content: findings.length ? `${findings.length} item(s) reported` : 'report assembled' });
          return;
        }
      }
    }, { fallback: undefined, retries: 1, onWarn });

    if (outcome.degraded) degraded = true;
    // §1.3 — persist each phase's artifact by reference (path + sha), don't inline-truncate.
    if (store && artifact && artifact !== lastWritten) { try { await store.write(step.label, 'artifact', artifact); lastWritten = artifact; } catch { /* best-effort */ } }
    deps.emit?.({ type: step.kind === 'lint-gate' ? 'lint' : 'agent', phase: `${step.label} ✓`, kind: step.kind, content: '' });
  }

  const report = buildReport(method, { contract, artifact, findings, scores, warnings, degraded });
  deps.emit?.({ type: 'done', status: degraded ? 'completed-degraded' : 'completed' });
  return {
    methodId: method.id, artifact, contract, findings, report, degraded, warnings, scores, diff,
    seed: { task: deps.task, focus: deps.focus, contract, artifacts: [artifact] },
  };
}

function buildReport(method: Method, r: { contract: string; artifact: string; findings: string[]; scores: { agentId: string; verdict: string }[]; warnings: string[]; degraded: boolean }): string {
  const parts = [`# ${method.name} — report`];
  if (r.degraded) parts.push('> ⚠ DEGRADED — one or more phases fell back; results may be partial.');
  if (r.contract) parts.push(`## Contract / rubric\n${r.contract}`);
  parts.push(`## Final artifact\n${r.artifact || '(none)'}`);
  if (r.findings.length) parts.push(`## UNRESOLVED findings\n${r.findings.join('\n')}`);
  if (r.scores.length) parts.push(`## Judge scores\n${r.scores.map((s) => `- ${s.agentId}: ${s.verdict}`).join('\n')}`);
  if (r.warnings.length) parts.push(`## Warnings (dropped advisors / coverage gaps)\n${r.warnings.map((w) => `- ${w}`).join('\n')}`);
  return parts.join('\n\n');
}

// ----------------------------- §3/§4 method registry -----------------------------

export const METHODS: Record<string, Method> = {
  foundry: {
    id: 'foundry', name: 'FOUNDRY', use: 'hard problems with a checkable deliverable — evaluators, modules, algorithms with tests.',
    summary: 'criteria + golden tests first; 5 models draft in parallel; rotating critics tear down; authors repair; Claude merges to one artifact; a FREE gate lints + compiles + runs the tests; panel QA; Codex judges blind. Errors trigger repair loops, never a hard stop.',
    endPrompt: 'Ship this build? [apply diff / open PR / discard]', budget: '~3 Claude, ~2 Codex',
    phases: [
      { kind: 'frame', label: 'Frame', role: 'framer' },
      { kind: 'diverge', label: 'Diverge', role: 'diverger', count: 5 },
      { kind: 'gauntlet', label: 'Gauntlet', role: 'critic', count: 3, rotated: true },
      { kind: 'repair', label: 'Repair', role: 'repair-hand' },
      { kind: 'consolidate', label: 'Consolidate', role: 'consolidator' },
      { kind: 'lint-gate', label: 'Hard gate' },
      { kind: 'qa', label: 'Panel QA' },
      { kind: 'judge', label: 'Blind judge', judges: 1, tiebreak: true, blind: true },
      { kind: 'build', label: 'Build', role: 'builder' },
    ],
  },
  'foundry-design': {
    id: 'foundry-design', name: 'FOUNDRY-DESIGN', use: 'architecture, specs, policy/algorithm design — the deliverable is a document.',
    summary: 'rubric + invariant laws first; 4 models design in parallel; rotating critics; Claude merges to one design; a FREE consistency lint; panel review; THREE blind judges score (consensus = confidence). Repair loops, no hard stop.',
    endPrompt: 'Write a bootstrap to implement this design? [yes / refine first / no]', budget: '~3 Claude, ~1 Codex',
    phases: [
      { kind: 'frame', label: 'Frame (rubric)' },
      { kind: 'diverge', label: 'Diverge', role: 'diverger', count: 4 },
      { kind: 'gauntlet', label: 'Gauntlet', role: 'critic', count: 3, rotated: true },
      { kind: 'repair', label: 'Repair', role: 'repair-hand' },
      { kind: 'consolidate', label: 'Consolidate', role: 'consolidator' },
      { kind: 'lint-gate', label: 'Consistency lint' },
      { kind: 'qa', label: 'Panel QA' },
      { kind: 'judge', label: 'Triple blind judge', judges: 3, tiebreak: true, blind: true },
    ],
  },
  assay: {
    id: 'assay', name: 'ASSAY', use: '"is this codebase sound?" — logic bugs, weak error-handling, perf/security, dead code, doc drift.',
    summary: 'maps the repo (Atlas if available); five specialists each sweep a different lens; findings merged and ranked by severity-vs-effort; EACH issue verified against real code before reporting (no phantom findings).',
    endPrompt: 'Write a bootstrap to fix/add these? [all / pick which / none]', budget: '~1 Claude, ~1 Codex',
    phases: [
      { kind: 'ingest', label: 'Ingest' },
      { kind: 'scope', label: 'Scope' },
      { kind: 'gauntlet', label: 'Specialist sweep', role: 'critic', count: 5 },
      { kind: 'consolidate', label: 'Dedup + rank', role: 'consolidator' },
      { kind: 'verify', label: 'Verify' },
      { kind: 'report', label: 'Report' },
    ],
  },
  prospect: {
    id: 'prospect', name: 'PROSPECT', use: '"what should I add to this repo?" — high-value features, missing infra, quick wins that fit the architecture.',
    summary: 'reads the repo (Atlas if available); five models brainstorm from different angles (bold / pragmatic / DX / perf / quick wins); ideas stress-tested for fit, effort, risk; clustered and ranked by value-vs-feasibility.',
    endPrompt: 'Build these? [pick which]', budget: '~1 Claude, 0 Codex',
    phases: [
      { kind: 'ingest', label: 'Ingest' },
      { kind: 'ideate', label: 'Ideate', role: 'ideator', count: 5 },
      { kind: 'gauntlet', label: 'Feasibility gauntlet', role: 'critic', count: 2, rotated: true },
      { kind: 'cluster', label: 'Cluster + rank', role: 'consolidator' },
      { kind: 'report', label: 'Present' },
    ],
  },
  relay: {
    id: 'relay', name: 'RELAY', use: 'fast linear chain for tasks not worth the full tournament.',
    summary: 'Ollama draft → a different Ollama critic → Ollama repair → Claude ×1 consolidate + free lint gate → build.',
    endPrompt: 'Ship this build? [apply diff / open PR / discard]', budget: '~4 Ollama + 1 Claude',
    phases: [
      { kind: 'diverge', label: 'Draft', role: 'diverger', count: 1 },
      { kind: 'gauntlet', label: 'Critic', role: 'critic', count: 1, rotated: true },
      { kind: 'repair', label: 'Repair', role: 'repair-hand' },
      { kind: 'consolidate', label: 'Consolidate', role: 'consolidator' },
      { kind: 'lint-gate', label: 'Gate' },
      { kind: 'build', label: 'Build', role: 'builder' },
    ],
  },
  scatter: {
    id: 'scatter', name: 'SCATTER', use: '"what should we even build" — maximize divergence, refuse to converge.',
    summary: 'all reachable agents (Gemini cranked) generate deliberately different architectural bets in parallel → Claude ×1 clusters into 2–3 directions with tradeoffs → human picks. No QA, no winner forced.',
    endPrompt: 'Pick a direction to pursue. [pick which]', budget: '~6–8 Ollama + 1 Claude',
    phases: [
      { kind: 'diverge', label: 'Scatter', role: 'diverger', count: 8 },
      { kind: 'cluster', label: 'Cluster into directions', role: 'consolidator' },
      { kind: 'report', label: 'Present', },
    ],
  },
};

/** §4 — the printed description block shown to the user when a method starts. */
export function printMethodCard(method: Method): string {
  return [
    `${method.name} — ${methodTagline(method.id)}`,
    `Use for: ${method.use}`,
    `Runs: ${method.summary}`,
    `Ends asking: ${method.endPrompt}`,
    `Budget: ${method.budget}`,
  ].join('\n');
}

function methodTagline(id: string): string {
  switch (id) {
    case 'foundry': return 'multi-agent build (design + code)';
    case 'foundry-design': return 'multi-agent design synthesis (no build target)';
    case 'assay': return 'repo health audit';
    case 'prospect': return 'find new things worth building';
    case 'relay': return 'fast linear chain';
    case 'scatter': return 'greenfield divergence';
    default: return 'fusion method';
  }
}
