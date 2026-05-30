import { describe, it, expect } from 'vitest';
import { auditDirectory } from '../electron/lib/scanner';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

// Re-test only the *delta* logic by reimplementing it: gate.ts imports electron via the broader chain,
// so we test the heart of the gate in isolation here.

function fingerprint(f: any): string {
  return `${f.rule}::${f.file}::${(f.snippet || '').slice(0, 80)}`;
}
function diffFindings(baseline: any, patched: any, sev: 'critical' | 'high') {
  const baseSet = new Set(baseline.findings.filter((x: any) => x.severity === sev).map(fingerprint));
  return patched.findings.filter((x: any) => x.severity === sev && !baseSet.has(fingerprint(x)));
}

describe('gate delta scan', () => {
  it('detects newly introduced critical findings vs. baseline', async () => {
    const root = path.join(os.tmpdir(), `claw-deck-gate-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'package.json'), '{"name":"x","version":"0"}');
    await fs.writeFile(path.join(root, 'clean.js'), 'export const x = 1;');

    const baseline = await auditDirectory(root);

    // Introduce eval (critical) — this is exactly what a regression patch might smuggle in.
    await fs.writeFile(path.join(root, 'evil.js'), 'eval("alert(1)");');
    const patched = await auditDirectory(root);

    const newCrit = diffFindings(baseline, patched, 'critical');
    expect(newCrit.length).toBeGreaterThan(0);
    expect(newCrit[0].ruleId === 'eval-call' || newCrit[0].rule === 'eval-call').toBe(true);

    await fs.rm(root, { recursive: true, force: true });
  }, 30000);

  it('does not flag pre-existing findings as new', async () => {
    const root = path.join(os.tmpdir(), `claw-deck-gate2-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'pre.js'), 'eval("already here");');

    const baseline = await auditDirectory(root);
    expect(baseline.summary.critical).toBeGreaterThan(0);

    // No new files, just re-scan.
    const patched = await auditDirectory(root);
    expect(diffFindings(baseline, patched, 'critical').length).toBe(0);

    await fs.rm(root, { recursive: true, force: true });
  }, 30000);
});
