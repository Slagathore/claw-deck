import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

/**
 * Promoted bundles: the piece that makes packaged self-upgrade actually RUN.
 *
 * The self-upgrader patches `userData/source`. Nothing executed that tree — the
 * packaged app boots `resources/app.asar`, so a passing self-upgrade edited code
 * that was never loaded. Now, when a patch set passes the gate, the patched tree
 * is BUILT (esbuild, see build.ts) into `userData/promoted/bundles/<id>/` and
 * `current.json` points at it. `boot.ts` (the app's real entry point) loads the
 * promoted bundle instead of the asar on the next launch.
 *
 * The safety valve is the boot sentinel: boot.ts writes `booting.marker` BEFORE
 * loading a promoted bundle, and the app clears it once a window has actually
 * rendered. If the marker is still on disk at the next start, that promotion
 * hung or crashed the app, so boot.ts discards it and falls back to the pristine
 * asar. A self-upgrade cannot brick the app: the worst case is one bad launch.
 *
 * Everything here is synchronous — boot.ts runs before `app.whenReady()` and
 * must decide which code to load before anything else happens.
 */

export interface PromotedRecord {
  id: string;
  dir: string;
  /** app.getVersion() the bundle was built against. A bundle from another app version is never loaded. */
  appVersion: string;
  promotedAt: number;
  runId?: string;
  /** 'full' | 'reduced' — which gate actually ran before this was promoted. */
  gateMode?: string;
  gateRan?: string[];
  gateSkipped?: { check: string; reason: string }[];
}

export type JournalEvent =
  | 'promote'
  | 'auto-rollback'
  | 'manual-revert'
  | 'version-discard'
  | 'reseed-discard'
  | 'build-discard';

export interface JournalEntry {
  at: number;
  event: JournalEvent;
  id?: string;
  appVersion?: string;
  reason?: string;
}

export function promotedDir(): string {
  return path.join(app.getPath('userData'), 'promoted');
}
export function bundlesDir(): string {
  return path.join(promotedDir(), 'bundles');
}
function currentPath(): string {
  return path.join(promotedDir(), 'current.json');
}
function journalPath(): string {
  return path.join(promotedDir(), 'journal.jsonl');
}
function sentinelPath(): string {
  return path.join(promotedDir(), 'booting.marker');
}
function lastRollbackPath(): string {
  return path.join(promotedDir(), 'last-rollback.json');
}

function ensureDir(): void {
  fs.mkdirSync(bundlesDir(), { recursive: true });
}

export function appendJournal(entry: JournalEntry): void {
  try {
    ensureDir();
    fs.appendFileSync(journalPath(), JSON.stringify(entry) + '\n');
  } catch { /* journalling is best-effort; never block a boot on it */ }
}

export function readJournal(limit = 50): JournalEntry[] {
  try {
    const lines = fs.readFileSync(journalPath(), 'utf8').split(/\r?\n/).filter(Boolean);
    const out: JournalEntry[] = [];
    for (const l of lines.slice(-limit)) {
      try { out.push(JSON.parse(l)); } catch { /* skip a torn line */ }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

export function readCurrent(): PromotedRecord | null {
  try {
    const j = JSON.parse(fs.readFileSync(currentPath(), 'utf8'));
    if (typeof j?.dir === 'string' && typeof j?.id === 'string') return j as PromotedRecord;
    return null;
  } catch {
    return null;
  }
}

export function writeCurrent(rec: PromotedRecord): void {
  ensureDir();
  fs.writeFileSync(currentPath(), JSON.stringify(rec, null, 2));
  appendJournal({ at: Date.now(), event: 'promote', id: rec.id, appVersion: rec.appVersion, reason: `promoted bundle ${rec.id} (gate: ${rec.gateMode ?? 'unknown'})` });
}

function clearCurrent(): void {
  try { fs.rmSync(currentPath(), { force: true }); } catch { /* already gone */ }
}

/** Drop the active promotion (the bundle directory is kept for inspection). */
export function discardPromotion(reason: string, event: JournalEvent = 'manual-revert'): PromotedRecord | null {
  const cur = readCurrent();
  clearCurrent();
  clearBootSentinel();
  if (cur) appendJournal({ at: Date.now(), event, id: cur.id, appVersion: cur.appVersion, reason });
  return cur;
}

export function writeBootSentinel(id: string): void {
  ensureDir();
  fs.writeFileSync(sentinelPath(), JSON.stringify({ id, at: Date.now() }));
}

export function sentinelExists(): boolean {
  return fs.existsSync(sentinelPath());
}

export function clearBootSentinel(): void {
  try { fs.rmSync(sentinelPath(), { force: true }); } catch { /* already gone */ }
}

export interface RollbackNotice {
  at: number;
  id: string;
  reason: string;
}

export function readLastRollback(): RollbackNotice | null {
  try { return JSON.parse(fs.readFileSync(lastRollbackPath(), 'utf8')); } catch { return null; }
}

export function clearLastRollback(): void {
  try { fs.rmSync(lastRollbackPath(), { force: true }); } catch { /* already gone */ }
}

function writeLastRollback(n: RollbackNotice): void {
  try { ensureDir(); fs.writeFileSync(lastRollbackPath(), JSON.stringify(n, null, 2)); } catch { /* best-effort */ }
}

export interface BootDecision {
  /** Directory of the promoted bundle to load, or null to load the pristine asar. */
  root: string | null;
  /** Why the pristine build is being used, when a promotion existed but was refused. */
  refused?: string;
}

/**
 * Decide what to boot. Called by boot.ts before anything is loaded.
 *
 * Order matters: a stale sentinel is checked BEFORE the bundle is loaded again,
 * so a bundle that fails to boot can only ever cost one bad launch.
 */
export function decideBoot(appVersion: string): BootDecision {
  const cur = readCurrent();
  if (!cur) {
    // A sentinel with no current record means a promotion was reverted mid-boot.
    clearBootSentinel();
    return { root: null };
  }

  if (sentinelExists()) {
    const reason =
      `promoted bundle ${cur.id} was loaded on the previous launch but the app never finished booting ` +
      `(the boot sentinel was still on disk). Rolled back to the pristine build that shipped with the installer.`;
    discardPromotion(reason, 'auto-rollback');
    writeLastRollback({ at: Date.now(), id: cur.id, reason });
    return { root: null, refused: reason };
  }

  if (cur.appVersion !== appVersion) {
    const reason = `promoted bundle ${cur.id} was built against app ${cur.appVersion}, but this app is ${appVersion}. Discarded.`;
    discardPromotion(reason, 'version-discard');
    return { root: null, refused: reason };
  }

  if (!fs.existsSync(path.join(cur.dir, 'main.js'))) {
    const reason = `promoted bundle ${cur.id} is missing main.js at ${cur.dir}. Discarded.`;
    discardPromotion(reason, 'build-discard');
    return { root: null, refused: reason };
  }

  writeBootSentinel(cur.id);
  return { root: cur.dir };
}

export function promotedStatus(appVersion: string) {
  const cur = readCurrent();
  return {
    active: !!cur,
    current: cur,
    /** True when the code running right now IS the promoted bundle. */
    running: !!process.env.CLAW_PROMOTED_ROOT,
    runningRoot: process.env.CLAW_PROMOTED_ROOT ?? null,
    appVersion,
    lastRollback: readLastRollback(),
    journal: readJournal(25)
  };
}
