import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { validateInstallerPath, installerArgs, launchInstaller } from '../electron/ipc/installer';

// A real quarantine dir with real files, so validateInstallerPath's on-disk
// existence check behaves exactly as it will in production.
let QDIR = '';
beforeAll(() => {
  QDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdeck-qtn-'));
  fs.writeFileSync(path.join(QDIR, 'Claw Deck-1.0.3-x64.exe'), 'MZ');
  fs.writeFileSync(path.join(QDIR, 'setup.exe'), 'MZ');
  fs.writeFileSync(path.join(QDIR, 'notes.txt'), 'hi');
});
afterAll(() => fs.rmSync(QDIR, { recursive: true, force: true }));
const inside = (name: string) => path.join(QDIR, name);

describe('validateInstallerPath', () => {
  it('accepts an existing .exe inside quarantine', () => {
    expect(validateInstallerPath(inside('Claw Deck-1.0.3-x64.exe'), QDIR)).toEqual({ ok: true });
  });
  it('rejects a path outside quarantine (traversal)', () => {
    const evil = path.join(QDIR, '..', 'system32', 'evil.exe');
    expect(validateInstallerPath(evil, QDIR).ok).toBe(false);
  });
  it('rejects a non-exe file', () => {
    const r = validateInstallerPath(inside('notes.txt'), QDIR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/installer executable/i);
  });
  it('rejects a missing file', () => {
    const r = validateInstallerPath(inside('gone.exe'), QDIR);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/missing/i);
  });
  it('rejects a relative path', () => {
    expect(validateInstallerPath('setup.exe', QDIR).ok).toBe(false);
  });
});

describe('installerArgs', () => {
  it('is empty by default (the user sees the wizard)', () => {
    expect(installerArgs({})).toEqual([]);
  });
  it('passes /S for a silent install', () => {
    expect(installerArgs({ silent: true })).toEqual(['/S']);
  });
});

describe('launchInstaller', () => {
  const winOnly = process.platform === 'win32' ? it : it.skip;

  it('refuses on a non-windows platform', async () => {
    if (process.platform === 'win32') return; // covered by the win path below
    const r = await launchInstaller(inside('setup.exe'), { quarantineDir: QDIR });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/windows/i);
  });

  winOnly('reports success only after the OS confirms the process started', async () => {
    const child: any = new EventEmitter();
    child.pid = 4242;
    child.unref = vi.fn();
    const spawnFn: any = vi.fn(() => child);
    const p = launchInstaller(inside('Claw Deck-1.0.3-x64.exe'), { quarantineDir: QDIR, spawnFn, timeoutMs: 2000 });
    queueMicrotask(() => child.emit('spawn'));
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.pid).toBe(4242);
    expect(child.unref).toHaveBeenCalled();
  });

  winOnly('reports the UAC-declined case honestly (never claims success)', async () => {
    const child: any = new EventEmitter();
    const spawnFn: any = vi.fn(() => child);
    const p = launchInstaller(inside('setup.exe'), { quarantineDir: QDIR, spawnFn, timeoutMs: 2000 });
    queueMicrotask(() => child.emit('error', new Error('spawn EACCES 1223 operation cancelled')));
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/elevation prompt was declined/i);
  });

  winOnly('fails validation before ever spawning for a file outside quarantine', async () => {
    const spawnFn: any = vi.fn();
    const r = await launchInstaller(path.join(QDIR, '..', 'evil.exe'), { quarantineDir: QDIR, spawnFn });
    expect(r.ok).toBe(false);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  winOnly('treats an immediate non-zero exit as a failed install', async () => {
    const child: any = new EventEmitter();
    const spawnFn: any = vi.fn(() => child);
    const p = launchInstaller(inside('setup.exe'), { quarantineDir: QDIR, spawnFn, timeoutMs: 2000 });
    queueMicrotask(() => child.emit('exit', 1));
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/exited immediately/i);
  });
});
