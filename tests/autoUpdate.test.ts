import { describe, it, expect } from 'vitest';
import {
  pickAssetFor, compareSemver, isNewer,
  parseEmergency, pickLatestRelease, evaluateUpdate,
  type ReleaseCandidate
} from '../src/lib/autoUpdate';

function release(version: string, body?: string): ReleaseCandidate {
  return { tag: `v${version}`, version, body, assets: [] };
}

function rc(...names: string[]): ReleaseCandidate {
  return {
    tag: 'v1.0.0', version: '1.0.0',
    assets: names.map(n => ({ name: n, url: `https://example.com/${n}` }))
  };
}

describe('autoUpdate.pickAssetFor', () => {
  it('prefers windows .exe on win32 x64', () => {
    const r = rc('Claw-Deck-1.0.0-x64.exe', 'Claw-Deck-1.0.0-mac.dmg', 'Claw-Deck-1.0.0.AppImage');
    expect(pickAssetFor(r, 'win32', 'x64')?.name).toBe('Claw-Deck-1.0.0-x64.exe');
  });
  it('prefers .dmg on darwin', () => {
    const r = rc('Claw-Deck-1.0.0-x64.exe', 'Claw-Deck-1.0.0-mac.dmg');
    expect(pickAssetFor(r, 'darwin', 'x64')?.name).toBe('Claw-Deck-1.0.0-mac.dmg');
  });
  it('prefers AppImage on linux', () => {
    const r = rc('Claw-Deck-1.0.0.AppImage', 'Claw-Deck-1.0.0.deb');
    expect(pickAssetFor(r, 'linux', 'x64')?.name).toBe('Claw-Deck-1.0.0.AppImage');
  });
  it('returns undefined when nothing matches', () => {
    const r = rc('source.tar.gz');
    expect(pickAssetFor(r, 'win32', 'x64')).toBeUndefined();
  });
  it('honors arch hints to disambiguate', () => {
    const r = rc('Claw-Deck-1.0.0-arm64.exe', 'Claw-Deck-1.0.0-x64.exe');
    expect(pickAssetFor(r, 'win32', 'arm64')?.name).toBe('Claw-Deck-1.0.0-arm64.exe');
  });
});

describe('autoUpdate.compareSemver / isNewer', () => {
  it('compares numerically', () => {
    expect(compareSemver('1.2.0', '1.1.9')).toBeGreaterThan(0);
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
    expect(compareSemver('v0.2.0', '0.1.99')).toBeGreaterThan(0);
  });
  it('isNewer strips leading v', () => {
    expect(isNewer('v0.2.0', '0.1.5')).toBe(true);
    expect(isNewer('0.1.0', 'v0.1.0')).toBe(false);
  });
  it('handles prerelease tags conservatively', () => {
    expect(isNewer('1.0.0', '1.0.0-beta')).toBe(true);
  });
});

describe('autoUpdate.parseEmergency', () => {
  it('returns null when no marker present', () => {
    expect(parseEmergency('Just a normal release.\n- fixed stuff')).toBeNull();
    expect(parseEmergency(undefined)).toBeNull();
  });
  it('parses the HTML-comment marker with a message', () => {
    const info = parseEmergency('Notes\n<!-- clawdeck:emergency: Fixes a critical RCE, update now. -->\nmore');
    expect(info?.message).toBe('Fixes a critical RCE, update now.');
  });
  it('parses the marker even with no message (uses default)', () => {
    const info = parseEmergency('<!-- clawdeck:emergency -->');
    expect(info?.message).toMatch(/critical update/i);
  });
  it('accepts the visible [!EMERGENCY] fallback form', () => {
    const info = parseEmergency('[!EMERGENCY] Data-loss bug in 1.2.0 — upgrade immediately.');
    expect(info?.message).toBe('Data-loss bug in 1.2.0 — upgrade immediately.');
  });
});

describe('autoUpdate.pickLatestRelease', () => {
  it('returns the highest semver regardless of feed order', () => {
    const latest = pickLatestRelease([release('0.2.0'), release('0.10.0'), release('0.3.1')]);
    expect(latest?.version).toBe('0.10.0');
  });
  it('returns undefined for an empty feed', () => {
    expect(pickLatestRelease([])).toBeUndefined();
  });
});

describe('autoUpdate.evaluateUpdate', () => {
  it('shows nothing when up to date', () => {
    const e = evaluateUpdate([release('1.0.0')], '1.0.0');
    expect(e.isUpdate).toBe(false);
    expect(e.show).toBe('none');
  });
  it('shows a banner for a newer release', () => {
    const e = evaluateUpdate([release('1.1.0')], '1.0.0');
    expect(e.isUpdate).toBe(true);
    expect(e.show).toBe('banner');
    expect(e.latest?.version).toBe('1.1.0');
  });
  it('mutes forever when the user opted out', () => {
    const e = evaluateUpdate([release('1.1.0')], '1.0.0', { muteForever: true });
    expect(e.show).toBe('none');
  });
  it('snooze suppresses the snoozed version but re-shows for a newer one', () => {
    const snoozed = evaluateUpdate([release('1.1.0')], '1.0.0', { snoozedVersion: '1.1.0' });
    expect(snoozed.show).toBe('none');
    const newer = evaluateUpdate([release('1.2.0')], '1.0.0', { snoozedVersion: '1.1.0' });
    expect(newer.show).toBe('banner');
  });
  it('emergency overrides mute AND snooze', () => {
    const body = '<!-- clawdeck:emergency: Critical security fix. -->';
    const e = evaluateUpdate([release('1.1.0', body)], '1.0.0', { muteForever: true, snoozedVersion: '9.9.9' });
    expect(e.show).toBe('emergency');
    expect(e.emergency?.message).toBe('Critical security fix.');
  });
  it('does not flag an emergency when already up to date', () => {
    const body = '<!-- clawdeck:emergency: old news -->';
    const e = evaluateUpdate([release('1.0.0', body)], '1.0.0');
    expect(e.emergency).toBeNull();
    expect(e.show).toBe('none');
  });
});
