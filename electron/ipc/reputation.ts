import * as fs from 'fs';
import * as path from 'path';
import { summarizeVtResponse, VtSummary } from './signing';

/**
 * Optional VirusTotal v3 hash lookup (no upload). Returns null when no API key
 * is configured. Soft-fails on network/timeout to never break the upgrade
 * pipeline on a flaky reputation service.
 */
export async function vtLookup(
  sha256: string,
  apiKey: string,
  opts: { fetcher?: typeof fetch; timeoutMs?: number } = {}
): Promise<VtSummary | null> {
  if (!apiKey || !sha256) return null;
  const f = opts.fetcher ?? fetch;
  const ctrl = new AbortController();
  const t = opts.timeoutMs ? setTimeout(() => ctrl.abort(), opts.timeoutMs) : null;
  try {
    const r = await f(`https://www.virustotal.com/api/v3/files/${sha256}`, {
      headers: { 'x-apikey': apiKey, 'Accept': 'application/json' },
      signal: ctrl.signal
    });
    if (r.status === 404) {
      return { ok: true, malicious: 0, suspicious: 0, harmless: 0, undetected: 0, detail: 'VT: hash unknown (not previously seen)' };
    }
    if (!r.ok) {
      return { ok: true, malicious: 0, suspicious: 0, harmless: 0, undetected: 0, detail: `VT: lookup failed HTTP ${r.status}` };
    }
    const j = await r.json();
    return summarizeVtResponse(j);
  } catch (e: any) {
    return { ok: true, malicious: 0, suspicious: 0, harmless: 0, undetected: 0, detail: `VT: lookup error ${e?.message ?? 'unknown'}` };
  } finally {
    if (t) clearTimeout(t);
  }
}

/**
 * Copy `src` to `dest`, returning a backup path of any pre-existing `dest`
 * (or null if there was none). The backup lives next to dest with a
 * .bak-<timestamp> suffix so rollback can find it.
 */
export function installWithBackup(src: string, dest: string): { backup: string | null } {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let backup: string | null = null;
  if (fs.existsSync(dest)) {
    backup = `${dest}.bak-${Date.now()}`;
    fs.renameSync(dest, backup);
  }
  fs.copyFileSync(src, dest);
  return { backup };
}

/**
 * Restore a previously backed-up file. If `backup` is null we just delete the
 * currently installed binary. Returns whether anything was actually changed.
 */
export function restoreBackup(installPath: string | null, backupPath: string | null): boolean {
  if (!installPath) return false;
  if (backupPath && fs.existsSync(backupPath)) {
    try { fs.unlinkSync(installPath); } catch { /* may not exist */ }
    fs.renameSync(backupPath, installPath);
    return true;
  }
  if (fs.existsSync(installPath)) {
    try { fs.unlinkSync(installPath); return true; } catch { return false; }
  }
  return false;
}
