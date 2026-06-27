// Apply-mode (BOOTSTRAP §3 Phase 2 mode 2): write any model's unified diff INTO
// the worktree so it can be captured/validated like a delegated edit.
import * as path from 'path';
import * as fs from 'fs';
import { git } from './git';
import { type Worktree } from './worktree';

export async function applyDiffToWorktree(wt: Worktree, diff: string): Promise<{ ok: boolean; error?: string }> {
  if (!diff.trim()) return { ok: false, error: 'empty diff' };
  fs.mkdirSync(wt.artifactsDir, { recursive: true });
  const tmp = path.join(wt.artifactsDir, 'incoming.diff');
  fs.writeFileSync(tmp, diff.endsWith('\n') ? diff : diff + '\n', 'utf8');
  let r = await git(wt.dir, ['apply', '--whitespace=nowarn', tmp]);
  if (!r.ok) r = await git(wt.dir, ['apply', '--3way', '--whitespace=nowarn', tmp]);
  return { ok: r.ok, error: r.ok ? undefined : r.stderr.trim() };
}
