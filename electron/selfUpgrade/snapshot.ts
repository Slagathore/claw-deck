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

/**
 * Durable index of every snapshot (git- and copy-backed) so a rollback can find
 * a snapshot by id even after the app restarts. Lives next to the copy-mode
 * snapshot dirs. All access is best-effort: in non-Electron contexts (e.g. the
 * unit test runner) `snapshotsDir()` may throw because `app` is unavailable, so
 * every helper swallows errors and degrades to in-memory behaviour.
 */
function indexPath(): string {
  return path.join(snapshotsDir(), 'index.json');
}

export async function recordSnapshot(snap: Snapshot): Promise<void> {
  try {
    await ensureSnapshotsDir();
    const file = indexPath();
    let list: Snapshot[] = [];
    try { list = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { /* no index yet */ }
    list = list.filter(s => s.id !== snap.id);
    list.push(snap);
    // Keep the index bounded; oldest dropped first.
    list.sort((a, b) => a.createdAt - b.createdAt);
    if (list.length > 200) list = list.slice(-200);
    await fsp.writeFile(file, JSON.stringify(list, null, 2));
  } catch { /* best-effort: persistence is unavailable in this context */ }
}

export async function findSnapshotById(id: string): Promise<Snapshot | null> {
  try {
    const list: Snapshot[] = JSON.parse(await fsp.readFile(indexPath(), 'utf8'));
    return list.find(s => s.id === id) ?? null;
  } catch {
    return null;
  }
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
    const snap: Snapshot = {
      id, createdAt, label,
      ref: sha.stdout.trim() || commit.stdout.trim(),
      strategy: 'git', root
    };
    await recordSnapshot(snap);
    return snap;
  }

  // Copy-based fallback.
  const dir = await ensureSnapshotsDir();
  const dst = path.join(dir, id);
  await copyTree(root, dst);
  const snap: Snapshot = { id, createdAt, label, ref: dst, strategy: 'copy', root };
  await recordSnapshot(snap);
  return snap;
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

export async function listSnapshots(): Promise<{ id: string; createdAt: number; strategy: 'git' | 'copy'; label?: string }[]> {
  // Prefer the durable index (covers both git- and copy-backed snapshots).
  try {
    const list: Snapshot[] = JSON.parse(await fsp.readFile(indexPath(), 'utf8'));
    if (Array.isArray(list) && list.length > 0) {
      return list
        .map(s => ({ id: s.id, createdAt: s.createdAt, strategy: s.strategy, label: s.label }))
        .sort((a, b) => b.createdAt - a.createdAt);
    }
  } catch { /* fall back to directory scan */ }

  // Fallback: scan copy-mode snapshot dirs (older installs without an index).
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
