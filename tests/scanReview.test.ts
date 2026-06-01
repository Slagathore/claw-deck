import { describe, it, expect } from 'vitest';
import { findingFingerprint, effectiveSummary, isRisky, ignoredCount, toggleAllowlist, ScanFinding } from '../src/lib/scanReview';

const f = (rule: string, file: string, severity: string, snippet = ''): ScanFinding => ({ rule, file, severity, snippet });

describe('scanReview', () => {
  it('fingerprint is stable for the same rule/relfile/snippet', () => {
    const a = f('child-spawn', 'scripts/run.sh', 'medium', 'spawn(cmd)');
    const b = f('child-spawn', 'scripts/run.sh', 'medium', 'spawn(cmd)');
    expect(findingFingerprint(a)).toBe(findingFingerprint(b));
    expect(findingFingerprint(a)).not.toBe(findingFingerprint(f('child-spawn', 'other.js', 'medium', 'spawn(cmd)')));
  });

  it('effectiveSummary excludes allowlisted findings', () => {
    const findings = [f('eval-call', 'a.js', 'critical', 'eval(x)'), f('child-spawn', 'b.js', 'medium', 'spawn(y)')];
    const all = new Set([findingFingerprint(findings[0])]);
    const s = effectiveSummary(findings, all);
    expect(s.critical).toBe(0);
    expect(s.medium).toBe(1);
  });

  it('isRisky drops to false once critical/high are ignored', () => {
    const findings = [f('eval-call', 'a.js', 'critical', 'eval(x)')];
    expect(isRisky(findings, new Set())).toBe(true);
    expect(isRisky(findings, new Set([findingFingerprint(findings[0])]))).toBe(false);
  });

  it('low/medium findings are never risky', () => {
    expect(isRisky([f('fetch-call', 'a.js', 'low'), f('child-spawn', 'b.js', 'medium')], new Set())).toBe(false);
  });

  it('ignoredCount counts allowlisted findings', () => {
    const findings = [f('eval-call', 'a.js', 'critical', 'e'), f('child-spawn', 'b.js', 'medium', 's')];
    expect(ignoredCount(findings, new Set([findingFingerprint(findings[0])]))).toBe(1);
  });

  it('toggleAllowlist adds then removes', () => {
    const fp = findingFingerprint(f('eval-call', 'a.js', 'critical', 'e'));
    const added = toggleAllowlist([], fp);
    expect(added).toEqual([fp]);
    expect(toggleAllowlist(added, fp)).toEqual([]);
  });
});
