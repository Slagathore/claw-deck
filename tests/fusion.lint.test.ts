import { describe, it, expect } from 'vitest';
import { lintArtifact, formatFindings } from '../electron/council/fusionLint';

const rules = (t: string, source?: string) => lintArtifact(t, { source }).findings.map((f) => f.rule);

describe('fusionLint — deterministic pre-gate', () => {
  it('clean prose + closed code fence passes with zero blocking findings', () => {
    const r = lintArtifact('# Design\n\nUses a heap.\n\n```ts\nfunction f(a: number) { return a + 1; }\n```\n');
    expect(r.passed).toBe(true);
    expect(r.blockCount).toBe(0);
  });

  // §1.4 — the bounce cause: an artifact inline-truncated into the QA prompt.
  it('flags handoff-truncation when received is materially shorter than source', () => {
    const source = 'x'.repeat(1000);
    const received = 'x'.repeat(150); // ~15%, the SporeSpore signature
    expect(rules(received, source)).toContain('handoff-truncation');
  });

  it('flags truncation-midtoken when the artifact ends inside an inline-code span', () => {
    // the literal tail from the run: "...happens in `val"
    expect(rules('The clamp happens in `val')).toContain('truncation-midtoken');
  });

  it('flags truncation-dangling when the artifact ends on a dangling operator', () => {
    expect(rules('const total = a +')).toContain('truncation-dangling');
  });

  // dead-code-before-correcting-comment, Pattern A (inside code).
  it('flags dead-code-correction: a value line with a self-doubt comment', () => {
    const art = '```gdscript\nreturn Vector3(-e.y, -e.y, e.z)   # BUG: should be e.x\n```\n';
    expect(rules(art)).toContain('dead-code-correction');
  });

  // dead-code-before-correcting-comment, Pattern B (CORRECTION prose after code).
  it('flags dead-code-correction-prose: a CORRECTION note following a code fence', () => {
    const art = '```ts\nconst x = wrongValue;\n```\n\n**CORRECTION**: that should have been rightValue.\n';
    expect(rules(art)).toContain('dead-code-correction-prose');
  });

  it('flags code-fence-unclosed when a fence never closes before EOF', () => {
    const art = 'Here is the fix:\n```ts\nfunction g() {\n  return 1;\n';
    expect(rules(art)).toContain('code-fence-unclosed');
  });

  it('flags bracket-imbalance on a truncated function body', () => {
    const art = '```ts\nfunction h(a, b {\n  return a;\n```\n';
    expect(rules(art)).toContain('bracket-imbalance');
  });

  // §1.4 — the real Dijkstra case: changelog claim contradicts the code (warn).
  it('warns on changelog-contradiction: "replaced pop_front with dijkstra" while code still calls pop_front', () => {
    const art = 'Changelog: replaced pop_front with dijkstra for shortest path.\n\n```py\nnode = queue.pop_front()\n```\n';
    const r = lintArtifact(art);
    expect(r.findings.map((f) => f.rule)).toContain('changelog-contradiction');
    expect(r.findings.find((f) => f.rule === 'changelog-contradiction')?.severity).toBe('warn');
  });

  it('warns (not blocks) on "removed X" while X still appears', () => {
    const art = 'We removed HEIGHT_REF entirely.\n\n```gd\nvar h = HEIGHT_REF\n```\n';
    const r = lintArtifact(art);
    expect(r.findings.some((f) => f.rule === 'changelog-contradiction')).toBe(true);
    expect(r.passed).toBe(true); // changelog issues are advisory, not blocking
  });

  it('formatFindings renders a compact, block-first report and never throws', () => {
    const r = lintArtifact('const total = a +');
    const out = formatFindings(r);
    expect(out).toMatch(/^LINT: \d+ blocking/);
    expect(out).toContain('truncation-dangling');
  });
});
