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
  `);
  // additive migrations — safe to run on every boot
  migrate('upgrades', 'install_path', 'TEXT');
  migrate('upgrades', 'backup_path', 'TEXT');
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
