import * as path from 'path';
import * as fs from 'fs';
import { auditDirectory, type AuditReport, type Finding } from '../lib/scanner';
import { run, which } from './exec';

/**
 * The gate a patch must pass before it can go live.
 *
 * It runs in one of two honest modes:
 *
 *  - 'full'    — the source tree has node_modules and npm is on PATH (dev, or a
 *                packaged install where the user clicked "Prepare deps"): the
 *                real `npm run lint` and `npm test` run, exactly as before.
 *  - 'reduced' — a packaged install with no toolchain in the writable source
 *                tree. npm/vitest/tsc simply are not there, so we do NOT pretend
 *                they ran: the security-scan delta runs here, and the pipeline
 *                adds a real esbuild bundle of the patched tree plus a
 *                child-process boot probe of that bundle. Whatever could not run
 *                is listed in `skipped`, and the UI prints that list verbatim.
 *
 * The one thing this must never do is claim a check passed when it never ran.
 */

export type GateMode = 'full' | 'reduced';

export interface GateResult {
  ok: boolean;
  reasons: string[];
  mode: GateMode;
  ran: string[];
  skipped: { check: string; reason: string }[];
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

/** Pure: which gate we are entitled to claim we ran. */
export function gateMode(caps: { npm: boolean; nodeModules: boolean }): GateMode {
  return caps.npm && caps.nodeModules ? 'full' : 'reduced';
}

export async function gateCapabilities(root: string, npmBinary?: string): Promise<{ npm: boolean; nodeModules: boolean }> {
  const npm = npmBinary || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return {
    npm: await which(npm),
    nodeModules: fs.existsSync(path.join(root, 'node_modules'))
  };
}

export async function runGate(opts: {
  root: string;
  baseline: AuditReport;
  runTypecheck?: boolean;
  runTests?: boolean;
  npmBinary?: string;
}): Promise<GateResult> {
  const reasons: string[] = [];
  const ran: string[] = ['security-scan-delta'];
  const skipped: { check: string; reason: string }[] = [];

  const patched = await auditDirectory(opts.root);
  const newCritical = diffFindings(opts.baseline, patched, 'critical');
  const newHigh = diffFindings(opts.baseline, patched, 'high');
  if (newCritical.length) reasons.push(`${newCritical.length} new critical finding(s)`);
  if (newHigh.length) reasons.push(`${newHigh.length} new high finding(s)`);

  let typecheck: GateResult['typecheck'];
  let tests: GateResult['tests'];

  const npm = opts.npmBinary || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const caps = await gateCapabilities(opts.root, npm);
  const mode = gateMode(caps);
  const missing = !caps.npm
    ? 'npm is not on PATH'
    : `the source tree at ${opts.root} has no node_modules — click "Prepare deps" to install them and get the full gate`;

  if (opts.runTypecheck) {
    if (mode === 'reduced') {
      skipped.push({ check: 'typecheck (tsc)', reason: missing });
    } else {
      const r = await run(npm, ['run', 'lint'], { cwd: opts.root, timeoutMs: 180000 });
      typecheck = { ok: r.ok, output: (r.stdout + r.stderr).slice(-4000) };
      ran.push('typecheck (tsc)');
      if (!r.ok) reasons.push('typecheck failed');
    }
  }

  if (opts.runTests) {
    if (mode === 'reduced') {
      skipped.push({ check: 'unit tests (vitest)', reason: missing });
    } else {
      const r = await run(npm, ['test', '--silent'], { cwd: opts.root, timeoutMs: 300000 });
      tests = { ok: r.ok, output: (r.stdout + r.stderr).slice(-6000) };
      ran.push('unit tests (vitest)');
      if (!r.ok) reasons.push('tests failed');
    }
  }

  return {
    ok: reasons.length === 0,
    reasons,
    mode,
    ran,
    skipped,
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

/** One-line, honest summary of what the gate actually proved. */
export function describeGate(g: GateResult): string {
  const ranPart = g.ran.length ? `ran: ${g.ran.join(', ')}` : 'ran: nothing';
  const skipPart = g.skipped.length ? `; skipped: ${g.skipped.map(s => s.check).join(', ')}` : '';
  return `${g.mode} gate — ${ranPart}${skipPart}`;
}

// Re-export for caller convenience.
export { auditDirectory };
export type { AuditReport, Finding };
export const _resolveBin = (root: string, bin: string) => path.join(root, 'node_modules', '.bin', bin);
