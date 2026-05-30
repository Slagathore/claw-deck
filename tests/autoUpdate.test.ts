import { describe, it, expect } from 'vitest';
import { pickAssetFor, compareSemver, isNewer, ReleaseCandidate } from '../src/lib/autoUpdate';

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
