import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';

// sourceRoot() reads app.getPath — pin it so 'self' containment is testable.
const ROOT = path.resolve('/tmp/clawdeck-self-root');
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => path.dirname(ROOT), getVersion: () => '1.0.2' }
}));

const { partitionSelfIndex } = await import('../electron/selfUpgrade/snapshot');
const { isPathWithin } = await import('../electron/selfUpgrade/paths');

// A minimal Snapshot shape for the partition test.
function snap(id: string, root: string, scope: 'self' | 'workspace' = 'self') {
  return { id, createdAt: 1, label: id, ref: 'x', strategy: 'git' as const, root, scope };
}

describe('partitionSelfIndex — the foreign-snapshot purge', () => {
  const selfRoot = ROOT;
  it('keeps snapshots inside the source root and evicts foreign ones', () => {
    const list = [
      snap('own-1', selfRoot),
      snap('own-2', path.join(selfRoot, 'sub')),
      snap('foreign-sd', 'C:\\Users\\Cole\\CodeStuff\\games\\SD_Mining'),
      snap('foreign-moss', '/home/cole/CodeStuff/games/moss-hollow - Copy'),
      snap('workspace-tagged', selfRoot, 'workspace') // even inside root, a workspace-tagged entry is foreign to the self index
    ];
    const { kept, foreign } = partitionSelfIndex(list as any, selfRoot);
    expect(kept.map(s => s.id).sort()).toEqual(['own-1', 'own-2']);
    expect(foreign.map(s => s.id).sort()).toEqual(['foreign-moss', 'foreign-sd', 'workspace-tagged']);
  });

  it('agrees with isPathWithin on the actual reported roots', () => {
    expect(isPathWithin(selfRoot, 'C:\\Users\\Cole\\CodeStuff\\games\\SD_Mining')).toBe(false);
    expect(isPathWithin(selfRoot, path.join(selfRoot, 'electron', 'main.ts'))).toBe(true);
  });
});
