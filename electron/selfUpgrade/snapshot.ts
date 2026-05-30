import * as path from 'path';
import * as fsp from 'fs/promises';
import { run, which } from './exec';
import { ensureSnapshotsDir, snapshotsDir } from './paths';

export interface Snapshot {
  id: string;
  createdAt: number;
  label: string;
  /** git sha when git-backed, or directory name when copy-backed. */
  ref: string;
  strategy: 'git' | 'copy';
  root: string;
}

const SKIP = new Set(['node_modules', 'dist', 'dist-electron', '.git', 'dist-installer', 'dist-installer2', 'dist-installer3', 'dist-installer4', 'dist-installer5', 'dist-installer6', 'dist-installer7', 'dist-installer8']);

async function hasGit(): Promise<boolean> { return which('git'); }

async function copyTree(src: string, dst: string): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyTree(s, d);
    else if (e.isFile()) await fsp.copyFile(s, d);
  }
}

async function clearTree(dst: string): Promise<void> {
  const entries = await fsp.readdir(dst, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP.has(e.name)) continue;
    await fsp.rm(path.join(dst, e.name), { recursive: true, force: true });
  }
}

export async function createSnapshot(root: string, label: string): Promise<Snapshot> {
  const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const createdAt = Date.now();

  if (await hasGit()) {
    // Initialize repo if needed, then commit a snapshot on a dedicated branch.
    const gitDir = path.join(root, '.git');
    let inited = false;
    try { await fsp.access(gitDir); } catch { inited = true; }
    if (inited) {
      await run('git', ['init'], { cwd: root, timeoutMs: 30000 });
      await run('git', ['config', 'user.email', 'self-upgrade@clawdeck.local'], { cwd: root, timeoutMs: 5000 });
      await run('git', ['config', 'user.name', 'Claw Deck Self-Upgrade'], { cwd: root, timeoutMs: 5000 });
    }
    await run('git', ['add', '-A'], { cwd: root, timeoutMs: 60000 });
    const commit = await run('git', ['commit', '-m', `snapshot: ${label}`, '--allow-empty', '--no-verify'], { cwd: root, timeoutMs: 60000 });
    const sha = await run('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 5000 });
    return {
      id, createdAt, label,
      ref: sha.stdout.trim() || commit.stdout.trim(),
      strategy: 'git', root
    };
  }

  // Copy-based fallback.
  const dir = await ensureSnapshotsDir();
  const dst = path.join(dir, id);
  await copyTree(root, dst);
  return { id, createdAt, label, ref: dst, strategy: 'copy', root };
}

export async function restoreSnapshot(snap: Snapshot): Promise<void> {
  if (snap.strategy === 'git') {
    await run('git', ['reset', '--hard', snap.ref], { cwd: snap.root, timeoutMs: 60000 });
    await run('git', ['clean', '-fd', '-e', 'node_modules', '-e', 'dist', '-e', 'dist-electron'], { cwd: snap.root, timeoutMs: 60000 });
    return;
  }
  await clearTree(snap.root);
  await copyTree(snap.ref, snap.root);
}

export async function listSnapshots(): Promise<{ id: string; createdAt: number; strategy: 'copy' }[]> {
  const dir = snapshotsDir();
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && e.name.startsWith('snap-'))
      .map(e => {
        const ts = parseInt(e.name.split('-')[1] || '0', 36);
        return { id: e.name, createdAt: ts, strategy: 'copy' as const };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}
