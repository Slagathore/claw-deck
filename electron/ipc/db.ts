import Database from 'better-sqlite3';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

let db: Database.Database;

export async function initDb() {
  const dir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dir, { recursive: true });
  db = new Database(path.join(dir, 'clawdeck.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      backend TEXT NOT NULL,
      model TEXT,
      prompt TEXT,
      response TEXT,
      thinking TEXT,
      tags TEXT,
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_history_ts ON history(ts DESC);
    CREATE TABLE IF NOT EXISTS upgrades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      source_url TEXT,
      sha256 TEXT,
      signature TEXT,
      installed_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      rollback_path TEXT,
      notes TEXT
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      prev_hash TEXT,
      hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      template TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '[]',
      defaults TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_prompts_name ON prompts(name);
    CREATE TABLE IF NOT EXISTS council_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      repo TEXT,
      protocol TEXT NOT NULL,
      task TEXT,
      assignment TEXT,
      status TEXT NOT NULL,
      approved INTEGER NOT NULL DEFAULT 0,
      started INTEGER NOT NULL,
      finished INTEGER,
      result TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_council_started ON council_runs(started DESC);
    CREATE TABLE IF NOT EXISTS executor_runs (
      run_id TEXT PRIMARY KEY,
      repo TEXT NOT NULL,
      mode TEXT NOT NULL,
      status TEXT NOT NULL,
      wt_dir TEXT,
      branch TEXT,
      plan_path TEXT,
      diff_path TEXT,
      diff_bytes INTEGER NOT NULL DEFAULT 0,
      validation_ok INTEGER,
      snapshot_id TEXT,
      started INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_executor_updated ON executor_runs(updated DESC);
  `);
  // additive migrations — safe to run on every boot
  migrate('upgrades', 'install_path', 'TEXT');
  migrate('upgrades', 'backup_path', 'TEXT');
  // council run resume checkpoint (phase index + accumulated state)
  migrate('council_runs', 'phase_index', 'INTEGER');
  migrate('council_runs', 'artifact', 'TEXT');
  migrate('council_runs', 'transcript', 'TEXT');
  migrate('council_runs', 'verdicts', 'TEXT');
  migrate('council_runs', 'resumable', 'INTEGER');
}

function migrate(table: string, col: string, type: string) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some(c => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}

export function getDb(): Database.Database {
  if (!db) throw new Error('DB not initialised');
  return db;
}
