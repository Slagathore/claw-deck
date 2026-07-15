import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Captured IPC handlers + a real temp quarantine dir shared with the mocks.
const h = vi.hoisted(() => ({
  handlers: {} as Record<string, (...a: any[]) => any>,
  qdir: '',
  throwVerify: false,
  launchInstaller: vi.fn(async () => ({ ok: true, pid: 1 }))
}));

vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, fn: (...a: any[]) => any) => { h.handlers[name] = fn; } },
  app: { quit: vi.fn() }
}));

vi.mock('../electron/ipc/db', () => ({
  getDb: () => ({
    prepare: () => ({
      // fetchSettings reads the settings table; the recording INSERT uses run().
      all: () => [{
        key: 'policy',
        value: JSON.stringify({ allowlist: ['github.com'], requireSignature: true, autoScan: false, signingKeys: [] })
      }],
      get: () => undefined,
      run: () => ({ lastInsertRowid: 1 })
    })
  })
}));

vi.mock('../electron/ipc/security', () => ({
  isHostAllowed: () => true,
  scanFile: async () => [],
  sha256OfFile: async () => 'deadbeef',
  appendAudit: () => {},
  quarantineDir: () => h.qdir
}));

vi.mock('../electron/ipc/feeds', () => ({ fetchSources: async () => [] }));
vi.mock('../electron/ipc/reputation', () => ({
  vtLookup: async () => null,
  installWithBackup: () => ({ backup: null }),
  restoreBackup: () => false
}));

// The installer must never be launched when verification did not pass.
vi.mock('../electron/ipc/installer', () => ({ launchInstaller: h.launchInstaller }));

// The verifier under test: made to throw so we exercise the fail-closed guard.
vi.mock('../electron/ipc/authenticode', () => ({
  verifyAuthenticode: async () => {
    if (h.throwVerify) throw new Error('powershell blew up');
    return { ok: false, signed: false, reason: 'unsigned' };
  }
}));

import { registerUpgradeHandlers } from '../electron/ipc/upgrades';

const realPlatform = process.platform;
function forcePlatform(p: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  h.qdir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdeck-install-'));
  h.throwVerify = false;
  h.launchInstaller.mockClear();
  forcePlatform('win32');
  // Stub the network so the handler downloads deterministic bytes.
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    status: 200,
    arrayBuffer: async () => new TextEncoder().encode('MZ fake installer').buffer
  })));
  registerUpgradeHandlers();
});
afterEach(() => {
  forcePlatform(realPlatform);
  vi.unstubAllGlobals();
  try { fs.rmSync(h.qdir, { recursive: true, force: true }); } catch {}
});

const manifest = {
  kind: 'self', name: 'claw-deck', version: '1.0.4',
  url: 'https://github.com/Slagathore/claw-deck/releases/download/v1.0.4/Claw-Deck-Setup.exe',
  launchInstaller: true
};

describe('upgrades:install Authenticode gate', () => {
  it('when the verifier THROWS: deletes the quarantine file, refuses, never launches', async () => {
    h.throwVerify = true;
    const r = await h.handlers['upgrades:install']({}, manifest);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not complete/i);
    expect(h.launchInstaller).not.toHaveBeenCalled();
    // Fail-closed cleanup: no downloaded file is left behind in quarantine.
    expect(fs.readdirSync(h.qdir)).toHaveLength(0);
  });

  it('when the file is unsigned: refuses and cleans up (no launch)', async () => {
    const r = await h.handlers['upgrades:install']({}, manifest);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Authenticode verification failed/i);
    expect(r.requiresUnsignedConfirmation).toBeUndefined(); // launch path never offers the unsigned bypass
    expect(h.launchInstaller).not.toHaveBeenCalled();
    expect(fs.readdirSync(h.qdir)).toHaveLength(0);
  });
});
