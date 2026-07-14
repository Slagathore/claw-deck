import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { discardPromotion } from './promoted';

/**
 * Resolves the *writable* source tree that the self-upgrader operates on.
 *  - Dev mode  → the actual workspace (project root, i.e. parent of `dist-electron`).
 *  - Packaged  → %APPDATA%/claw-deck/source/  (seeded from resources/source).
 */
export function sourceRoot(): string {
  if (!app.isPackaged) {
    // dist-electron/main.js lives at <repo>/dist-electron/, so go up one.
    return path.resolve(__dirname, '..', '..');
  }
  return path.join(app.getPath('userData'), 'source');
}

export function snapshotsDir(): string {
  return path.join(app.getPath('userData'), 'self-upgrade-snapshots');
}

export function logsDir(): string {
  return path.join(app.getPath('userData'), 'self-upgrade-logs');
}

/** Where a superseded source tree is parked when the app version moves on. */
export function sourceArchiveDir(): string {
  return path.join(app.getPath('userData'), 'source-archive');
}

/**
 * True when `child` is `parent` itself or lives underneath it. Pure, so the
 * containment rule that keeps the self-upgrader inside its own source root is
 * unit-testable without an Electron app object.
 */
export function isPathWithin(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  const p = path.resolve(parent);
  const c = path.resolve(child);
  if (p === c) return true;
  const rel = path.relative(p, c);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Name of the version stamp written into the seeded source tree. */
export const SEED_STAMP_FILE = '.clawdeck-seed.json';

export interface SeedStamp {
  /** app.getVersion() at the moment the tree was seeded. */
  appVersion: string;
  seededAt: number;
}

export type SeedDecision = 'seed' | 'reseed' | 'keep';

/**
 * Pure seeding policy. The old implementation seeded only when the directory
 * was empty and never looked again, which stranded the tree at whatever version
 * first created it (observed in the wild: a 0.1.0 tree under a 1.0.2 app). Now
 * an unstamped or version-mismatched tree is re-seeded.
 */
export function seedDecision(opts: {
  hasContents: boolean;
  stamp: SeedStamp | null;
  appVersion: string;
}): SeedDecision {
  if (!opts.hasContents) return 'seed';
  if (!opts.stamp) return 'reseed';          // fossil from before stamping existed
  if (opts.stamp.appVersion !== opts.appVersion) return 'reseed';
  return 'keep';
}

async function dirHasContents(p: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(p);
    return entries.length > 0;
  } catch {
    return false;
  }
}

export async function readSeedStamp(root: string): Promise<SeedStamp | null> {
  try {
    const raw = await fsp.readFile(path.join(root, SEED_STAMP_FILE), 'utf8');
    const j = JSON.parse(raw);
    if (typeof j?.appVersion === 'string') return { appVersion: j.appVersion, seededAt: j.seededAt ?? 0 };
    return null;
  } catch {
    return null;
  }
}

export async function writeSeedStamp(root: string, appVersion: string): Promise<void> {
  const stamp: SeedStamp = { appVersion, seededAt: Date.now() };
  await fsp.writeFile(path.join(root, SEED_STAMP_FILE), JSON.stringify(stamp, null, 2));
}

async function copyDir(src: string, dst: string, skip: Set<string>): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    if (skip.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) await copyDir(s, d, skip);
    else if (ent.isFile()) await fsp.copyFile(s, d);
  }
}

export interface SourceTreeState {
  path: string;
  ready: boolean;
  reason?: string;
  /** Set when this call replaced a stale tree. */
  reseeded?: boolean;
  /** Where the superseded tree was parked, if any. */
  archivedTo?: string;
  /** Version the superseded tree was seeded at ('unknown' for unstamped fossils). */
  supersededVersion?: string;
}

/**
 * Ensure the writable source tree exists AND matches the running app version.
 *
 * A stale tree is NOT merged with the new one — a patch set generated against
 * old code cannot be replayed onto new code, and silently mixing the two is how
 * you get a tree that is neither version. The old tree is moved intact to
 * `userData/source-archive/<version>-<ts>/` (nothing is deleted, it stays
 * recoverable) and the reason is logged; any promoted bundle built from it is
 * discarded at the same time, because it is code from a dead lineage.
 */
export async function ensureSourceTree(): Promise<SourceTreeState> {
  const root = sourceRoot();
  if (!app.isPackaged) return { path: root, ready: true };

  const appVersion = app.getVersion();
  await fsp.mkdir(root, { recursive: true });

  const stamp = await readSeedStamp(root);
  const decision = seedDecision({ hasContents: await dirHasContents(root), stamp, appVersion });
  if (decision === 'keep') return { path: root, ready: true };

  const bundled = path.join(process.resourcesPath || '', 'source');
  if (!bundled || !fs.existsSync(bundled)) {
    return {
      path: root,
      ready: false,
      reason: `no bundled source at ${bundled || '(unknown resourcesPath)'} (this build shipped without resources/source)`
    };
  }

  let archivedTo: string | undefined;
  const supersededVersion = stamp?.appVersion ?? 'unknown';

  if (decision === 'reseed') {
    // Park the stale tree; never delete it outright.
    try {
      await fsp.mkdir(sourceArchiveDir(), { recursive: true });
      archivedTo = path.join(sourceArchiveDir(), `${supersededVersion}-${Date.now()}`);
      await fsp.rename(root, archivedTo);
      await fsp.mkdir(root, { recursive: true });
    } catch (e: any) {
      return { path: root, ready: false, reason: `could not archive the stale source tree: ${e.message}` };
    }
    const reason =
      `source tree was seeded at app ${supersededVersion} but this app is ${appVersion}; ` +
      `re-seeded from resources/source. Self-upgrades that lived only in the old tree were discarded ` +
      `(a patch written against ${supersededVersion} cannot be replayed onto ${appVersion} code). ` +
      `Old tree archived at ${archivedTo}.`;
    try { discardPromotion(`source re-seed: ${reason}`, 'reseed-discard'); } catch { /* nothing promoted */ }
    logSeedEvent(reason);
  }

  try {
    await copyDir(bundled, root, new Set(['node_modules', 'dist', 'dist-electron', 'dist-installer', '.git']));
    await writeSeedStamp(root, appVersion);
  } catch (e: any) {
    return { path: root, ready: false, reason: `bundled copy failed: ${e.message}` };
  }

  return {
    path: root,
    ready: true,
    reseeded: decision === 'reseed',
    archivedTo,
    supersededVersion: decision === 'reseed' ? supersededVersion : undefined,
    reason: decision === 'reseed'
      ? `re-seeded from ${supersededVersion} → ${appVersion}; previous tree archived at ${archivedTo}`
      : undefined
  };
}

function logSeedEvent(message: string): void {
  try {
    const d = logsDir();
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, 'seed.log'), `${new Date().toISOString()} ${message}\n`);
  } catch { /* logging is best-effort */ }
}

export async function ensureSnapshotsDir(): Promise<string> {
  const d = snapshotsDir();
  await fsp.mkdir(d, { recursive: true });
  return d;
}

export async function ensureLogsDir(): Promise<string> {
  const d = logsDir();
  await fsp.mkdir(d, { recursive: true });
  return d;
}
