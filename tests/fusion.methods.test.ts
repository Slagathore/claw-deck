import { describe, it, expect } from 'vitest';
import { METHODS, printMethodCard, runMethod, MethodDeps } from '../electron/council/methods';
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

  it('respects the trusted-call budget: an exhausted Claude budget downgrades the consolidate step', async () => {
    // pre-exhaust Claude so the consolidator (Claude) is skipped, not errored
    const { makeBudget } = await import('../electron/council/roles');
    const b = makeBudget(0, 10);
    const r = await runMethod(METHODS.relay, deps({ budget: b }));
    expect(r.warnings.some((w) => /budget reached|keeping concatenated/.test(w))).toBe(true);
  });
});
