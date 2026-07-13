import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { PatchSet } from '../electron/selfUpgrade/patcher';

// pipeline.ts broadcasts progress events via `webContents.getAllWebContents()`.
// Under vitest there's no real Electron process, so the `electron` package's
// CJS export is just a string (the path to electron.exe) and that name is
// undefined — stub the one function pipeline.ts actually calls so runPipeline
// is exercisable here. BrowserWindow is imported but unused by pipeline.ts.
const sendSpy = vi.fn();
vi.mock('electron', () => ({
  webContents: { getAllWebContents: () => [{ send: sendSpy }] },
  BrowserWindow: class {}
}));

const { runPipeline } = await import('../electron/selfUpgrade/pipeline');

interface Fixture { root: string; }
const fixtures: Fixture[] = [];

async function makeFixture(opts: { lint?: string; test?: string } = {}): Promise<string> {
  const root = path.join(os.tmpdir(), `claw-deck-pipeline-fixture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'pipeline-fixture', version: '0.0.1',
    scripts: {
      lint: opts.lint ?? 'node -e "process.exit(0)"',
      test: opts.test ?? 'node -e "process.exit(0)"'
    }
  }, null, 2));
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'docs', 'NOTES.md'), 'original notes\n');
  fixtures.push({ root });
  return root;
}

afterEach(async () => {
  sendSpy.mockClear();
  while (fixtures.length) {
    const f = fixtures.pop()!;
    await fs.rm(f.root, { recursive: true, force: true }).catch(() => { /* ignore */ });
  }
});

function eventsOf(): { runId: string; phase: string; status: string; message?: string }[] {
  return sendSpy.mock.calls
    .filter(c => c[0] === 'selfUpgrade:event')
    .map(c => c[1]);
}

describe('runPipeline: honest promote step (H3) + apply-before-gate ordering', () => {
  it('applies a low-risk patch live, and no event implies a paused/manual approval gate', async () => {
    const root = await makeFixture();
    const patch: PatchSet = {
      id: 'low-risk-patch', rationale: 'test',
      files: [{ path: 'docs/NOTES.md', mode: 'replace', contents: 'patched notes\n' }]
    };

    const result = await runPipeline({
      runId: 'test-run-low-risk',
      sourceRoot: root,
      patch,
      sandboxHighRisk: true // irrelevant here: the patch is low-risk, so sandbox is skipped either way
    });

    expect(result.success).toBe(true);
    expect(result.risk?.level).toBe('low');

    // The patch really is live on disk.
    const written = await fs.readFile(path.join(root, 'docs', 'NOTES.md'), 'utf8');
    expect(written).toBe('patched notes\n');

    const events = eventsOf();
    expect(events.length).toBeGreaterThan(0);

    // No event at any point should read like there's a human approval step
    // pending — that illusion (the old "manual mode" toggle) is exactly what
    // H3 removes. The pipeline applies live and gates afterward, always.
    for (const e of events) {
      expect(e.message ?? '').not.toMatch(/manual mode|awaiting approval|pending approval|paused/i);
    }

    const promote = events.find(e => e.phase === 'promote');
    expect(promote?.status).toBe('ok');
    expect(promote?.message).toMatch(/live/i);

    // By the time gate:start fires, the patch is already on disk — proving
    // apply-before-gate (there is no hidden staging step to "approve").
    const gateStartIdx = events.findIndex(e => e.phase === 'gate' && e.status === 'start');
    const applyOkIdx = events.findIndex(e => e.phase === 'apply-patch' && e.status === 'ok');
    expect(applyOkIdx).toBeGreaterThanOrEqual(0);
    expect(gateStartIdx).toBeGreaterThan(applyOkIdx);
  }, 60000);

  it('still rolls back on a gate failure (regression check on the H3/H4 reorder)', async () => {
    const root = await makeFixture({ test: 'node -e "process.exit(1)"' });
    const patch: PatchSet = {
      id: 'low-risk-patch-2', rationale: 'test',
      files: [{ path: 'docs/NOTES.md', mode: 'replace', contents: 'patched notes 2\n' }]
    };

    const result = await runPipeline({
      runId: 'test-run-gate-fail',
      sourceRoot: root,
      patch,
      sandboxHighRisk: true
    });

    expect(result.success).toBe(false);
    expect(result.rolledBack).toBe(true);

    // Snapshot restore should have reverted the live write. Compare with
    // line endings normalized: git's checkout on Windows may rewrite \n to
    // \r\n (core.autocrlf) on restore, which is a git/platform detail, not a
    // pipeline defect.
    const written = (await fs.readFile(path.join(root, 'docs', 'NOTES.md'), 'utf8')).replace(/\r\n/g, '\n');
    expect(written).toBe('original notes\n');
  }, 60000);

  it('a high-risk patch never reaches the live tree until the sandbox clone passes', async () => {
    // node_modules present so the sandbox's junction step succeeds without a
    // network-dependent `npm ci` fallback.
    const root = await makeFixture();
    await fs.mkdir(path.join(root, 'node_modules'), { recursive: true });

    const patch: PatchSet = {
      id: 'high-risk-patch', rationale: 'test',
      // electron/main.ts is on the HIGH_RISK_FILES list in risk.ts.
      files: [{ path: 'electron/main.ts', mode: 'create', contents: 'export const boom = 1;\n' }]
    };

    const result = await runPipeline({
      runId: 'test-run-high-risk',
      sourceRoot: root,
      patch,
      sandboxHighRisk: true
    });

    expect(result.risk?.level).toBe('high');
    expect(result.success).toBe(true);
    expect(result.sandbox?.ok).toBe(true);

    const events = eventsOf();
    const sandboxOkIdx = events.findIndex(e => e.phase === 'sandbox' && e.status === 'ok');
    const applyStartIdx = events.findIndex(e => e.phase === 'apply-patch' && e.status === 'start');
    expect(sandboxOkIdx).toBeGreaterThanOrEqual(0);
    expect(applyStartIdx).toBeGreaterThan(sandboxOkIdx);

    const written = await fs.readFile(path.join(root, 'electron', 'main.ts'), 'utf8');
    expect(written).toBe('export const boom = 1;\n');
  }, 90000);
});
