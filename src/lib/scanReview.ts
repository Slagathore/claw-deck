/**
 * Pure helpers for reviewing scanner findings and applying a per-finding
 * allowlist (so a known false-positive doesn't keep blocking something you
 * trust). Fingerprints use the finding's RELATIVE file path (the scanner emits
 * `path.relative(root, ...)`), so they stay stable across re-scans even though
 * each scan runs from a fresh quarantine temp dir.
 */

export interface ScanFinding {
  rule: string;
  file: string;
  snippet?: string;
  severity: string;
  line?: number;
}

export type SeverityCounts = { info: number; low: number; medium: number; high: number; critical: number };

/** Stable identity for a finding: rule + relative file + snippet prefix. */
export function findingFingerprint(f: ScanFinding): string {
  return `${f.rule}::${f.file}::${(f.snippet ?? '').slice(0, 120)}`;
}

/** Severity counts excluding any allowlisted (ignored) findings. */
export function effectiveSummary(findings: ScanFinding[], allowlist: ReadonlySet<string>): SeverityCounts {
  const sum: SeverityCounts = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) {
    if (allowlist.has(findingFingerprint(f))) continue;
    if (f.severity in sum) (sum as any)[f.severity]++;
  }
  return sum;
}

/** How many findings are currently ignored by the allowlist. */
export function ignoredCount(findings: ScanFinding[], allowlist: ReadonlySet<string>): number {
  let n = 0;
  for (const f of findings) if (allowlist.has(findingFingerprint(f))) n++;
  return n;
}

/** Risky = has unignored critical or high findings. */
export function isRisky(findings: ScanFinding[], allowlist: ReadonlySet<string>): boolean {
  const s = effectiveSummary(findings, allowlist);
  return s.critical + s.high > 0;
}

/** Add or remove a fingerprint from an allowlist array (returns a new array). */
export function toggleAllowlist(allowlist: readonly string[], fp: string): string[] {
  return allowlist.includes(fp) ? allowlist.filter(x => x !== fp) : [...allowlist, fp];
}
