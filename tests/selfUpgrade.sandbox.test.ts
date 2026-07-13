import { describe, it, expect } from 'vitest';
import { runInSandbox } from '../electron/selfUpgrade/sandbox';
import type { PatchSet } from '../electron/selfUpgrade/patcher';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

async function makeFixture(testScript: string): Promise<string> {
  const root = path.join(os.tmpdir(), `claw-deck-sandbox-fixture-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true }); // present so the junction step succeeds instead of falling back to `npm ci`
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'sandbox-fixture', version: '0.0.1',
    scripts: { test: testScript }
  }, null, 2));
  await fs.writeFile(path.join(root, 'marker.txt'), 'original\n');
  return root;
}

describe('runInSandbox (high-risk pre-check)', () => {
  it('applies the patch inside the cloned tempdir and never writes to the live source root', async () => {
    const root = await makeFixture('node -e "process.exit(0)"');
    try {
      const patch: PatchSet = {
        id: 'p1', rationale: 'test',
        files: [{ path: 'marker.txt', mode: 'replace', contents: 'PATCHED\n' }]
      };
      const result = await runInSandbox({ sourceRoot: root, patch, timeoutMs: 60000 });
      expect(result.ok).toBe(true);

      // The whole point of H4: the live tree must be untouched by a sandbox run,
      // whether it passes or fails. Only `runPipeline`'s step 5 (after the
      // sandbox proves out) is allowed to write to the live source root.
      const live = await fs.readFile(path.join(root, 'marker.txt'), 'utf8');
      expect(live).toBe('original\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60000);

  it('leaves the live source root untouched when the sandboxed test run fails', async () => {
    const root = await makeFixture('node -e "process.exit(1)"');
    try {
      const patch: PatchSet = {
        id: 'p2', rationale: 'test',
        files: [{ path: 'marker.txt', mode: 'replace', contents: 'PATCHED\n' }]
      };
      const result = await runInSandbox({ sourceRoot: root, patch, timeoutMs: 60000 });
      expect(result.ok).toBe(false);

      const live = await fs.readFile(path.join(root, 'marker.txt'), 'utf8');
      expect(live).toBe('original\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60000);

  it('fails cleanly (without touching the live tree) when the patch itself is invalid', async () => {
    const root = await makeFixture('node -e "process.exit(0)"');
    try {
      const patch: PatchSet = {
        id: 'p3', rationale: 'test',
        files: [{ path: '../escape.txt', mode: 'create', contents: 'nope' }]
      };
      const result = await runInSandbox({ sourceRoot: root, patch, timeoutMs: 60000 });
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/patch apply failed/);

      const live = await fs.readFile(path.join(root, 'marker.txt'), 'utf8');
      expect(live).toBe('original\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60000);

  it('runs with no patch at all (back-compat: patch is optional)', async () => {
    const root = await makeFixture('node -e "process.exit(0)"');
    try {
      const result = await runInSandbox({ sourceRoot: root, timeoutMs: 60000 });
      expect(result.ok).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 60000);
});
