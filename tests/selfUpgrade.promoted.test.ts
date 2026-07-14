import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// promoted.ts talks to app.getPath('userData'). Point it at a throwaway dir so
// the boot-decision logic is exercisable without a real Electron process.
let USERDATA = '';
vi.mock('electron', () => ({
  app: { getPath: () => USERDATA }
}));

const mod = await import('../electron/selfUpgrade/promoted');

beforeEach(() => {
  USERDATA = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdeck-promoted-'));
  delete process.env.CLAW_PROMOTED_ROOT;
});
afterEach(() => {
  fs.rmSync(USERDATA, { recursive: true, force: true });
});

function makeBundle(id: string, appVersion: string): string {
  const dir = path.join(mod.bundlesDir(), id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.js'), '// bundle');
  const rec = { id, dir, appVersion, promotedAt: Date.now(), gateMode: 'reduced' };
  mod.writeCurrent(rec as any);
  return dir;
}

describe('decideBoot', () => {
  it('boots the pristine asar when nothing is promoted', () => {
    const d = mod.decideBoot('1.0.2');
    expect(d.root).toBeNull();
  });

  it('boots a promoted bundle for the matching version and arms the sentinel', () => {
    const dir = makeBundle('bundle-a', '1.0.2');
    const d = mod.decideBoot('1.0.2');
    expect(d.root).toBe(dir);
    // The sentinel must be on disk now — a boot that hangs before it is cleared
    // is what the next-launch rollback keys on.
    expect(mod.sentinelExists()).toBe(true);
  });

  it('auto-rolls-back when a stale sentinel means the last boot never finished', () => {
    makeBundle('bundle-b', '1.0.2');
    mod.decideBoot('1.0.2');          // arms the sentinel, does NOT clear it (simulates a hang/crash)
    const second = mod.decideBoot('1.0.2');
    expect(second.root).toBeNull();
    expect(second.refused).toMatch(/never finished booting/i);
    expect(mod.readCurrent()).toBeNull();
    const notice = mod.readLastRollback();
    expect(notice?.id).toBe('bundle-b');
  });

  it('discards a bundle built against a different app version', () => {
    makeBundle('bundle-c', '1.0.1');
    const d = mod.decideBoot('1.0.2');
    expect(d.root).toBeNull();
    expect(d.refused).toMatch(/built against app 1\.0\.1/);
    expect(mod.readCurrent()).toBeNull();
  });

  it('discards a bundle whose main.js is missing', () => {
    makeBundle('bundle-d', '1.0.2');
    fs.rmSync(path.join(mod.bundlesDir(), 'bundle-d', 'main.js'));
    const d = mod.decideBoot('1.0.2');
    expect(d.root).toBeNull();
    expect(d.refused).toMatch(/missing main\.js/i);
  });

  it('clears the sentinel after a clean boot so the bundle survives the next launch', () => {
    makeBundle('bundle-e', '1.0.2');
    mod.decideBoot('1.0.2');
    mod.clearBootSentinel();          // main.ts does this on did-finish-load
    const second = mod.decideBoot('1.0.2');
    expect(second.root).not.toBeNull(); // still promoted
  });
});

describe('discardPromotion + journal', () => {
  it('drops the current record and journals the reason', () => {
    makeBundle('bundle-f', '1.0.2');
    const dropped = mod.discardPromotion('user reverted', 'manual-revert');
    expect(dropped?.id).toBe('bundle-f');
    expect(mod.readCurrent()).toBeNull();
    const j = mod.readJournal();
    expect(j.some(e => e.event === 'manual-revert' && e.id === 'bundle-f')).toBe(true);
    // The promote event is also on record.
    expect(j.some(e => e.event === 'promote' && e.id === 'bundle-f')).toBe(true);
  });
});
