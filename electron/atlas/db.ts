// Per-workspace Atlas DB handles (better-sqlite3, Electron main process).
// One DB per workspace at <workspace>/.fusion/atlas.db, tracked in a Map so each
// open folder/tab gets its own handle (BOOTSTRAP §1: do NOT put Atlas tables in
// the userData DB). better-sqlite3's Database structurally satisfies Queryable.

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { migrate } from './schema';
import { Queryable } from './driver';

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
  handles.set(key, db);
  return db;
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
