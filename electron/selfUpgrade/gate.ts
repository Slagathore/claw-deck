import * as path from 'path';
import { auditDirectory, AuditReport, Finding } from '../lib/scanner';
import { run, which } from './exec';

export interface GateResult {
  ok: boolean;
  reasons: string[];
  baseline: { critical: number; high: number };
  patched: { critical: number; high: number };
  newCritical: Finding[];
  newHigh: Finding[];
  typecheck?: { ok: boolean; output: string };
  tests?: { ok: boolean; output: string };
}

function fingerprint(f: Finding): string {
  return `${f.rule}::${f.file}::${(f.snippet || '').slice(0, 80)}`;
}

function diffFindings(baseline: AuditReport, patched: AuditReport, sev: 'critical' | 'high'): Finding[] {
  const baseSet = new Set(baseline.findings.filter(x => x.severity === sev).map(fingerprint));
  return patched.findings.filter(x => x.severity === sev && !baseSet.has(fingerprint(x)));
}

export async function runGate(opts: {
  root: string;
  baseline: AuditReport;
  runTypecheck?: boolean;
  runTests?: boolean;
  npmBinary?: string;
}): Promise<GateResult> {
  const reasons: string[] = [];
  const patched = await auditDirectory(opts.root);
  const newCritical = diffFindings(opts.baseline, patched, 'critical');
  const newHigh = diffFindings(opts.baseline, patched, 'high');
  if (newCritical.length) reasons.push(`${newCritical.length} new critical finding(s)`);
  if (newHigh.length) reasons.push(`${newHigh.length} new high finding(s)`);

  let typecheck: GateResult['typecheck'];
  let tests: GateResult['tests'];

  const npm = opts.npmBinary || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const hasNpm = await which(npm);

  if (opts.runTypecheck) {
    if (!hasNpm) {
      typecheck = { ok: false, output: 'npm not found on PATH' };
      reasons.push('npm not available for typecheck');
    } else {
      const r = await run(npm, ['run', 'lint'], { cwd: opts.root, timeoutMs: 180000 });
      typecheck = { ok: r.ok, output: (r.stdout + r.stderr).slice(-4000) };
      if (!r.ok) reasons.push('typecheck failed');
    }
  }

  if (opts.runTests) {
    if (!hasNpm) {
      tests = { ok: false, output: 'npm not found on PATH' };
      reasons.push('npm not available for tests');
    } else {
      const r = await run(npm, ['test', '--silent'], { cwd: opts.root, timeoutMs: 300000 });
      tests = { ok: r.ok, output: (r.stdout + r.stderr).slice(-6000) };
      if (!r.ok) reasons.push('tests failed');
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    baseline: { critical: opts.baseline.summary.critical, high: opts.baseline.summary.high },
    patched: { critical: patched.summary.critical, high: patched.summary.high },
    newCritical,
    newHigh,
    typecheck,
    tests
  };
}

export async function baselineAudit(root: string): Promise<AuditReport> {
  return auditDirectory(root);
}

// Re-export for caller convenience.
export { auditDirectory };
export type { AuditReport, Finding };
export const _resolveBin = (root: string, bin: string) => path.join(root, 'node_modules', '.bin', bin);
