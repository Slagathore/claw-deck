import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';

/**
 * Resolves the *writable* source tree that the self-upgrader operates on.
 *  - Dev mode  → the actual workspace (project root, i.e. parent of `dist-electron`).
 *  - Packaged  → %APPDATA%/claw-deck/source/  (bootstrapped on first run).
 */
export function sourceRoot(): string {
  if (!app.isPackaged) {
    // dist-electron/main.js lives at <repo>/dist-electron/, so go up one.
    return path.resolve(__dirname, '..', '..');
  }
  return path.join(app.getPath('userData'), 'source');
}

export function snapshotsDir(): string {
  return path.join(app.getPath('userData'), 'self-upgrade-snapshots');
}

export function logsDir(): string {
  return path.join(app.getPath('userData'), 'self-upgrade-logs');
}

async function dirHasContents(p: string): Promise<boolean> {
  try {
    const entries = await fsp.readdir(p);
    return entries.length > 0;
  } catch {
    return false;
  }
}

async function copyDir(src: string, dst: string, skip: Set<string>): Promise<void> {
  await fsp.mkdir(dst, { recursive: true });
  const entries = await fsp.readdir(src, { withFileTypes: true });
  for (const ent of entries) {
    if (skip.has(ent.name)) continue;
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    if (ent.isDirectory()) await copyDir(s, d, skip);
    else if (ent.isFile()) await fsp.copyFile(s, d);
  }
}

/**
 * Ensure the writable source tree exists. Returns the path.
 * Strategy when packaged & empty:
 *   1. Copy from `process.resourcesPath/source/` if shipped via extraResources.
 *   2. Otherwise return path + flag so caller can prompt user to clone from GitHub.
 */
export async function ensureSourceTree(): Promise<{ path: string; ready: boolean; reason?: string }> {
  const root = sourceRoot();
  if (!app.isPackaged) return { path: root, ready: true };

  await fsp.mkdir(root, { recursive: true });
  if (await dirHasContents(root)) return { path: root, ready: true };

  const bundled = path.join(process.resourcesPath || '', 'source');
  if (bundled && fs.existsSync(bundled)) {
    try {
      await copyDir(bundled, root, new Set(['node_modules', 'dist', 'dist-electron', 'dist-installer', '.git']));
      return { path: root, ready: true };
    } catch (e: any) {
      return { path: root, ready: false, reason: `bundled copy failed: ${e.message}` };
    }
  }

  return { path: root, ready: false, reason: 'source tree absent — run a git clone via the UI' };
}

export async function ensureSnapshotsDir(): Promise<string> {
  const d = snapshotsDir();
  await fsp.mkdir(d, { recursive: true });
  return d;
}

export async function ensureLogsDir(): Promise<string> {
  const d = logsDir();
  await fsp.mkdir(d, { recursive: true });
  return d;
}
