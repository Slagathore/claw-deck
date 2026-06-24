// Worktree lifecycle (BOOTSTRAP §3 Phase 2): isolation before trust.
//   create  → git worktree add .fusion/wt/<runId> -b fusion/run-<runId> HEAD
//   capture → git add -A && git diff --cached  →  changes.diff
//   artifacts (CHANGE_PLAN.md + changes.diff) persist under .fusion/runs/<runId>/
//             (kept OUT of the wt so they don't pollute the captured diff)
//   approve → git apply the diff onto the live tree
//   reject  → git worktree remove --force + delete the branch
// All paths under .fusion/ (gitignored). Reuses git() → exec.run (no shell).

import * as path from 'path';
import * as fs from 'fs';
import { git } from './git';

export interface Worktree { runId: string; repo: string; dir: string; branch: string; artifactsDir: string }

export function worktreeFor(repo: string, runId: string): Worktree {
  return {
    runId, repo,
    dir: path.join(repo, '.fusion', 'wt', runId),
    branch: `fusion/run-${runId}`,
    artifactsDir: path.join(repo, '.fusion', 'runs', runId),
  };
}

export async function createWorktree(repo: string, runId: string): Promise<{ ok: boolean; wt: Worktree; error?: string }> {
  const wt = worktreeFor(repo, runId);
  fs.mkdirSync(path.dirname(wt.dir), { recursive: true });
  fs.mkdirSync(wt.artifactsDir, { recursive: true });
  const r = await git(repo, ['worktree', 'add', wt.dir, '-b', wt.branch, 'HEAD']);
  return { ok: r.ok, wt, error: r.ok ? undefined : r.stderr.trim() };
}

/** Stage everything in the worktree and return the unified diff vs HEAD. */
export async function captureDiff(wt: Worktree): Promise<string> {
  await git(wt.dir, ['add', '-A']);
  const r = await git(wt.dir, ['diff', '--cached']);
  return r.stdout;
}

export function writeArtifacts(wt: Worktree, plan: string, diff: string): { planPath: string; diffPath: string } {
  fs.mkdirSync(wt.artifactsDir, { recursive: true });
  const planPath = path.join(wt.artifactsDir, 'CHANGE_PLAN.md');
  const diffPath = path.join(wt.artifactsDir, 'changes.diff');
  fs.writeFileSync(planPath, plan ?? '', 'utf8');
  fs.writeFileSync(diffPath, diff ?? '', 'utf8');
  return { planPath, diffPath };
}

/** Apply the captured diff onto the live working tree (the approve step). */
export async function applyToLiveTree(wt: Worktree, diff: string): Promise<{ ok: boolean; error?: string }> {
  if (!diff.trim()) return { ok: true };
  fs.mkdirSync(wt.artifactsDir, { recursive: true });
  const tmp = path.join(wt.artifactsDir, 'apply.diff');
  fs.writeFileSync(tmp, diff.endsWith('\n') ? diff : diff + '\n', 'utf8');
  let r = await git(wt.repo, ['apply', '--whitespace=nowarn', tmp]);
  if (!r.ok) r = await git(wt.repo, ['apply', '--3way', '--whitespace=nowarn', tmp]);
  return { ok: r.ok, error: r.ok ? undefined : r.stderr.trim() };
}

export async function removeWorktree(wt: Worktree): Promise<void> {
  await git(wt.repo, ['worktree', 'remove', '--force', wt.dir]);
  await git(wt.repo, ['branch', '-D', wt.branch]);
  try { fs.rmSync(wt.dir, { recursive: true, force: true }); } catch { /* already gone */ }
}
