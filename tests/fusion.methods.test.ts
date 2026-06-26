import { describe, it, expect } from 'vitest';
import { METHODS, printMethodCard, runMethod, MethodDeps, Method } from '../electron/council/methods';
import { TransportFn } from '../electron/council/run';
import { RosterAgent } from '../electron/council/agents';

const A = (id: string, model: string, transport = 'ollama-cloud', canEdit = false): RosterAgent =>
  ({ id, displayName: id, transport: transport as any, model, capabilities: { canEdit, canRunTools: false, costTier: 'cheap' } });

const ROSTER: RosterAgent[] = [
  A('kimi', 'kimi-k2.7-code:cloud'),
  A('qwen35', 'qwen3.5:397b-cloud'),
  A('qcoder', 'qwen3-coder:480b-cloud', 'ollama-cloud', true),
  A('gemini', 'gemini-3-flash-preview:cloud'),
  A('deepseek', 'deepseek-v4-pro:cloud'),
  A('claude', 'claude', 'claude-code', true),
  A('codex', 'codex', 'codex', true),
];

// Canned transport keyed on the system prompt so each role gets a sensible reply.
const happy: TransportFn = async (_agent, messages) => {
  const sys = messages[0]?.content ?? '';
  if (/framer/i.test(sys)) return 'CONTRACT: must do X; golden: assert Y.';
  if (/drafting INDEPENDENTLY|brainstorming/i.test(sys)) return 'a concrete draft\n```ts\nfunction f(){ return 1; }\n```';
  if (/adversarial critic|stress-testing IDEAS/i.test(sys)) return 'NO_FURTHER_ISSUES';
  if (/repair hand/i.test(sys)) return 'repaired artifact\n```ts\nfunction f(){ return 1; }\n```';
  if (/consolidator/i.test(sys)) return 'ONE consolidated artifact\n```ts\nfunction f(){ return 1; }\n```';
  if (/mapping a repository/i.test(sys)) return 'repo map: modules A, B, C';
  if (/reviewing the FULL|code-correctness/i.test(sys)) return 'NO_BLOCKING_ISSUES';
  if (/verifying findings/i.test(sys)) return 'CONFIRMED: nothing';
  if (/BLIND judge/i.test(sys)) return 'SCORE: 8 — solid against the contract.';
  return 'ok';
};

const deps = (over: Partial<MethodDeps> = {}): MethodDeps => ({ task: 'do a thing', roster: ROSTER, transport: happy, ...over });

describe('§4 registry + printed descriptions', () => {
  it('registers all six methods with the required fields', () => {
    expect(Object.keys(METHODS).sort()).toEqual(['assay', 'foundry', 'foundry-design', 'prospect', 'relay', 'scatter']);
    for (const m of Object.values(METHODS)) {
      expect(m.phases.length).toBeGreaterThan(0);
      expect(m.endPrompt).toBeTruthy();
      expect(m.budget).toBeTruthy();
    }
  });

  it('printMethodCard renders use / runs / ends-asking / budget', () => {
    const card = printMethodCard(METHODS.foundry);
    expect(card).toContain('FOUNDRY');
    expect(card).toMatch(/Use for:/);
    expect(card).toMatch(/Ends asking:/);
    expect(card).toMatch(/Budget:/);
  });
});

