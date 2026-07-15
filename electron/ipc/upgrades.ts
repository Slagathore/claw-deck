import { ipcMain, app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getDb } from './db';
import { isHostAllowed, scanFile, sha256OfFile, appendAudit, quarantineDir } from './security';
import { fetchSources, type FeedSource } from './feeds';
import { verifyEd25519, type KeySpec } from './signing';
import { verifyAuthenticode } from './authenticode';
import { vtLookup, installWithBackup, restoreBackup } from './reputation';
import { launchInstaller } from './installer';

interface UpgradeManifest {
  kind: 'openclaw' | 'self';
  name: string;
  version: string;
  url: string;            // download URL
  sha256?: string;        // expected hash
  signature?: string;     // base64 ed25519 detached signature over the binary
  installPath?: string;   // absolute path; when set, vetted binary is copied here
  notes?: string;
  /**
   * Run the vetted file as an installer once it passes every gate (Windows NSIS).
   * This is how Claw Deck updates itself: the app cannot overwrite its own files
   * while it is running, so the installer is launched and the app then quits.
   */
  launchInstaller?: boolean;
  /** Pass /S to the NSIS installer (no wizard). */
  silentInstall?: boolean;
  /**
   * Explicit, one-shot user acknowledgement that this specific install has no
   * verifiable signature. Only consulted when policy.requireSignature is true
   * AND no signature was provided — it never bypasses a hash mismatch, a
   * failed scan, or an actual signature verification failure. The UI must set
   * this only after a distinct confirmation click in response to
   * `requiresUnsignedConfirmation` below, never by default.
   */
  acceptUnsigned?: boolean;
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
        note: 'Air-gapped mode is enabled. No remote feeds polled.'
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

    // 3. Signature verification.
    //
    // Two independent, real trust signals — a file is trusted if EITHER holds:
    //   (a) Ed25519: a detached signature in the manifest verifies against a
    //       configured public key (the manual-install path).
    //   (b) Authenticode: the Windows installer we are about to RUN carries a
    //       valid Authenticode signature from the pinned publisher. This is the
    //       signature Windows itself validates; verifying it here is what lets a
    //       genuine update install without the "install unsigned anyway" prompt.
    const signingKeys: KeySpec[] = settings.policy?.signingKeys ?? [];
    let signatureTrust: 'ed25519' | 'authenticode' | 'none' = 'none';

    if (m.signature) {
      const v = verifyEd25519(buf, m.signature, signingKeys);
      if (!v.ok) {
        appendAudit('upgrade:signature_invalid', { manifest: m, reason: v.reason });
        try { fs.unlinkSync(dest); } catch {}
        return { ok: false, reason: `Signature verification failed: ${v.reason}` };
      }
      signatureTrust = 'ed25519';
    }

    // Authenticode: only for a Windows installer we were actually asked to launch.
    // A launchable .exe that fails this check is exactly what we must never run,
    // so a failure REFUSES outright — it is not offered the unsigned bypass.
    if (signatureTrust === 'none' && m.launchInstaller && process.platform === 'win32') {
      const auth = await verifyAuthenticode(dest);
      if (auth.ok) {
        signatureTrust = 'authenticode';
        appendAudit('upgrade:authenticode_verified', { manifest: m, subject: auth.subject, cn: auth.cn });
      } else {
        appendAudit('upgrade:authenticode_failed', { manifest: m, status: auth.status, cn: auth.cn, reason: auth.reason });
        try { fs.unlinkSync(dest); } catch {}
        return { ok: false, reason: `Authenticode verification failed: ${auth.reason}. Refusing to run this installer.` };
      }
    }

    // No trusted signature and policy demands one. Block by default — but if the
    // user already clicked through the "install unsigned anyway" confirmation for
    // THIS install (m.acceptUnsigned), let it through and say so in the audit log.
    // requiresUnsignedConfirmation tells the UI to show that confirmation rather
    // than a dead end. (Not reachable for a valid Windows installer above: that
    // path either trusts Authenticode or has already refused.)
    if (signatureTrust === 'none' && settings.policy?.requireSignature) {
      if (!m.acceptUnsigned) {
        appendAudit('upgrade:no_signature', { manifest: m });
        try { fs.unlinkSync(dest); } catch {}
        return { ok: false, reason: 'Policy requires a signature; none provided.', requiresUnsignedConfirmation: true };
      }
      appendAudit('upgrade:unsigned_accepted', { manifest: m });
    }

