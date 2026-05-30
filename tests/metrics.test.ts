import { describe, it, expect } from 'vitest';
import { newMetrics, recordDelta, finalize, view, formatView, countTokens } from '../src/lib/metrics';

describe('metrics.countTokens', () => {
  it('returns 0 for empty / whitespace input', () => {
    expect(countTokens('')).toBe(0);
    expect(countTokens('   \n\t  ')).toBe(0);
  });
  it('counts whitespace-separated runs', () => {
    expect(countTokens('hello world')).toBe(2);
    expect(countTokens('  one   two  three  ')).toBe(3);
  });
});

describe('metrics streaming snapshot', () => {
  it('does not move firstTokenAt after it is set', () => {
    const m0 = newMetrics();
    const m1 = recordDelta(m0, 'hello');
    const first = m1.firstTokenAt!;
    const m2 = recordDelta(m1, 'world');
    expect(m2.firstTokenAt).toBe(first);
    expect(m2.tokens).toBe(2);
  });

  it('ignores empty deltas (no firstTokenAt, no token count change)', () => {
    const m0 = newMetrics();
    const m1 = recordDelta(m0, '');
    expect(m1.firstTokenAt).toBeUndefined();
    expect(m1.tokens).toBe(0);
  });

  it('view: tokensPerSec is 0 when no tokens', () => {
    const m = finalize(newMetrics());
    const v = view(m);
    expect(v.tokens).toBe(0);
    expect(v.tokensPerSec).toBe(0);
  });

  it('formatView contains tok and tok/s', () => {
    const m = recordDelta(newMetrics(), 'a b c');
    const out = formatView(view(finalize(m)));
    expect(out).toMatch(/3 tok/);
    expect(out).toMatch(/tok\/s/);
  });
});
