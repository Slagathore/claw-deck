import { describe, it, expect } from 'vitest';
import { parsePorcelain, diffFiles } from '../electron/executor/gitStatus';

describe('parsePorcelain — protect the user, stage only forge output', () => {
  it('extracts touched paths across status codes', () => {
    const out = [
      ' M src/player.gd',     // modified
      '?? assets/new.png',    // untracked
      'A  scenes/hud.tscn',   // added
      'D  old/dead.gd',       // deleted
    ].join('\n');
    expect(parsePorcelain(out).sort()).toEqual(['assets/new.png', 'old/dead.gd', 'scenes/hud.tscn', 'src/player.gd']);
  });

  it('keeps the destination of a rename, and unquotes paths with spaces', () => {
    const out = 'R  old/name.gd -> new/name.gd\n?? "my folder/with space.tres"';
    expect(parsePorcelain(out)).toEqual(['new/name.gd', 'my folder/with space.tres']);
  });

  it('ignores blank/short lines', () => {
    expect(parsePorcelain('\n   \n')).toEqual([]);
  });

  it('the protect-set math: stage = dirty − pre-existing', () => {
    const preExisting = new Set(parsePorcelain(' M README.md\n?? notes.txt'));
    const nowDirty = parsePorcelain(' M README.md\n?? notes.txt\n?? game/main.gd\nA  game/hud.tscn');
    const toStage = nowDirty.filter((p) => !preExisting.has(p)).sort();
    expect(toStage).toEqual(['game/hud.tscn', 'game/main.gd']);   // the user's WIP is never staged
  });
});

describe('diffFiles', () => {
  it('lists files from a unified diff, dropping /dev/null', () => {
    const diff = [
      'diff --git a/src/a.gd b/src/a.gd',
      '--- a/src/a.gd',
      '+++ b/src/a.gd',
      '@@ -1 +1 @@',
      'diff --git a/new.gd b/new.gd',
      '--- /dev/null',
      '+++ b/new.gd',
    ].join('\n');
    expect(diffFiles(diff).sort()).toEqual(['new.gd', 'src/a.gd']);
  });
});
