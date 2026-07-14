import { describe, it, expect } from 'vitest';
import { seedDecision, isPathWithin } from '../electron/selfUpgrade/paths';

// The bug this fixes: the old code seeded only when the dir was empty and never
// looked again, stranding the tree at whatever version created it (0.1.0 under a
// 1.0.2 app). seedDecision is the pure policy that replaces it.
describe('seedDecision', () => {
  it('seeds a fresh empty tree', () => {
    expect(seedDecision({ hasContents: false, stamp: null, appVersion: '1.0.2' })).toBe('seed');
  });
  it('re-seeds an unstamped fossil (the 0.1.0-forever bug)', () => {
    expect(seedDecision({ hasContents: true, stamp: null, appVersion: '1.0.2' })).toBe('reseed');
  });
  it('re-seeds a tree stamped at an older version', () => {
    expect(seedDecision({ hasContents: true, stamp: { appVersion: '0.1.0', seededAt: 1 }, appVersion: '1.0.2' })).toBe('reseed');
  });
  it('keeps a tree already at the running version', () => {
    expect(seedDecision({ hasContents: true, stamp: { appVersion: '1.0.2', seededAt: 1 }, appVersion: '1.0.2' })).toBe('keep');
  });
});

describe('isPathWithin', () => {
  const root = process.platform === 'win32' ? 'C:\\Users\\Cole\\AppData\\Roaming\\claw-deck\\source' : '/home/cole/.config/claw-deck/source';
  it('is true for the root itself and its children', () => {
    expect(isPathWithin(root, root)).toBe(true);
    expect(isPathWithin(root, `${root}${process.platform === 'win32' ? '\\' : '/'}electron`)).toBe(true);
  });
  it('is false for a sibling / other project (the SD_Mining / moss-hollow case)', () => {
    const other = process.platform === 'win32' ? 'C:\\Users\\Cole\\CodeStuff\\games\\SD_Mining' : '/home/cole/CodeStuff/games/SD_Mining';
    expect(isPathWithin(root, other)).toBe(false);
  });
  it('is false for a parent-escaping path', () => {
    expect(isPathWithin(root, path_join(root, '..', 'evil'))).toBe(false);
  });
});

function path_join(...p: string[]): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('path').join(...p);
}
