import { describe, it, expect } from 'vitest';
import { advisorKey, eligibleFor, pickAdvisors, makeBudget } from '../electron/council/roles';
import { RosterAgent } from '../electron/council/agents';

const A = (id: string, model: string, transport = 'ollama-cloud', canEdit = false): RosterAgent =>
  ({ id, displayName: id, transport: transport as any, model, capabilities: { canEdit, canRunTools: false, costTier: 'cheap' } });

const KIMI = A('kimi-k2', 'kimi-k2.7-code:cloud');
const QWEN35 = A('qwen3-5', 'qwen3.5:397b-cloud');
const QCODER = A('qwen3-coder', 'qwen3-coder:480b-cloud', 'ollama-cloud', true);
const GEMINI = A('gemini3-flash', 'gemini-3-flash-preview:cloud');
const DEEPSEEK = A('deepseek', 'deepseek-v4-pro:cloud');
const CLAUDE = A('claude-code', 'claude', 'claude-code', true);
const CODEX = A('codex', 'codex', 'codex', true);

describe('fusion roles — §1.1 eligibility', () => {
  it('classifies advisors to canonical keys', () => {
    expect(advisorKey(KIMI)).toBe('kimi');
    expect(advisorKey(QWEN35)).toBe('qwen35');
    expect(advisorKey(QCODER)).toBe('qwen-coder');
    expect(advisorKey(GEMINI)).toBe('gemini-hot');
    expect(advisorKey(DEEPSEEK)).toBe('deepseek');
    expect(advisorKey(CLAUDE)).toBe('claude');
    expect(advisorKey(CODEX)).toBe('codex');
    expect(advisorKey(A('oc', 'openclaw', 'openclaw'))).toBe('unknown');
  });

  // The hard bans the acceptance checklist calls out explicitly.
  it('Qwen-Coder may NEVER be critic / red-team', () => {
    expect(eligibleFor(QCODER, 'critic')).toBe(false);
    expect(eligibleFor(QCODER, 'red-team')).toBe(false);
    expect(eligibleFor(QCODER, 'builder')).toBe(true);   // but is a strong builder
  });

  it('Gemini@1.1 may NEVER build / final-qa / consolidate / judge', () => {
    for (const role of ['builder', 'final-qa', 'consolidator', 'judge', 'judge-primary'] as const) {
      expect(eligibleFor(GEMINI, role)).toBe(false);
    }
    expect(eligibleFor(GEMINI, 'diverger')).toBe(true);
    expect(eligibleFor(GEMINI, 'wildcard-critic')).toBe(true);
  });

  it('deepseek may NEVER do whole-doc QA, but may do focused (chunked) QA', () => {
    expect(eligibleFor(DEEPSEEK, 'qa-wholedoc')).toBe(false);
    expect(eligibleFor(DEEPSEEK, 'qa-focused')).toBe(true);
  });

  it('whole-doc QA is limited to large-context models', () => {
    expect(eligibleFor(KIMI, 'qa-wholedoc')).toBe(true);
    expect(eligibleFor(QCODER, 'qa-wholedoc')).toBe(true);
    expect(eligibleFor(GEMINI, 'qa-wholedoc')).toBe(false);
  });
});

describe('fusion roles — assignment + rotation', () => {
  const ALL = [KIMI, QWEN35, QCODER, GEMINI, DEEPSEEK, CLAUDE, CODEX];

  it('pickAdvisors returns only eligible advisors for the role', () => {
    const { picks } = pickAdvisors(ALL, 'critic', 3);
    const ids = picks.map((p) => p.id);
    expect(ids).not.toContain('qwen3-coder'); // banned as critic
    expect(ids.length).toBe(3);
  });

  it('rotation: a critic never reviews its own draft (exclude author)', () => {
    const { picks } = pickAdvisors(ALL, 'critic', 2, { exclude: ['kimi-k2'] });
    expect(picks.map((p) => p.id)).not.toContain('kimi-k2');
  });

  it('returns a coverage-gap warning when too few advisors are eligible', () => {
    const { picks, warning } = pickAdvisors([GEMINI], 'builder', 2); // gemini can't build
    expect(picks.length).toBe(0);
    expect(warning).toMatch(/coverage gap/);
  });
});

describe('fusion roles — trusted-call budget', () => {
  it('caps Claude and Codex at 10, reports over-budget without throwing', () => {
    const b = makeBudget(10, 10);
    for (let i = 0; i < 10; i++) expect(b.charge(CLAUDE)).toBe('ok');
    expect(b.charge(CLAUDE)).toBe('over');           // 11th Claude call
    expect(b.spent().claude).toBe(11);
    expect(b.canAfford(CLAUDE)).toBe(false);
  });

  it('does not cap free (Ollama) advisors', () => {
    const b = makeBudget(10, 10);
    for (let i = 0; i < 50; i++) expect(b.charge(KIMI)).toBe('ok');
    expect(b.canAfford(KIMI)).toBe(true);
  });
});
