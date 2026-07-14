import * as path from 'path';
import * as fsp from 'fs/promises';
import { run, which } from './exec';
import { ensureSnapshotsDir, snapshotsDir, sourceRoot, isPathWithin } from './paths';

/**
 * Which tree a snapshot belongs to.
 *  - 'self'      → Claw Deck's own source root. Only these may ever be restored
 *                  by the self-upgrade UI.
 *  - 'workspace' → one of the user's OWN repos, snapshotted by the council /
 *                  executor before it applies an approved diff there.
 *
 * These used to share one index.json, which is how `%APPDATA%\claw-deck\
 * self-upgrade-snapshots\index.json` ended up holding snapshots rooted in
 * C:\Users\Cole\CodeStuff\games\SD_Mining — and how "Revert last upgrade" in the
 * Self-Upgrade tab could have run `git reset --hard` inside an unrelated project.
 * They are now recorded in separate indexes, and the self index is pruned of any
 * root outside the source tree every time it is read.
 */
export type SnapshotScope = 'self' | 'workspace';

export interface Snapshot {
  id: string;
  createdAt: number;
  label: string;
  /** git sha when git-backed, or directory name when copy-backed. */
  ref: string;
  strategy: 'git' | 'copy';
  root: string;
  scope: SnapshotScope;
}

/**
 * Durable index of every snapshot (git- and copy-backed) so a rollback can find
 * a snapshot by id even after the app restarts. Lives next to the copy-mode
 * snapshot dirs. All access is best-effort: in non-Electron contexts (e.g. the
 * unit test runner) `snapshotsDir()` may throw because `app` is unavailable, so
 * every helper swallows errors and degrades to in-memory behaviour.
 */
function indexPath(scope: SnapshotScope): string {
  return path.join(snapshotsDir(), scope === 'self' ? 'index.json' : 'workspace-index.json');
}

/** Best-effort source root; null outside an Electron main process. */
function selfRootOrNull(): string | null {
  try { return sourceRoot(); } catch { return null; }
}

/**
 * Pure: split a self-scoped index into the entries that legitimately belong to
 * Claw Deck's own tree and the foreign ones that must never be there.
 */
export function partitionSelfIndex(
  list: Snapshot[],
  selfRoot: string
): { kept: Snapshot[]; foreign: Snapshot[] } {
  const kept: Snapshot[] = [];
  const foreign: Snapshot[] = [];
  for (const s of list) {
    if (s.scope === 'workspace' || !isPathWithin(selfRoot, s.root)) foreign.push(s);
    else kept.push(s);
  }
  return { kept, foreign };
}

async function readIndex(scope: SnapshotScope): Promise<Snapshot[]> {
  try {
    const list = JSON.parse(await fsp.readFile(indexPath(scope), 'utf8'));
    if (!Array.isArray(list)) return [];
    // Entries written before scopes existed default to the index they live in.
    return list.map((s: Snapshot) => ({ ...s, scope: s.scope ?? scope }));
  } catch {
    return [];
  }
}

async function writeIndex(scope: SnapshotScope, list: Snapshot[]): Promise<void> {
  await ensureSnapshotsDir();
  const bounded = [...list].sort((a, b) => a.createdAt - b.createdAt).slice(-200);
  await fsp.writeFile(indexPath(scope), JSON.stringify(bounded, null, 2));
}

/**
 * Read the self index, dropping (and reporting) anything rooted outside the
 * source tree. This is the self-healing half of the containment fix: an index
 * already polluted by the old shared-index behaviour cleans itself on first read.
 */
export async function readSelfIndex(): Promise<{ list: Snapshot[]; purged: Snapshot[] }> {
  const raw = await readIndex('self');
  const selfRoot = selfRootOrNull();
  if (!selfRoot) return { list: raw, purged: [] };
  const { kept, foreign } = partitionSelfIndex(raw, selfRoot);
  if (foreign.length) {
    try {
      await writeIndex('self', kept);
      const existing = await readIndex('workspace');
      const ids = new Set(existing.map(s => s.id));
      await writeIndex('workspace', [...existing, ...foreign.filter(f => !ids.has(f.id)).map(f => ({ ...f, scope: 'workspace' as const }))]);
      console.warn(`[snapshot] moved ${foreign.length} foreign snapshot(s) out of the self-upgrade index: ${foreign.map(f => `${f.id}@${f.root}`).join(', ')}`);
    } catch { /* best-effort */ }
  }
  return { list: kept, purged: foreign };
}

