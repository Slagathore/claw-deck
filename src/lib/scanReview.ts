/**
 * Pure helpers for reviewing scanner findings and applying a per-finding
 * allowlist (so a known false-positive doesn't keep blocking something you
 * trust). Fingerprints are SCOPED to a specific skill/package and use the
 * finding's RELATIVE file path (the scanner emits `path.relative(root, ...)`),
 * so:
 *   - ignoring a finding in one skill does NOT silence the same pattern in
 *     another (the scope differs), and
 *   - the entry stays stable across re-scans even though each scan runs from a
 *     fresh quarantine temp dir (the relative path is unchanged).
 *
 * `scope` is a stable id for the thing scanned, e.g. "skill:sonoscli",
 * "plugin:openclaw/lobster", "mcp:@modelcontextprotocol/server-filesystem".
 */

export interface ScanFinding {
  rule: string;
  file: string;
  snippet?: string;
  severity: string;
  line?: number;
}

export type Severity = 'info' | 'low' | 'medium' | 'high' | 'critical';
export type OverrideSeverity = Severity | 'off';
export interface RuleOverride { severity: OverrideSeverity; note?: string; }
/** Global per-rule severity overrides (downgrade/disable a noisy rule). */
export type RuleOverrides = Record<string, RuleOverride>;

export type SeverityCounts = { info: number; low: number; medium: number; high: number; critical: number };

/** A finding's effective severity after applying any global rule override. */
export function effectiveSeverity(f: ScanFinding, overrides: RuleOverrides = {}): OverrideSeverity {
  return overrides[f.rule]?.severity ?? (f.severity as Severity);
}

/** Scoped, stable identity for a finding: scope + rule + relative file + snippet. */
export function findingFingerprint(scope: string, f: ScanFinding): string {
  return `${scope}::${f.rule}::${f.file}::${(f.snippet ?? '').slice(0, 120)}`;
}

/** Severity counts excluding allowlisted (ignored) findings and rules overridden to 'off'. */
export function effectiveSummary(scope: string, findings: ScanFinding[], allowlist: ReadonlySet<string>, overrides: RuleOverrides = {}): SeverityCounts {
  const sum: SeverityCounts = { info: 0, low: 0, medium: 0, high: 0, critical: 0 };
  for (const f of findings) {
    if (allowlist.has(findingFingerprint(scope, f))) continue;
    const sev = effectiveSeverity(f, overrides);
    if (sev === 'off') continue;
    sum[sev]++;
  }
  return sum;
}

/** How many findings are currently ignored by the (scoped) allowlist. */
export function ignoredCount(scope: string, findings: ScanFinding[], allowlist: ReadonlySet<string>): number {
  let n = 0;
  for (const f of findings) if (allowlist.has(findingFingerprint(scope, f))) n++;
  return n;
}

/** Risky = has unignored critical or high findings (after overrides). */
export function isRisky(scope: string, findings: ScanFinding[], allowlist: ReadonlySet<string>, overrides: RuleOverrides = {}): boolean {
  const s = effectiveSummary(scope, findings, allowlist, overrides);
  return s.critical + s.high > 0;
}

/** Worst active severity in a counts object, or 'clean'. */
export function worstSeverity(c: SeverityCounts): Severity | 'clean' {
  if (c.critical > 0) return 'critical';
  if (c.high > 0) return 'high';
  if (c.medium > 0) return 'medium';
  if (c.low > 0) return 'low';
  if (c.info > 0) return 'info';
  return 'clean';
}

/** Add or remove a fingerprint from an allowlist array (returns a new array). */
export function toggleAllowlist(allowlist: readonly string[], fp: string): string[] {
  return allowlist.includes(fp) ? allowlist.filter(x => x !== fp) : [...allowlist, fp];
}
