import { describe, it, expect } from 'vitest';
import { findingFingerprint, effectiveSummary, isRisky, ignoredCount, toggleAllowlist, ScanFinding } from '../src/lib/scanReview';

const f = (rule: string, file: string, severity: string, snippet = ''): ScanFinding => ({ rule, file, severity, snippet });

describe('scanReview', () => {
  it('fingerprint is stable for the same scope/rule/relfile/snippet', () => {
    const a = f('child-spawn', 'scripts/run.sh', 'medium', 'spawn(cmd)');
    const b = f('child-spawn', 'scripts/run.sh', 'medium', 'spawn(cmd)');
    expect(findingFingerprint('skill:x', a)).toBe(findingFingerprint('skill:x', b));
    expect(findingFingerprint('skill:x', a)).not.toBe(findingFingerprint('skill:x', f('child-spawn', 'other.js', 'medium', 'spawn(cmd)')));
  });

  it('the same finding in a different scope has a different fingerprint', () => {
    const finding = f('eval-call', 'a.js', 'critical', 'eval(x)');
    expect(findingFingerprint('skill:a', finding)).not.toBe(findingFingerprint('skill:b', finding));
  });

  it('effectiveSummary excludes allowlisted findings for that scope', () => {
    const findings = [f('eval-call', 'a.js', 'critical', 'eval(x)'), f('child-spawn', 'b.js', 'medium', 'spawn(y)')];
    const all = new Set([findingFingerprint('skill:x', findings[0])]);
    const s = effectiveSummary('skill:x', findings, all);
    expect(s.critical).toBe(0);
    expect(s.medium).toBe(1);
  });

  it('an allowlist entry from another scope does NOT excuse this scope', () => {
    const findings = [f('eval-call', 'a.js', 'critical', 'eval(x)')];
    const allOther = new Set([findingFingerprint('skill:other', findings[0])]);
    expect(isRisky('skill:mine', findings, allOther)).toBe(true);
  });

  it('isRisky drops to false once critical/high are ignored in scope', () => {
    const findings = [f('eval-call', 'a.js', 'critical', 'eval(x)')];
    expect(isRisky('skill:x', findings, new Set())).toBe(true);
    expect(isRisky('skill:x', findings, new Set([findingFingerprint('skill:x', findings[0])]))).toBe(false);
  });

  it('low/medium findings are never risky', () => {
    expect(isRisky('skill:x', [f('fetch-call', 'a.js', 'low'), f('child-spawn', 'b.js', 'medium')], new Set())).toBe(false);
  });

  it('ignoredCount counts allowlisted findings in scope', () => {
    const findings = [f('eval-call', 'a.js', 'critical', 'e'), f('child-spawn', 'b.js', 'medium', 's')];
    expect(ignoredCount('skill:x', findings, new Set([findingFingerprint('skill:x', findings[0])]))).toBe(1);
  });

  it('toggleAllowlist adds then removes', () => {
    const fp = findingFingerprint('skill:x', f('eval-call', 'a.js', 'critical', 'e'));
    const added = toggleAllowlist([], fp);
    expect(added).toEqual([fp]);
    expect(toggleAllowlist(added, fp)).toEqual([]);
  });
});