    // 4. AV scan (+ optional VirusTotal hash reputation)
    let scanResults: any[] = [];
    if (settings.policy?.autoScan !== false) {
      scanResults = await scanFile(dest, {
        yaraRulesPath: settings.yaraRulesPath,
        yaraBinary: settings.yaraBinary
      });
      const bad = scanResults.find(s => !s.ok);
      if (bad) {
        appendAudit('upgrade:scan_failed', { manifest: m, scanResults });
        try { fs.unlinkSync(dest); } catch {}
        return { ok: false, reason: `Scan failed (${bad.engine}): ${bad.detail}`, scanResults };
      }
    }
    if (settings.virusTotalApiKey) {
      const vt = await vtLookup(actual, settings.virusTotalApiKey, { timeoutMs: 8000 });
      if (vt) {
        scanResults.push({ engine: 'virustotal', ok: vt.ok, detail: vt.detail, available: true });
        if (!vt.ok) {
          appendAudit('upgrade:vt_flagged', { manifest: m, sha256: actual, vt });
          try { fs.unlinkSync(dest); } catch {}
          return { ok: false, reason: vt.detail, scanResults };
        }
      }
    }

    // Whether any engine actually ran, as opposed to every engine soft-skipping
    // because it isn't installed/configured. `ok:true` on scanResults with
    // scanned:false means "nothing blocked it because nothing looked" — the UI
    // should say "unscanned", not "clean".
    const scanned = scanResults.some(s => s.available !== false);

    // 5. Install: if installPath is set, copy from quarantine (with backup);
    //    otherwise the quarantined file IS the install location.
    let installPath: string | null = null;
    let backup: string | null = null;
    if (m.installPath) {
      try {
        const r = installWithBackup(dest, m.installPath);
        installPath = m.installPath;
        backup = r.backup;
      } catch (e: any) {
        appendAudit('upgrade:install_copy_failed', { manifest: m, error: e?.message });
        return { ok: false, reason: `Install copy failed: ${e?.message}`, scanResults };
      }
    }

    // 5b. Run the installer. This is the step that makes an update an update:
    //     the vetted NSIS .exe is launched detached and the app quits so the
    //     installer can replace files that are currently open. Nothing here is
    //     reported as installed unless the OS confirmed the process started.
    let installerLaunched = false;
    let installerReason: string | null = null;
    if (m.launchInstaller) {
      const r = await launchInstaller(dest, { quarantineDir: qDir, silent: !!m.silentInstall });
      installerLaunched = r.ok;
      installerReason = r.ok ? null : (r.reason ?? 'unknown');
      appendAudit(r.ok ? 'upgrade:installer_launched' : 'upgrade:installer_launch_failed', {
        manifest: m, file: dest, pid: r.pid, args: r.args, reason: r.reason
      });
    } else if (!m.installPath) {
      installerReason = 'no install step was requested; the vetted file was left in quarantine';
    }

    // 6. Record. `status` says what really happened, so the history tab cannot
    //    claim an install that never occurred.
    const status = installerLaunched ? 'installer_launched' : (installPath ? 'installed' : 'downloaded');
    const db = getDb();
    const info = db.prepare(`
      INSERT INTO upgrades(kind,name,version,source_url,sha256,signature,installed_at,status,rollback_path,install_path,backup_path,notes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(m.kind, m.name, m.version, m.url, actual, m.signature ?? null, Date.now(), status, dest, installPath, backup, m.notes ?? null);

    appendAudit('upgrade:recorded', { manifest: m, sha256: actual, file: dest, status, installPath, backup, scanResults, scanned });

    if (installerLaunched) {
      // Give the renderer a beat to show "installer launched", then get out of the
      // installer's way. NSIS cannot replace an executable that is still running.
      setTimeout(() => { try { app.quit(); } catch { /* already quitting */ } }, 1500);
    }

    // A launch that was asked for and did not happen is a FAILURE, even though the
    // download and every security gate passed. Say so.
    if (m.launchInstaller && !installerLaunched) {
      return {
        ok: false,
        reason: `Downloaded and verified, but the installer did not run: ${installerReason}. The vetted file is at ${dest}, you can run it yourself.`,
        id: info.lastInsertRowid, sha256: actual, file: dest, status, scanResults, scanned, installerLaunched: false
      };
    }

    return {
      ok: true,
      id: info.lastInsertRowid,
      sha256: actual,
      file: dest,
      status,
      installPath,
      backup,
      scanResults,
      scanned,
      installerLaunched,
      installerReason,
      quitting: installerLaunched
    };
  });

  ipcMain.handle('upgrades:rollback', (_e, id: number) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM upgrades WHERE id=?').get(id) as any | undefined;
    if (!row) return { ok: false, reason: 'no such upgrade' };
    const changed = restoreBackup(row.install_path ?? null, row.backup_path ?? null);
    db.prepare("UPDATE upgrades SET status='rolled_back' WHERE id=?").run(id);
    appendAudit('upgrade:rollback', { id, changed, installPath: row.install_path, backup: row.backup_path });
    return { ok: true, changed };
  });
}