export async function recordSnapshot(snap: Snapshot): Promise<void> {
  try {
    const selfRoot = selfRootOrNull();
    if (snap.scope === 'self' && selfRoot && !isPathWithin(selfRoot, snap.root)) {
      // Should be impossible (createSnapshot refuses first) — belt and braces.
      throw new Error(`refusing to record a self-scoped snapshot rooted at ${snap.root}, outside ${selfRoot}`);
    }
    await ensureSnapshotsDir();
    const list = (await readIndex(snap.scope)).filter(s => s.id !== snap.id);
    list.push(snap);
    await writeIndex(snap.scope, list);
  } catch (e: any) {
    // Persistence is unavailable in non-Electron contexts (unit tests); a real
    // containment violation is loud.
    if (String(e?.message ?? '').startsWith('refusing to record')) throw e;
  }
}

export async function findSnapshotById(id: string, scope?: SnapshotScope): Promise<Snapshot | null> {
  const scopes: SnapshotScope[] = scope ? [scope] : ['self', 'workspace'];
  for (const s of scopes) {
    const list = s === 'self' ? (await readSelfIndex()).list : await readIndex('workspace');
    const hit = list.find(x => x.id === id);
    if (hit) return hit;
  }
  return null;
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

/**
 * Snapshot a tree.
 *
 * `scope` is mandatory in spirit: 'self' means "this is Claw Deck's own source
 * root" and is REFUSED for any path outside it, so the self-upgrade machinery can
 * never snapshot (and therefore never `git reset --hard`) one of the user's other
 * projects. The council/executor, which legitimately snapshot the user's repo
 * before applying an approved diff there, pass 'workspace' and land in a separate
 * index the self-upgrade UI never touches.
 */
export async function createSnapshot(root: string, label: string, scope: SnapshotScope = 'workspace'): Promise<Snapshot> {
  const id = `snap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const createdAt = Date.now();

  if (scope === 'self') {
    const selfRoot = selfRootOrNull();
    if (selfRoot && !isPathWithin(selfRoot, root)) {
      const msg = `refusing to snapshot ${root} as a self-upgrade snapshot: it is outside the Claw Deck source root (${selfRoot})`;
      console.error(`[snapshot] ${msg}`);
      throw new Error(msg);
    }
  }

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
      strategy: 'git', root, scope
    };
    await recordSnapshot(snap);
    return snap;
  }

  // Copy-based fallback.
  const dir = await ensureSnapshotsDir();
  const dst = path.join(dir, id);
  await copyTree(root, dst);
  const snap: Snapshot = { id, createdAt, label, ref: dst, strategy: 'copy', root, scope };
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

/**
 * Snapshots the self-upgrade UI may offer to restore. Self-scoped only — a
 * workspace snapshot of one of the user's own repos must never show up as
 * something "Revert last upgrade" can hard-reset.
 */
export async function listSnapshots(): Promise<{ id: string; createdAt: number; strategy: 'git' | 'copy'; label?: string; root: string }[]> {
  const { list } = await readSelfIndex();
  if (list.length > 0) {
    return list
      .map(s => ({ id: s.id, createdAt: s.createdAt, strategy: s.strategy, label: s.label, root: s.root }))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // Fallback: scan copy-mode snapshot dirs (older installs without an index).
  // Only usable when we can say which root they belong to, which we can't from a
  // bare directory name — so these are surfaced with the current source root and
  // are only ever restored through the guarded rollback handler.
  const selfRoot = selfRootOrNull();
  if (!selfRoot) return [];
  const dir = snapshotsDir();
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && e.name.startsWith('snap-'))
      .map(e => {
        const ts = parseInt(e.name.split('-')[1] || '0', 36);
        return { id: e.name, createdAt: ts, strategy: 'copy' as const, root: selfRoot };
      })
      .sort((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}
