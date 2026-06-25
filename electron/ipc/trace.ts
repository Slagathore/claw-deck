import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

const MAX_FIELD = 2000;

function safeValue(v: any): any {
  if (v == null) return v;
  if (typeof v === 'string') {
    if (/bearer\s+[A-Za-z0-9._~+/=-]+/i.test(v)) return v.replace(/bearer\s+\S+/ig, 'Bearer [redacted]');
    return v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}…` : v;
  }
  if (Array.isArray(v)) return v.map(safeValue);
  if (typeof v === 'object') {
    const out: Record<string, any> = {};
    for (const [k, val] of Object.entries(v)) {
      if (/key|token|secret|authorization/i.test(k)) out[k] = val ? '[redacted]' : val;
      else out[k] = safeValue(val);
    }
    return out;
  }
  return v;
}

export function traceDir(): string {
  let userData = '';
  try { userData = app.getPath('userData'); } catch { /* plain node / early startup */ }
  if (!userData) userData = path.join(process.env.APPDATA || process.cwd(), 'claw-deck');
  const dir = path.join(userData, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function tracePath(): string {
  const d = new Date().toISOString().slice(0, 10);
  return path.join(traceDir(), `fusion-trace-${d}.jsonl`);
}

export function ensureTraceFile(): string {
  const p = tracePath();
  try {
    if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8');
  } catch {
    // caller will surface shell/open failures if needed
  }
  return p;
}

export function trace(kind: string, payload: Record<string, any> = {}) {
  try {
    const row = JSON.stringify({ ts: new Date().toISOString(), pid: process.pid, kind, ...safeValue(payload) });
    fs.appendFileSync(tracePath(), `${row}\n`, 'utf8');
  } catch {
    // Trace logging must never break the app path it is observing.
  }
}
