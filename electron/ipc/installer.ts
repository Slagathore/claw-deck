import * as fs from 'fs';
import * as path from 'path';
import { spawn, type SpawnOptions } from 'child_process';

/**
 * Actually installing an update.
 *
 * The old flow downloaded the release installer into userData\quarantine, ran the
 * hash / Ed25519 / AV gates on it, and then… stopped, because the self-update UI
 * never set `installPath`. It told the user "Installed — restart Claw Deck",
 * which was false: nothing had been installed and a restart changed nothing.
 *
 * Claw Deck ships as an electron-builder NSIS installer, so the honest way to
 * install an update is to RUN that installer and get out of its way: NSIS cannot
 * replace files that a running process has open. So we spawn the vetted .exe
 * detached, confirm the OS really started it, and only then quit the app. If the
 * spawn fails (UAC declined, file blocked, wrong file type), we say so and stay
 * running — the caller must never report success on a launch that did not happen.
 */

export type SpawnFn = typeof spawn;

export interface LaunchOpts {
  /** Only files inside this directory may be launched. */
  quarantineDir: string;
  /** NSIS silent install (/S). Off by default: the user sees the wizard and stays in control. */
  silent?: boolean;
  spawnFn?: SpawnFn;
  /** How long to wait for the OS to confirm the process started. */
  timeoutMs?: number;
}

export interface LaunchResult {
  ok: boolean;
  reason?: string;
  pid?: number;
  file?: string;
  args?: string[];
}

/**
 * Pure: is this a file we are willing to execute?
 * Must be an existing .exe inside the quarantine dir we downloaded it to — never
 * an arbitrary path handed to us by a renderer or a feed.
 */
export function validateInstallerPath(
  file: string,
  quarantineDir: string,
  exists: (p: string) => boolean = fs.existsSync
): { ok: true } | { ok: false; reason: string } {
  if (!file || !path.isAbsolute(file)) return { ok: false, reason: 'installer path must be absolute' };
  const q = path.resolve(quarantineDir);
  const f = path.resolve(file);
  const rel = path.relative(q, f);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: `installer must live inside the quarantine directory (${q})` };
  }
  if (path.extname(f).toLowerCase() !== '.exe') {
    return { ok: false, reason: `not an installer executable: ${path.basename(f)}` };
  }
  if (!exists(f)) return { ok: false, reason: `installer file is missing: ${f}` };
  return { ok: true };
}

/**
 * Flags the electron-builder NSIS installer understands.
 * `/S` = silent (no wizard). `/D=` would set the target dir; we deliberately do
 * not pass it, so the installer reuses the location of the existing install.
 */
export function installerArgs(opts: { silent?: boolean }): string[] {
  return opts.silent ? ['/S'] : [];
}

/**
 * Launch the installer and confirm it started. Resolves ok:false — never throws —
 * so the caller can report the real reason to the user.
 */
export async function launchInstaller(file: string, opts: LaunchOpts): Promise<LaunchResult> {
  if (process.platform !== 'win32') {
    return { ok: false, reason: `automatic install is only wired up for the Windows NSIS installer (this is ${process.platform})` };
  }
  const v = validateInstallerPath(file, opts.quarantineDir);
  if (!v.ok) return { ok: false, reason: v.reason, file };

  const args = installerArgs({ silent: opts.silent });
  const spawnFn = opts.spawnFn ?? spawn;
  const spawnOpts: SpawnOptions = { detached: true, stdio: 'ignore', windowsHide: false };

  return await new Promise<LaunchResult>(resolve => {
    let settled = false;
    const finish = (r: LaunchResult) => { if (!settled) { settled = true; resolve(r); } };
    let child: ReturnType<SpawnFn>;
    try {
      child = spawnFn(file, args, spawnOpts);
    } catch (e: any) {
      finish({ ok: false, reason: `could not start the installer: ${e?.message ?? e}`, file, args });
      return;
    }

    const timer = setTimeout(
      () => finish({ ok: false, reason: 'the installer did not start within the timeout', file, args }),
      opts.timeoutMs ?? 8000
    );

    child.on('error', (e: Error) => {
      clearTimeout(timer);
      // ERROR_CANCELLED (1223) is what Windows returns when the user declines the
      // UAC prompt — surface that as the human reason, not a raw errno.
      const msg = /1223|cancell?ed/i.test(String(e?.message))
        ? 'the Windows elevation prompt was declined, so the installer never ran'
        : `could not start the installer: ${e.message}`;
      finish({ ok: false, reason: msg, file, args });
    });

    // Node emits 'spawn' only once the OS has actually created the process.
    child.on('spawn', () => {
      clearTimeout(timer);
      try { child.unref(); } catch { /* already detached */ }
      finish({ ok: true, pid: child.pid, file, args });
    });

    // An installer that exits immediately with a non-zero code never installed
    // anything (e.g. it refused to run). Only meaningful before 'spawn' resolves.
    child.on('exit', (code: number | null) => {
      if (settled) return;
      clearTimeout(timer);
      finish({ ok: false, reason: `the installer exited immediately with code ${code}`, file, args });
    });
  });
}
