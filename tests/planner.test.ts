import { describe, it, expect } from 'vitest';
import {
  parsePlan, extractPlanJson, describeStep, isDestructive, PLANNER_SYSTEM_PROMPT
} from '../src/lib/planner';

describe('planner.extractPlanJson', () => {
  it('returns null for empty text', () => {
    expect(extractPlanJson('').json).toBeNull();
  });

  it('extracts fenced ```json block', () => {
    const text = 'Here you go:\n```json\n{"summary":"x","steps":[]}\n```\nDone.';
    const r = extractPlanJson(text);
    expect(r.json).toBe('{"summary":"x","steps":[]}');
  });

  it('extracts unfenced balanced JSON object', () => {
    const text = 'Explanation. {"summary":"x","steps":[]} trailing';
    const r = extractPlanJson(text);
    expect(JSON.parse(r.json!)).toEqual({ summary: 'x', steps: [] });
  });

  it('handles braces inside string literals', () => {
    const text = '```json\n{"summary":"with } brace","steps":[]}\n```';
    const r = extractPlanJson(text);
    expect(JSON.parse(r.json!).summary).toBe('with } brace');
  });

  it('handles nested objects', () => {
    const text = '{"summary":"x","steps":[{"type":"setSetting","key":"a","value":{"nested":1}}]}';
    const r = extractPlanJson(text);
    expect(JSON.parse(r.json!).steps[0].value.nested).toBe(1);
  });
});

describe('planner.parsePlan', () => {
  it('parses a valid plan', () => {
    const out = parsePlan('```json\n{"summary":"pull qwen","steps":[{"type":"pullModel","model":"qwen2.5:7b"}]}\n```');
    expect(out.ok).toBe(true);
    expect(out.plan!.steps).toHaveLength(1);
    expect(out.plan!.summary).toBe('pull qwen');
  });

  it('rejects missing summary', () => {
    const out = parsePlan('{"steps":[]}');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/summary/);
  });

  it('rejects non-array steps', () => {
    const out = parsePlan('{"summary":"x","steps":"nope"}');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/array/);
  });

  it('rejects unknown step type', () => {
    const out = parsePlan('{"summary":"x","steps":[{"type":"deleteFile","path":"/"}]}');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/unknown type/);
  });

  it('rejects missing per-type fields', () => {
    const out = parsePlan('{"summary":"x","steps":[{"type":"pullModel"}]}');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/pullModel\.model/);
  });

  it('reports explanation intent when no JSON present', () => {
    const out = parsePlan('Just an explanation, no plan.');
    expect(out.ok).toBe(false);
    expect(out.intent).toBe('explanation');
  });

  it('accepts every supported step type', () => {
    const plan = {
      summary: 'sample',
      steps: [
        { type: 'pullModel', model: 'llama3.2' },
        { type: 'setSetting', key: 'chatModel', value: 'llama3.2' },
        { type: 'addMcpServer', name: 'fs', command: 'npx', args: ['x'] },
        { type: 'shell', command: 'git', args: ['status'] },
        { type: 'openTab', tab: 'settings' },
        { type: 'webFetch', url: 'https://example.com' },
        { type: 'note', text: 'fyi' }
      ]
    };
    const out = parsePlan(JSON.stringify(plan));
    expect(out.ok).toBe(true);
    expect(out.plan!.steps).toHaveLength(7);
  });

  it('rejects invalid JSON', () => {
    const out = parsePlan('```json\n{not json}\n```');
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/Invalid JSON/);
  });
});

describe('planner.describeStep', () => {
  it('formats every step type as non-empty text', () => {
    const samples = [
      { type: 'pullModel', model: 'llama3.2' },
      { type: 'setSetting', key: 'k', value: 1 },
      { type: 'addMcpServer', name: 'a', command: 'npx', args: ['b'] },
      { type: 'shell', command: 'git', args: ['status'] },
      { type: 'openTab', tab: 'chat' },
      { type: 'webFetch', url: 'https://x.com' },
      { type: 'note', text: 'hi' }
    ] as const;
    for (const s of samples) {
      const d = describeStep(s as any);
      expect(d.length).toBeGreaterThan(3);
    }
  });
});

describe('planner.isDestructive', () => {
  it('marks state-changing steps destructive', () => {
    expect(isDestructive({ type: 'shell', command: 'git', args: [] } as any)).toBe(true);
    expect(isDestructive({ type: 'pullModel', model: 'x' } as any)).toBe(true);
    expect(isDestructive({ type: 'setSetting', key: 'k', value: 1 } as any)).toBe(true);
    expect(isDestructive({ type: 'addMcpServer', name: 'x', command: 'npx' } as any)).toBe(true);
  });

  it('marks informational steps non-destructive', () => {
    expect(isDestructive({ type: 'note', text: 'x' } as any)).toBe(false);
    expect(isDestructive({ type: 'openTab', tab: 'chat' } as any)).toBe(false);
    expect(isDestructive({ type: 'webFetch', url: 'https://x' } as any)).toBe(false);
  });
});

describe('planner.PLANNER_SYSTEM_PROMPT', () => {
  it('mentions every step type', () => {
    for (const t of ['pullModel', 'setSetting', 'addMcpServer', 'shell', 'openTab', 'webFetch', 'note']) {
      expect(PLANNER_SYSTEM_PROMPT).toContain(t);
    }
  });
});
