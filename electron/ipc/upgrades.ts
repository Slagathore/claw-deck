import { ipcMain } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getDb } from './db';
import { isHostAllowed, scanFile, sha256OfFile, appendAudit, quarantineDir } from './security';
import { fetchSources, FeedSource } from './feeds';

interface UpgradeManifest {
  kind: 'openclaw' | 'self';
  name: string;
  version: string;
  url: string;            // download URL
  sha256?: string;        // expected hash
  signature?: string;     // signature blob (informational)
  notes?: string;
}

async function fetchSettings(): Promise<any> {
  const db = getDb();
  const rows = db.prepare('SELECT key,value FROM settings').all() as { key: string; value: string }[];
  const out: any = {};
  for (const r of rows) try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  return out;
}

export function registerUpgradeHandlers() {
  ipcMain.handle('upgrades:list', () => {
    return getDb().prepare('SELECT * FROM upgrades ORDER BY installed_at DESC').all();
  });

  ipcMain.handle('upgrades:check', async (_e, kind: 'openclaw' | 'self') => {
    const settings = await fetchSettings();
    if (settings.airgapped) {
      return {
        kind,
        candidates: [],
        note: 'Air-gapped mode is enabled — no remote feeds polled.'
      };
    }
    const feeds: Record<string, string[] | undefined> = settings.feeds ?? {};
    const repos: string[] = (feeds[kind] ?? []).filter(Boolean);
    if (repos.length === 0) {
      return {
        kind,
        candidates: [],
        note: `No release feeds configured for "${kind}". Add GitHub repos in Settings → Upgrade Feeds.`
      };
    }
    const sources: FeedSource[] = repos.map(repo => ({ repo }));
    const candidates = await fetchSources(sources, { githubToken: settings.githubToken, timeoutMs: 8000 });
    appendAudit('upgrade:checked', { kind, repos, found: candidates.length });
    return {
      kind,
      candidates,
      note: candidates.length === 0
        ? 'No releases found (or all requests failed). Check the repo names and network.'
        : `Found ${candidates.length} release(s).`
    };
  });

  ipcMain.handle('upgrades:install', async (_e, m: UpgradeManifest) => {
    const settings = await fetchSettings();
    if (settings.airgapped) {
      appendAudit('upgrade:blocked', { reason: 'airgapped', manifest: m });
      return { ok: false, reason: 'Air-gapped mode is enabled.' };
    }
    const allowlist: string[] = settings.policy?.allowlist ?? [];
    if (!isHostAllowed(m.url, allowlist)) {
      appendAudit('upgrade:blocked', { reason: 'host not allowlisted', manifest: m });
      return { ok: false, reason: `Host not in allowlist. Allowed: ${allowlist.join(', ')}` };
    }

    // 1. Download to quarantine
    const qDir = quarantineDir();
    const fname = path.basename(new URL(m.url).pathname) || `${m.name}-${m.version}.bin`;
    const dest = path.join(qDir, `${Date.now()}-${fname}`);
    const r = await fetch(m.url);
    if (!r.ok) {
      appendAudit('upgrade:download_failed', { manifest: m, status: r.status });
      return { ok: false, reason: `Download failed: HTTP ${r.status}` };
    }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(dest, buf);

    // 2. Hash check
    const actual = await sha256OfFile(dest);
    if (m.sha256 && actual.toLowerCase() !== m.sha256.toLowerCase()) {
      appendAudit('upgrade:hash_mismatch', { manifest: m, actual });
      try { fs.unlinkSync(dest); } catch {}
      return { ok: false, reason: `SHA-256 mismatch. expected ${m.sha256} got ${actual}` };
    }

    // 3. Signature placeholder (require if policy says so)
    if (settings.policy?.requireSignature && !m.signature) {
      appendAudit('upgrade:no_signature', { manifest: m });
      try { fs.unlinkSync(dest); } catch {}
      return { ok: false, reason: 'Policy requires a signature; none provided.' };
    }

    // 4. AV scan
    let scanResults: any[] = [];
    if (settings.policy?.autoScan !== false) {
      scanResults = await scanFile(dest);
      const bad = scanResults.find(s => !s.ok);
      if (bad) {
        appendAudit('upgrade:scan_failed', { manifest: m, scanResults });
        try { fs.unlinkSync(dest); } catch {}
        return { ok: false, reason: `Scan failed (${bad.engine}): ${bad.detail}`, scanResults };
      }
    }

    // 5. Record
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO upgrades(kind,name,version,source_url,sha256,signature,installed_at,status,rollback_path,notes)
      VALUES(?,?,?,?,?,?,?,?,?,?)
    `).run(m.kind, m.name, m.version, m.url, actual, m.signature ?? null, Date.now(), 'installed', dest, m.notes ?? null);

    appendAudit('upgrade:installed', { manifest: m, sha256: actual, file: dest, scanResults });
    return { ok: true, id: info.lastInsertRowid, sha256: actual, file: dest, scanResults };
  });

  ipcMain.handle('upgrades:rollback', (_e, id: number) => {
    const db = getDb();
    db.prepare("UPDATE upgrades SET status='rolled_back' WHERE id=?").run(id);
    appendAudit('upgrade:rollback', { id });
    return true;
  });
}
