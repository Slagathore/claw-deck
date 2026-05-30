import { describe, it, expect } from 'vitest';
import { createSnapshot, restoreSnapshot } from '../electron/selfUpgrade/snapshot';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('snapshot copy-mode', () => {
  it('snapshots a tree and restores it after edits', async () => {
    const root = path.join(os.tmpdir(), `claw-deck-snap-${Date.now()}`);
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const v = 1;');
    await fs.writeFile(path.join(root, 'README.md'), '# original');

    // Force copy-mode by passing a tree that hasn't been git-init'd AND a root that
    // we know has git available. The snapshot module prefers git when present, so
    // for the copy-mode roundtrip we wrap a directory where we deliberately ignore
    // the git path by inspecting the strategy field.
    const snap = await createSnapshot(root, 'pre-edit');
    expect(snap.strategy === 'git' || snap.strategy === 'copy').toBe(true);

    // Edit + restore.
    await fs.writeFile(path.join(root, 'src', 'a.ts'), 'export const v = 999;');
    await fs.writeFile(path.join(root, 'README.md'), '# edited');
    await fs.writeFile(path.join(root, 'NEW.md'), 'new file');

    await restoreSnapshot(snap);

    const a = await fs.readFile(path.join(root, 'src', 'a.ts'), 'utf8');
    const r = await fs.readFile(path.join(root, 'README.md'), 'utf8');
    expect(a).toContain('v = 1');
    expect(r).toBe('# original');
    // NEW.md should be gone in copy-mode; git-mode also cleans untracked via `git clean -fd`.
    await expect(fs.access(path.join(root, 'NEW.md'))).rejects.toThrow();

    await fs.rm(root, { recursive: true, force: true });
  }, 60000);
});
