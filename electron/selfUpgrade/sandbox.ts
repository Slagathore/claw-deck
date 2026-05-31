import * as path from 'path';
import * as os from 'os';
import * as fsp from 'fs/promises';
import { run } from './exec';

/**
 * Stages a high-risk patch in isolation before the live tree is trusted: the
 * (already-patched) source is cloned to an OS temp dir, its dependencies are
 * made available (the live node_modules is reused via a junction, falling back
 * to a fresh `npm ci`), and the full test suite runs there. The live process is
 * never executed during this check, and the temp dir is removed afterward.
 */
export interface SandboxResult {
  ok: boolean;
  mode: 'tempdir' | 'unavailable';
  reason?: string;
  testOutput?: string;
  durationMs: number;
}

const SKIP = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'dist-installer', 'dist-installer2', 'dist-installer3', 'dist-installer4', 'dist-installer5', 'dist-installer6', 'dist-installer7', 'dist-installer8']);

async function cloneTo(src: string, dst: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await cloneTo(s, d);
    else if (e.isFile()) await fsp.copyFile(s, d);
  }
}

export async function runInSandbox(opts: { sourceRoot: string; timeoutMs?: number }): Promise<SandboxResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 600000;

  const tmp = path.join(os.tmpdir(), `claw-deck-sandbox-${Date.now().toString(36)}`);
  try {
    await cloneTo(opts.sourceRoot, tmp);
  } catch (e: any) {
    return { ok: false, mode: 'unavailable', reason: `clone failed: ${e.message}`, durationMs: Date.now() - started };
  }

  // Mirror node_modules via symlink — full re-install would dominate runtime.
  try {
    const liveNm = path.join(opts.sourceRoot, 'node_modules');
    const tmpNm = path.join(tmp, 'node_modules');
    await fsp.symlink(liveNm, tmpNm, 'junction');
  } catch {
    // Symlink might fail without permissions; fall back to running `npm ci`.
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const ci = await run(npm, ['ci', '--no-audit', '--no-fund'], { cwd: tmp, timeoutMs: 300000 });
    if (!ci.ok) {
      return { ok: false, mode: 'tempdir', reason: 'npm ci failed', testOutput: (ci.stdout + ci.stderr).slice(-3000), durationMs: Date.now() - started };
    }
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const test = await run(npm, ['test', '--silent'], { cwd: tmp, timeoutMs });
  const out = (test.stdout + test.stderr).slice(-6000);

  // Best-effort cleanup; ignore errors.
  fsp.rm(tmp, { recursive: true, force: true }).catch(() => { /* ignore */ });

  return {
    ok: test.ok,
    mode: 'tempdir',
    reason: test.ok ? undefined : 'tests failed in sandbox',
    testOutput: out,
    durationMs: Date.now() - started
  };
}