describe('§3 runMethod engine', () => {
  it('runs RELAY end-to-end and returns an artifact, report, and a chaining seed', async () => {
    const r = await runMethod(METHODS.relay, deps());
    expect(r.methodId).toBe('relay');
    expect(r.artifact).toContain('consolidated');
    expect(r.report).toContain('Final artifact');
    expect(r.seed.task).toBe('do a thing');
    // no build capability wired → a warning, not an abort
    expect(r.warnings.some((w) => /no build capability/.test(w))).toBe(true);
  });

  it('FOUNDRY produces blind judge scores against the contract', async () => {
    const r = await runMethod(METHODS.foundry, deps());
    expect(r.contract).toContain('CONTRACT');
    expect(r.scores.length).toBeGreaterThanOrEqual(1);
    expect(r.scores[0].verdict).toMatch(/score 8/);
  });

  it('NEVER aborts even if the transport always throws (no-abort contract)', async () => {
    const dead: TransportFn = async () => { throw new Error('all models down'); };
    const r = await runMethod(METHODS.prospect, deps({ transport: dead }));
    expect(r.methodId).toBe('prospect');     // returned a result, did not throw
    expect(r.report).toContain('report');
  });

  it('SCATTER surfaces a coverage-gap warning when it cannot staff 8 divergers', async () => {
    const r = await runMethod(METHODS.scatter, deps());
    expect(r.warnings.some((w) => /coverage gap/.test(w))).toBe(true); // only 5 divergers eligible
  });

  it('ASSAY notes the missing Atlas capability and still completes', async () => {
    const r = await runMethod(METHODS.assay, deps());
    expect(r.warnings.some((w) => /Atlas/.test(w))).toBe(true);
    expect(r.report).toBeTruthy();
  });

  it('§5 chaining: a seed pre-loads the contract and skips re-ingest', async () => {
    const seenPhases: string[] = [];
    const r = await runMethod(METHODS.assay, deps({
      seed: { contract: 'CARRIED CONTRACT from a prior run', artifacts: ['prior artifact body'] },
      emit: (ev) => { if (ev.type === 'phase') seenPhases.push(ev.phase ?? ''); },
    }));
    expect(r.contract).toContain('CARRIED CONTRACT');           // contract carried forward
    expect(r.report).toContain('CARRIED CONTRACT');
    expect(seenPhases).not.toContain('Ingest');                  // ingest step skipped
  });

  it('§1.3 REVIEWING echo: a judge that omits the header triggers a re-feed warning (not a verdict)', async () => {
    // `happy` never echoes REVIEWING → the orchestrator re-feeds once and logs a plumbing warn.
    const r = await runMethod(METHODS.foundry, deps());
    expect(r.warnings.some((w) => /did not echo REVIEWING/.test(w))).toBe(true);
    expect(r.scores.length).toBeGreaterThanOrEqual(1);          // still scored after the re-feed
  });

  it('§3.3 file-read grounding: the audit sweep sees real file source pulled via readFiles', async () => {
    let criticSawSource = false;
    const t: TransportFn = async (_agent, messages) => {
      const sys = messages[0]?.content ?? '';
      const user = messages[messages.length - 1]?.content ?? '';
      if (/adversarial critic/.test(sys)) { criticSawSource = /SECRET_MARKER_42/.test(user); return 'NO_FURTHER_ISSUES'; }
      if (/mapping a repository/.test(sys)) return 'repo map';
      return 'ok';
    };
    const atlasQuery = async () => 'scripts/core/foo.gd:10 — foo (function, active)';
    const readFiles = async () => ({ 'scripts/core/foo.gd': 'func foo():\n\treturn SECRET_MARKER_42' });
    await runMethod(METHODS.assay, deps({ transport: t, atlasQuery, readFiles }));
    expect(criticSawSource).toBe(true);  // the critic audited actual source, not just the summary
  });

  // Post-QA repair gate: every QA reviewer/judge must echo REVIEWING:<sha> (extracted from
  // the prompt's header) so askVerified does not re-feed and drop confidence.
  const QA_JUDGE: Method = { id: 't', name: 'T', use: '', summary: '', endPrompt: '', budget: '', phases: [{ kind: 'qa', label: 'Panel QA' }, { kind: 'judge', label: 'Judge', judges: 1 }] };
  const echoOf = (user: string) => `REVIEWING: ${(user.match(/REVIEWING:\s*([0-9a-f]{12})/i) || [])[1] ?? '000000000000'}`;

  it('QA gate auto-resolves a [FIX] blocker (clean findings, repaired artifact, confidence kept)', async () => {
    const t: TransportFn = async (_a, m) => {
      const sys = m[0]?.content ?? ''; const user = m[m.length - 1]?.content ?? ''; const e = echoOf(user);
      if (/repair hand/i.test(sys)) return 'FIXED_ARTIFACT_V2 — corrected';
      if (/reviewing the FULL/i.test(sys)) return /FIXED_ARTIFACT_V2/.test(user) ? `${e}\nNO_BLOCKING_ISSUES` : `${e}\n- missing return at L3 [FIX]`;
      if (/code-correctness/i.test(sys)) return `${e}\nNO_BLOCKING_ISSUES`;
      if (/BLIND judge/i.test(sys)) return `${e}\nSCORE: 8 ok`;
      return 'x';
    };
    const r = await runMethod(QA_JUDGE, deps({ transport: t, seed: { artifacts: ['initial broken artifact'] } }));
    expect(r.findings.some((f) => /UNRESOLVED|GATE/.test(f))).toBe(false);   // nothing left over
    expect(r.artifact).toContain('FIXED_ARTIFACT_V2');                        // genuinely patched
    expect(r.confidence).not.toBe('low');                                     // no truncation re-feed
    expect(r.humanDecision).toHaveLength(0);
  });

  it('QA gate: a surviving [GATE] blocker → low confidence + human decision, judged anyway', async () => {
    const t: TransportFn = async (_a, m) => {
      const sys = m[0]?.content ?? ''; const user = m[m.length - 1]?.content ?? ''; const e = echoOf(user);
      if (/repair hand/i.test(sys)) return 'attempted fix, invariant still broken';
      if (/reviewing the FULL/i.test(sys)) return `${e}\n- violates invariant X at L9 [GATE]`;   // never clears
      if (/code-correctness/i.test(sys)) return `${e}\nNO_BLOCKING_ISSUES`;
      if (/BLIND judge/i.test(sys)) return `${e}\nSCORE: 3 weak`;
      return 'x';
    };
    const r = await runMethod(QA_JUDGE, deps({ transport: t, seed: { artifacts: ['broken'] } }));
    expect(r.confidence).toBe('low');
    expect(r.humanDecision).toHaveLength(1);
    expect(r.scores.length).toBeGreaterThanOrEqual(1);                        // judged regardless
    expect(r.findings.some((f) => /GATE — human decision/.test(f))).toBe(true);
    expect(r.artifact).not.toContain('[GATE]');                               // blockers never re-stapled to the artifact
  });

  it('QA gate: an UNTAGGED surviving blocker defaults to the human-decision bucket', async () => {
    const t: TransportFn = async (_a, m) => {
      const sys = m[0]?.content ?? ''; const user = m[m.length - 1]?.content ?? ''; const e = echoOf(user);
      if (/repair hand/i.test(sys)) return 'tried';
      if (/reviewing the FULL/i.test(sys)) return `${e}\n- something is off at L2`;   // NO tag
      if (/code-correctness/i.test(sys)) return `${e}\nNO_BLOCKING_ISSUES`;
      if (/BLIND judge/i.test(sys)) return `${e}\nSCORE: 5`;
      return 'x';
    };
    const r = await runMethod(QA_JUDGE, deps({ transport: t, seed: { artifacts: ['broken'] } }));
    expect(r.humanDecision).toHaveLength(1);                                  // untagged → human (safe default)
    expect(r.findings.some((f) => /GATE — human decision/.test(f))).toBe(true);
    expect(r.findings.some((f) => /QA \(UNRESOLVED/.test(f))).toBe(false);    // not the mechanical [FIX] bucket
  });

  it('§1 groundInRepo prepends an ingest phase so a build-method panel sees real code', async () => {
    let divergerSawSource = false;
    const t: TransportFn = async (_a, m) => {
      const sys = m[0]?.content ?? '';
      const user = m[m.length - 1]?.content ?? '';
      if (/drafting INDEPENDENTLY/.test(sys)) { divergerSawSource = /SECRET_MARKER_77/.test(user); return 'draft'; }
      if (/mapping a repository/.test(sys)) return 'repo map';   // the ingest extractor
      return 'ok';
    };
    const atlasQuery = async () => 'scripts/core/foo.gd:10 — foo (function, active)';
    const readFiles = async () => ({ 'scripts/core/foo.gd': 'func foo():\n\treturn SECRET_MARKER_77' });
    const M: Method = { id: 'g', name: 'G', use: '', summary: '', endPrompt: '', budget: '', phases: [{ kind: 'diverge', label: 'Diverge', count: 2 }] };
    await runMethod(M, deps({ transport: t, atlasQuery, readFiles, groundInRepo: true }));
    expect(divergerSawSource).toBe(true);   // a foundry-style method with no ingest now sees the source
  });

  it('respects the trusted-call budget: an exhausted Claude budget downgrades the consolidate step', async () => {
    // pre-exhaust Claude so the consolidator (Claude) is skipped, not errored
    const { makeBudget } = await import('../electron/council/roles');
    const b = makeBudget(0, 10);
    const r = await runMethod(METHODS.relay, deps({ budget: b }));
    expect(r.warnings.some((w) => /budget reached|keeping concatenated/.test(w))).toBe(true);
  });
});
