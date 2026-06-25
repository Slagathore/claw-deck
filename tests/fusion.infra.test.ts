import { describe, it, expect } from 'vitest';
import { sha12, integrityOk, reviewingHeader, echoMatches, runPhase, boundedRepair } from '../electron/council/fusionInfra';

describe('§1.3 artifact integrity', () => {
  it('sha12 is stable and 12 hex chars', () => {
    expect(sha12('hello')).toBe(sha12('hello'));
    expect(sha12('hello')).toMatch(/^[0-9a-f]{12}$/);
    expect(sha12('hello')).not.toBe(sha12('world'));
  });

  it('integrityOk flags a truncated handoff (the bounce signature)', () => {
    const source = 'x'.repeat(1000);
    expect(integrityOk('x'.repeat(150), source).ok).toBe(false);   // ~15%
    expect(integrityOk(source, source).ok).toBe(true);
    expect(integrityOk('x'.repeat(990), source).ok).toBe(true);    // within 2%
  });

  it('echoMatches accepts a reviewer that echoes the right sha12 and rejects a wrong one', () => {
    const art = 'the full artifact under review';
    const good = `${reviewingHeader(art)}\nLooks correct.`;
    expect(echoMatches(good, art)).toBe(true);
    expect(echoMatches(`REVIEWING: 000000000000 | nope`, art)).toBe(false);
    expect(echoMatches('no header at all', art)).toBe(false);
  });
});

describe('§1.2 runPhase — never aborts', () => {
  it('returns the value on success', async () => {
    const r = await runPhase('ok', async () => 42, { fallback: -1 });
    expect(r.value).toBe(42);
    expect(r.degraded).toBe(false);
  });

  it('retries once then falls back to a degraded value (no throw escapes)', async () => {
    let calls = 0;
    const r = await runPhase('flaky', async () => { calls++; throw new Error('boom'); }, { fallback: 'last-good', retries: 1 });
    expect(calls).toBe(2);                 // initial + 1 retry
    expect(r.value).toBe('last-good');
    expect(r.degraded).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('recovers on the retry when the second attempt succeeds', async () => {
    let calls = 0;
    const r = await runPhase('recovers', async () => { calls++; if (calls === 1) throw new Error('once'); return 'ok'; }, { fallback: 'fb' });
    expect(r.value).toBe('ok');
    expect(r.degraded).toBe(false);
  });
});

describe('§1.2/§1.4 boundedRepair', () => {
  it('returns immediately when the artifact already passes', async () => {
    const r = await boundedRepair('clean', { passed: true, findings: [], report: '' }, async (a) => a, () => ({ passed: true, findings: [], report: '' }));
    expect(r.passed).toBe(true);
    expect(r.rounds).toBe(0);
  });

  it('repairs within the round budget and passes', async () => {
    // recheck passes once the artifact contains "fixed"
    const r = await boundedRepair(
      'broken',
      { passed: false, findings: ['x'], report: 'fix it' },
      async () => 'fixed',
      (a) => ({ passed: a.includes('fixed'), findings: a.includes('fixed') ? [] : ['x'], report: 'still broken' }),
      { maxRounds: 2 },
    );
    expect(r.passed).toBe(true);
    expect(r.rounds).toBe(1);
  });

  it('ships the best artifact with residual findings when still failing after maxRounds (no abort)', async () => {
    const r = await boundedRepair(
      'broken',
      { passed: false, findings: ['x'], report: 'fix it' },
      async (a) => a + '!',                                  // never actually fixes
      () => ({ passed: false, findings: ['still'], report: 'nope' }),
      { maxRounds: 2 },
    );
    expect(r.passed).toBe(false);
    expect(r.rounds).toBe(2);
    expect(r.residual).toEqual(['still']);
    expect(r.artifact).toBe('broken!!');                    // best-effort artifact survives
  });

  it('a throwing repair stops the loop and ships the best artifact (never aborts)', async () => {
    const r = await boundedRepair(
      'broken',
      { passed: false, findings: ['x'], report: 'fix it' },
      async () => { throw new Error('repair model died'); },
      () => ({ passed: false, findings: ['x'], report: 'nope' }),
      { maxRounds: 2 },
    );
    expect(r.passed).toBe(false);
    expect(r.artifact).toBe('broken');
  });
});
