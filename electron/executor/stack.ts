// Per-stack compile/test gate. Detects the project's stack from marker files and
// runs its real compile + test commands in a directory (a worktree). Used by the
// executor's validation so every council build — and every FORGE campaign iteration
// (the golden regression gate, run over the ACCUMULATED tree) — is checked against
// an actual build/test, not just a lint of the proposal text.
//
// No-abort philosophy: a missing toolchain DEGRADES to "skipped" (ok, ran:false)
// rather than failing the build — an autonomous loop must not block every item
// because, say, `cargo` isn't on PATH. A detected toolchain that runs and fails IS
// a hard fail (that's the gate doing its job).

import * as fs from 'fs';
import * as path from 'path';
import { run, which } from '../selfUpgrade/exec';

export type StackName = 'node' | 'godot' | 'python' | 'rust' | 'go' | 'web' | 'unknown';
export interface StackCmd { bin: string; args: string[]; env?: Record<string, string> }
export interface StackPlan { name: StackName; compile?: StackCmd; test?: StackCmd; needsInstall?: boolean }
export interface StackGateResult { ok: boolean; ran: boolean; stage?: 'install' | 'compile' | 'test' | 'check'; output: string; stack: StackName }

const WIN = process.platform === 'win32';
const npmBin = () => (WIN ? 'npm.cmd' : 'npm');
const exists = (p: string) => { try { return fs.existsSync(p); } catch { return false; } };
const readJson = (p: string): any => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'dist-installer', '.fusion', 'target', 'build', '.godot', 'addons', '__pycache__', 'vendor']);

/** Shallow-ish recursive file collect, capped, skipping build/vendor dirs. */
function collectFiles(dir: string, match: RegExp, cap: number): string[] {
  const out: string[] = [];
  const walk = (d: string, depth: number) => {
    if (out.length >= cap || depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.name.startsWith('.') && e.isDirectory()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(d, e.name), depth + 1); }
      else if (match.test(e.name)) out.push(path.join(d, e.name));
    }
  };
  walk(dir, 0);
  return out;
}

const localBin = (dir: string, bin: string) => { const p = path.join(dir, 'node_modules', '.bin', WIN ? `${bin}.cmd` : bin); return exists(p) ? p : null; };

/** Detect the stack and the commands to validate it. Pure (fs only). */
export function detectStack(dir: string, bins: { godot?: string } = {}): StackPlan {
  const has = (rel: string) => exists(path.join(dir, rel));
  if (has('Cargo.toml')) return { name: 'rust', compile: { bin: 'cargo', args: ['check', '--quiet'] }, test: { bin: 'cargo', args: ['test', '--quiet'] } };
  if (has('go.mod')) return { name: 'go', compile: { bin: 'go', args: ['build', './...'] }, test: { bin: 'go', args: ['test', './...'] } };
  if (has('project.godot')) return { name: 'godot', compile: { bin: bins.godot || 'godot', args: ['--headless', '--quit-after', '1', '--path', dir] } };
  if (has('package.json')) {
    const pkg = readJson(path.join(dir, 'package.json')) || {};
    const scripts = pkg.scripts || {};
    let compile: StackCmd | undefined;
    if (scripts.typecheck) compile = { bin: npmBin(), args: ['run', 'typecheck', '--silent'] };
    else if (scripts.build) compile = { bin: npmBin(), args: ['run', 'build', '--silent'] };
    else if (has('tsconfig.json')) { const tsc = localBin(dir, 'tsc'); if (tsc) compile = { bin: tsc, args: ['--noEmit'] }; }
    const test = scripts.test ? { bin: npmBin(), args: ['test', '--silent'] } : undefined;
    const needsInstall = !!(pkg.dependencies || pkg.devDependencies) && !exists(path.join(dir, 'node_modules'));
    return { name: 'node', compile, test, needsInstall };
  }
  if (has('pyproject.toml') || has('requirements.txt') || collectFiles(dir, /\.py$/, 1).length) {
    const hasPytest = exists(path.join(dir, 'tests')) || collectFiles(dir, /^test_.*\.py$|_test\.py$/, 1).length > 0;
    return { name: 'python', compile: { bin: 'python', args: ['-m', 'compileall', '-q', '.'] }, test: hasPytest ? { bin: 'python', args: ['-m', 'pytest', '-q'] } : undefined };
  }
  if (has('index.html') || collectFiles(dir, /\.(m?js|cjs)$/, 1).length) return { name: 'web' };
  return { name: 'unknown' };
}

const tail = (r: { stdout: string; stderr: string }, n = 2500) => `${r.stdout}\n${r.stderr}`.trim().slice(-n);

/** Run the stack gate in `dir`. compile then test; first failure stops + reports. */
export async function runStackGate(dir: string, opts: { timeoutMs?: number; godot?: string; signal?: AbortSignal } = {}): Promise<StackGateResult> {
  const timeoutMs = opts.timeoutMs ?? 300000;
  const plan = detectStack(dir, { godot: opts.godot });

  if (plan.name === 'unknown') return { ok: true, ran: false, output: 'no recognized stack — gate skipped', stack: 'unknown' };

  // Vanilla web: parse-check each JS file with Electron-as-node (--check).
  if (plan.name === 'web') {
    const files = collectFiles(dir, /\.(m?js|cjs)$/, 80);
    if (!files.length) return { ok: true, ran: false, output: 'no JS files to check', stack: 'web' };
    for (const f of files) {
      if (opts.signal?.aborted) break;
      const r = await run(process.execPath, ['--check', f], { cwd: dir, timeoutMs: 15000, signal: opts.signal as any, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      if (!r.ok) return { ok: false, ran: true, stage: 'check', output: `${path.relative(dir, f)}: ${tail(r, 1500)}`, stack: 'web' };
    }
    return { ok: true, ran: true, stage: 'check', output: `${files.length} JS file(s) parse-checked`, stack: 'web' };
  }

  // node install (no lockfile needed — `npm install`, not `ci`) when deps are declared but absent.
  if (plan.name === 'node' && plan.needsInstall) {
    const r = await run(npmBin(), ['install', '--no-audit', '--no-fund'], { cwd: dir, timeoutMs: 600000, signal: opts.signal as any });
    if (!r.ok) return { ok: false, ran: true, stage: 'install', output: tail(r), stack: 'node' };
  }

  for (const [stage, cmd] of [['compile', plan.compile], ['test', plan.test]] as const) {
    if (!cmd) continue;
    if (opts.signal?.aborted) break;
    // Missing toolchain → degrade to skipped, don't hard-fail an autonomous loop.
    if (!cmd.bin.includes(path.sep) && !cmd.bin.endsWith('.cmd') && !(await which(cmd.bin))) {
      return { ok: true, ran: false, stage, output: `${cmd.bin} not found on PATH — ${stage} skipped (install it to enable the gate)`, stack: plan.name };
    }
    const r = await run(cmd.bin, cmd.args, { cwd: dir, timeoutMs, signal: opts.signal as any, env: cmd.env ? { ...process.env, ...cmd.env } : process.env });
    if (!r.ok) return { ok: false, ran: true, stage, output: tail(r), stack: plan.name };
  }
  return { ok: true, ran: !!(plan.compile || plan.test), stage: 'test', output: 'stack gate passed', stack: plan.name };
}
