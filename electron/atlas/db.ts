// Per-workspace Atlas DB handles (better-sqlite3, Electron main process).
// One DB per workspace at <workspace>/.fusion/atlas.db, tracked in a Map so each
// open folder/tab gets its own handle (BOOTSTRAP §1: do NOT put Atlas tables in
// the userData DB). better-sqlite3's Database structurally satisfies Queryable.

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { migrate } from './schema';
import { type Queryable } from './driver';

const handles = new Map<string, Database.Database>();

const keyOf = (workspace: string) => path.resolve(workspace);

export function atlasDbPath(workspace: string): string {
  return path.join(keyOf(workspace), '.fusion', 'atlas.db');
}

export function openAtlas(workspace: string): Database.Database {
  const key = keyOf(workspace);
  const existing = handles.get(key);
  if (existing) return existing;
  const dir = path.join(key, '.fusion');
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'atlas.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db as unknown as Queryable);
  probeSqliteVec(db);
  handles.set(key, db);
  return db;
}

/**
 * Opportunistically attempt to load the sqlite-vec extension into this Electron
 * better-sqlite3 build and record the result in atlas_meta (BOOTSTRAP §3 risk
 * note: "verify it loads before committing the vec0 schema"). PURELY a probe —
 * the query path stays on the universal float32-blob + JS-cosine store (which
 * also works for the node:sqlite MCP server, where sqlite-vec isn't loaded).
 * Wrapped so it can NEVER break openAtlas. If this reports '1' on Cole's machine,
 * migrating the vector store to a real vec0 table is the (then-safe) follow-up.
 */
function probeSqliteVec(db: Database.Database): void {
  try {
    const prior = db.prepare(`SELECT value FROM atlas_meta WHERE key='sqlite_vec_available'`).get() as { value: string } | undefined;
    if (prior) return;
    let ok = false;
    try {

      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(db);
      const v = db.prepare('SELECT vec_version() AS v').get() as { v: string } | undefined;
      ok = !!v?.v;
    } catch { ok = false; }
    db.prepare(`INSERT INTO atlas_meta(key,value) VALUES('sqlite_vec_available', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(ok ? '1' : '0');
  } catch { /* never break open */ }
}

/** Whether sqlite-vec loaded on this build (probed lazily at first open). */
export function sqliteVecAvailable(workspace: string): boolean {
  const db = handles.get(keyOf(workspace));
  if (!db) return false;
  try {
    const r = db.prepare(`SELECT value FROM atlas_meta WHERE key='sqlite_vec_available'`).get() as { value: string } | undefined;
    return r?.value === '1';
  } catch { return false; }
}

export function getOpenAtlas(workspace: string): Database.Database | undefined {
  return handles.get(keyOf(workspace));
}

/** better-sqlite3 handle as the shared Queryable interface. */
export function asQueryable(db: Database.Database): Queryable {
  return db as unknown as Queryable;
}

export function closeAtlas(workspace: string): boolean {
  const key = keyOf(workspace);
  const db = handles.get(key);
  if (!db) return false;
  try { db.close(); } catch { /* already closed */ }
  handles.delete(key);
  return true;
}

export function closeAllAtlas(): void {
  for (const db of handles.values()) { try { db.close(); } catch { /* ignore */ } }
  handles.clear();
}

export function listOpenWorkspaces(): string[] {
  return [...handles.keys()];
}
