import { ipcMain, app, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import { run, which } from '../selfUpgrade/exec';
import { auditDirectory, type AuditReport } from '../lib/scanner';

/**
 * Real installer for OpenClaw extensions. Fetches the package source into
 * %APPDATA%/claw-deck/extensions/<id>/ and runs the static security scanner
 * over it so the user vets actual code, not a catalog blurb.
 *
 *   github : git clone --depth 1
 *   npm    : npm pack (tarball only, no transitive deps) + extract
 *   local  : scan the given path in place
 *
 * Fictional/unavailable refs fail honestly with the underlying tool's error.
 */
function extensionsDir(): string {
  return path.join(app.getPath('userData'), 'extensions');
}

async function scan(root: string): Promise<AuditReport> {
  return auditDirectory(root);
}

export function registerExtensionHandlers() {
  ipcMain.handle('extensions:dir', () => extensionsDir());

  ipcMain.handle('extensions:install', async (_e, opts: { id: string; kind: 'npm' | 'github' | 'local'; ref: string }) => {
    if (!opts?.id || !opts?.ref) return { ok: false, reason: 'missing id/ref' };

    if (opts.kind === 'local') {
      if (!fs.existsSync(opts.ref)) return { ok: false, reason: `local path not found: ${opts.ref}` };
      return { ok: true, path: opts.ref, report: await scan(opts.ref) };
    }

    const base = extensionsDir();
    const dest = path.join(base, opts.id);
    try {
      await fsp.mkdir(base, { recursive: true });
      await fsp.rm(dest, { recursive: true, force: true }); // clean any prior install
      await fsp.mkdir(dest, { recursive: true });

      if (opts.kind === 'github') {
        if (!(await which('git'))) return { ok: false, reason: 'git not found on PATH' };
        const url = opts.ref.startsWith('http') ? opts.ref : `https://github.com/${opts.ref}.git`;
        const r = await run('git', ['clone', '--depth', '1', url, dest], { timeoutMs: 120000 });
        if (!r.ok) return { ok: false, reason: `git clone failed: ${(r.stderr || r.stdout).slice(-400)}` };
        return { ok: true, path: dest, report: await scan(dest) };
      }

      // npm
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      if (!(await which(npm))) return { ok: false, reason: 'npm not found on PATH' };
      const packed = await run(npm, ['pack', opts.ref, '--pack-destination', dest], { cwd: dest, timeoutMs: 120000 });
      if (!packed.ok) return { ok: false, reason: `npm pack failed: ${(packed.stderr || packed.stdout).slice(-400)}` };
      const tgz = (await fsp.readdir(dest)).find(f => f.endsWith('.tgz'));
      if (!tgz) return { ok: false, reason: 'npm pack produced no tarball' };
      const ex = await run('tar', ['-xzf', path.join(dest, tgz), '-C', dest], { timeoutMs: 60000 });
      if (!ex.ok) return { ok: false, reason: `extract failed (need tar on PATH): ${(ex.stderr || ex.stdout).slice(-400)}` };
      // npm tarballs unpack into ./package
      const scanRoot = fs.existsSync(path.join(dest, 'package')) ? path.join(dest, 'package') : dest;
      return { ok: true, path: scanRoot, report: await scan(scanRoot) };
    } catch (e: any) {
      return { ok: false, reason: e.message };
    }
  });

  ipcMain.handle('extensions:uninstall', async (_e, opts: { id: string }) => {
    try {
      await fsp.rm(path.join(extensionsDir(), opts.id), { recursive: true, force: true });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, reason: e.message };
    }
  });

  ipcMain.handle('extensions:open', async (_e, opts: { id: string }) => {
    const p = path.join(extensionsDir(), opts.id);
    await shell.openPath(p);
    return { ok: true, path: p };
  });
}
