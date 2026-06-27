// Atlas SQLite DDL — one DB per workspace at <workspace>/.fusion/atlas.db.
// Standard SQLite so it runs identically under better-sqlite3 and node:sqlite.
// `migrate()` is idempotent (CREATE ... IF NOT EXISTS). Deviations from
// BOOTSTRAP §4.1, all supersets:
//   - atlas_symbols.key TEXT UNIQUE: parser key (<relPath>#<qn>); qualified_name
//     is not unique across files, so we need this to attach edges / do
//     incremental updates.
//   - atlas_embeddings(symbol_id, dim, vec BLOB): float32 fallback vector store
//     (JS cosine in query.ts) instead of a vec0 virtual table, until sqlite-vec
//     is verified to load in this Electron build (see RECON.md / BOOTSTRAP §3).
//   - atlas_meta(key,value): schema version + resumable embed/summarize cursors.

import { type Queryable } from './driver';

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS atlas_meta (
  key TEXT PRIMARY KEY, value TEXT
);
CREATE TABLE IF NOT EXISTS atlas_files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  lang TEXT NOT NULL,
  hash TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  git_last_date INTEGER
);
CREATE TABLE IF NOT EXISTS atlas_symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES atlas_files(id) ON DELETE CASCADE,
  key TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  signature TEXT,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  doc TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  superseded_by INTEGER REFERENCES atlas_symbols(id),
  ref_count INTEGER NOT NULL DEFAULT 0,
  last_seen_run INTEGER
);
CREATE TABLE IF NOT EXISTS atlas_edges (
  id INTEGER PRIMARY KEY,
  src INTEGER NOT NULL REFERENCES atlas_symbols(id) ON DELETE CASCADE,
  dst INTEGER NOT NULL REFERENCES atlas_symbols(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS atlas_runs (
  id INTEGER PRIMARY KEY,
  started INTEGER, finished INTEGER,
  files_indexed INTEGER, symbols INTEGER, mode TEXT
);
CREATE TABLE IF NOT EXISTS atlas_embeddings (
  symbol_id INTEGER PRIMARY KEY REFERENCES atlas_symbols(id) ON DELETE CASCADE,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sym_file ON atlas_symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_sym_name ON atlas_symbols(name);
CREATE INDEX IF NOT EXISTS idx_sym_status ON atlas_symbols(status);
CREATE INDEX IF NOT EXISTS idx_edge_src ON atlas_edges(src);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON atlas_edges(dst);
`;

export function migrate(db: Queryable): void {
  db.exec(SCHEMA_SQL);
  const row = db.prepare(`SELECT value FROM atlas_meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
  if (!row) {
    db.prepare(`INSERT INTO atlas_meta(key, value) VALUES('schema_version', ?)`).run(String(SCHEMA_VERSION));
  }
}
