import { ipcMain, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { getDb } from './db';
import { yaraScan, type ScanResult } from './yara';

export type { ScanResult };

export interface ScanOptions {
  yaraRulesPath?: string;
  yaraBinary?: string;
}

export async function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

export function isHostAllowed(url: string, allowlist: string[]): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return allowlist.some(h => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch { return false; }
}

async function defenderScan(file: string): Promise<ScanResult> {
  return new Promise(resolve => {
    if (process.platform !== 'win32') {
      return resolve({ ok: true, available: false, engine: 'defender', detail: 'skipped: non-windows' });
    }
    const mp = 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe';
    if (!fs.existsSync(mp)) return resolve({ ok: true, available: false, engine: 'defender', detail: 'MpCmdRun not found' });
    const p = spawn(mp, ['-Scan', '-ScanType', '3', '-File', file, '-DisableRemediation']);
    let out = '';
    p.stdout.on('data', d => (out += d.toString()));
    p.stderr.on('data', d => (out += d.toString()));
    p.on('exit', code => {
      // exit 0 = clean, 2 = threats found
      resolve({ ok: code === 0, available: true, engine: 'defender', detail: `code=${code} ${out.slice(0, 400)}` });
    });
    // MpCmdRun.exe existed but failed to run (permissions, mid-scan crash, etc).
    // Treat as a real, failed attempt rather than a silent skip.
    p.on('error', e => resolve({ ok: false, available: true, engine: 'defender', detail: e.message }));
  });
}

async function clamscan(file: string): Promise<ScanResult> {
  return new Promise(resolve => {
    const p = spawn('clamscan', ['--no-summary', file]);
    let out = '';
    p.stdout.on('data', d => (out += d.toString()));
    p.on('exit', code => resolve({ ok: code === 0, available: true, engine: 'clamav', detail: out.slice(0, 400) }));
    p.on('error', () => resolve({ ok: true, available: false, engine: 'clamav', detail: 'clamscan not installed' }));
  });
}

/**
 * Runs every AV engine (Defender, ClamAV, YARA) in parallel. Each result
 * carries its own `available` flag — see ScanResult — so a caller can tell
 * "this engine ran and found nothing" apart from "this engine never ran."
 * `scanFile` itself does not collapse that distinction; see
 * `upgrades:install`'s `scanned` flag for a caller that does.
 */
export async function scanFile(file: string, opts: ScanOptions = {}): Promise<ScanResult[]> {
  const results = await Promise.all([
    defenderScan(file),
    clamscan(file),
    yaraScan(file, { rulesPath: opts.yaraRulesPath, binary: opts.yaraBinary })
  ]);
  return results;
}

export function registerSecurityHandlers() {
  ipcMain.handle('security:hash', (_e, file: string) => sha256OfFile(file));
  ipcMain.handle('security:scan', async (_e, file: string) => {
    const settings = await loadSettings();
    const results = await scanFile(file, {
      yaraRulesPath: settings.yaraRulesPath,
      yaraBinary: settings.yaraBinary
    });
    appendAudit('scan', { file, results });
    return results;
  });
  ipcMain.handle('security:audit', () => {
    return getDb().prepare('SELECT * FROM audit ORDER BY id DESC LIMIT 500').all();
  });
  ipcMain.handle('security:verifyAuditLog', (): ChainVerifyResult => {
    const rows = getDb().prepare('SELECT id, ts, kind, payload, prev_hash, hash FROM audit ORDER BY id ASC').all() as AuditRow[];
    return verifyChain(rows);
  });
}

function loadSettings(): Promise<any> {
  const db = getDb();
  const rows = db.prepare('SELECT key,value FROM settings').all() as { key: string; value: string }[];
  const out: any = {};
  for (const r of rows) try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  return Promise.resolve(out);
}

export function appendAudit(kind: string, payload: any) {
  const db = getDb();
  const prev = db.prepare('SELECT hash FROM audit ORDER BY id DESC LIMIT 1').get() as { hash: string } | undefined;
  const prevHash = prev?.hash ?? '';
  const body = JSON.stringify(payload);
  const ts = Date.now();
  const hash = crypto.createHash('sha256').update(prevHash + ts + kind + body).digest('hex');
  db.prepare('INSERT INTO audit(ts,kind,payload,prev_hash,hash) VALUES(?,?,?,?,?)')
    .run(ts, kind, body, prevHash, hash);
  return hash;
}

export interface AuditRow {
  id: number;
  ts: number;
  kind: string;
  payload: string;
  prev_hash: string | null;
  hash: string;
}

export interface ChainVerifyResult {
  ok: boolean;
  checked: number;
  brokenAtId?: number;
  reason?: string;
}

/**
 * Recompute each row's hash from (prevHash + ts + kind + payload), the same
 * formula `appendAudit` uses, and confirm it matches the stored hash AND that
 * prev_hash correctly links back to the previous row. The ledger was already
 * written as a hash chain; this is what actually walks it and would notice if
 * a row were edited or deleted out from under it. Pure — takes rows instead of
 * touching the DB itself — so it can be unit tested without an Electron `app`.
 */
export function verifyChain(rows: AuditRow[]): ChainVerifyResult {
  let prevHash = '';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if ((row.prev_hash ?? '') !== prevHash) {
      return { ok: false, checked: i, brokenAtId: row.id, reason: `prev_hash does not match the preceding row's hash at audit id ${row.id}` };
    }
    const expected = crypto.createHash('sha256').update(prevHash + row.ts + row.kind + row.payload).digest('hex');
    if (expected !== row.hash) {
      return { ok: false, checked: i, brokenAtId: row.id, reason: `stored hash does not match recomputed hash at audit id ${row.id}` };
    }
    prevHash = row.hash;
  }
  return { ok: true, checked: rows.length };
}

export function quarantineDir(): string {
  const d = path.join(app.getPath('userData'), 'quarantine');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
