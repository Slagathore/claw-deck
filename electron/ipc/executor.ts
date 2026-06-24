// Proposal + Worktree Executor IPC (BOOTSTRAP §3 Phase 2). Makes "isolation
// before trust" + "two artifacts before write" structural:
//   exec:beginRun  → create an isolated git worktree
//   exec:proposal  → (apply mode) apply a model's diff into the wt, then capture
//                    changes.diff + persist CHANGE_PLAN.md + changes.diff
//   exec:validate  → runInSandbox over the wt (npm ci + npm test)
//   exec:approve   → git apply onto the live tree + appendAudit + clean up the wt
//   exec:reject    → remove the wt (live tree stays clean)
// Approve writes to the real hash-chain ledger via appendAudit (electron/ipc/
// security.ts) — NOT the audit.ts scanner.

import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { appendAudit } from './security';
import { createWorktree, captureDiff, writeArtifacts, applyToLiveTree, removeWorktree, Worktree } from '../executor/worktree';
import { applyDiffToWorktree } from '../executor/applyDiff';
import { validateWorktree } from '../executor/validate';
import { SandboxResult } from '../selfUpgrade/sandbox';

type Mode = 'delegate' | 'apply';
interface ExecRun {
  runId: string; repo: string; wt: Worktree; mode: Mode;
  plan: string; diff: string; validation: SandboxResult | null;
  status: 'open' | 'proposed' | 'validated' | 'invalid' | 'approved' | 'rejected';
}

const runs = new Map<string, ExecRun>();

export function getExecRun(runId: string): ExecRun | undefined { return runs.get(runId); }

export function registerExecutorHandlers() {
  ipcMain.handle('exec:beginRun', async (_e, opts: { repo: string; mode?: Mode }) => {
    if (!opts?.repo) return { ok: false, error: 'no repo' };
    const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const { ok, wt, error } = await createWorktree(opts.repo, runId);
    if (!ok) return { ok: false, error };
    runs.set(runId, { runId, repo: opts.repo, wt, mode: opts.mode ?? 'delegate', plan: '', diff: '', validation: null, status: 'open' });
    appendAudit('exec:beginRun', { runId, repo: opts.repo, mode: opts.mode ?? 'delegate', branch: wt.branch });
    return { ok: true, runId, wtDir: wt.dir, branch: wt.branch };
  });

  // Capture the two artifacts. delegate: actor already edited the wt (cwd=wt);
  // apply: apply the supplied diff into the wt first.
  ipcMain.handle('exec:proposal', async (_e, opts: { runId: string; plan: string; diff?: string }) => {
    const run = runs.get(opts.runId);
    if (!run) return { ok: false, error: 'unknown run' };
    if (run.mode === 'apply') {
      if (!opts.diff) return { ok: false, error: 'apply mode requires a diff' };
      const a = await applyDiffToWorktree(run.wt, opts.diff);
      if (!a.ok) return { ok: false, error: `diff did not apply: ${a.error}` };
    }
    const diff = await captureDiff(run.wt);
    run.plan = opts.plan ?? '';
    run.diff = diff;
    run.status = 'proposed';
    const { planPath, diffPath } = writeArtifacts(run.wt, run.plan, diff);
    appendAudit('exec:proposal', { runId: run.runId, mode: run.mode, diffBytes: diff.length });
    return { ok: true, plan: run.plan, diff, planPath, diffPath, empty: !diff.trim() };
  });

  ipcMain.handle('exec:validate', async (_e, opts: { runId: string }) => {
    const run = runs.get(opts.runId);
    if (!run) return { ok: false, error: 'unknown run' };
    const result = await validateWorktree(run.wt);
    run.validation = result;
    run.status = result.ok ? 'validated' : 'invalid';
    appendAudit('exec:validate', { runId: run.runId, ok: result.ok });
    return { ok: true, result };
  });

  ipcMain.handle('exec:approve', async (_e, opts: { runId: string }) => {
    const run = runs.get(opts.runId);
    if (!run) return { ok: false, error: 'unknown run' };
    const ap = await applyToLiveTree(run.wt, run.diff);
    if (!ap.ok) return { ok: false, error: `apply to live tree failed: ${ap.error}` };
    appendAudit('exec:approved', { runId: run.runId, repo: run.repo, diffBytes: run.diff.length, validated: run.validation?.ok ?? null });
    await removeWorktree(run.wt);
    run.status = 'approved';
    return { ok: true };
  });

  ipcMain.handle('exec:reject', async (_e, opts: { runId: string }) => {
    const run = runs.get(opts.runId);
    if (!run) return { ok: false, error: 'unknown run' };
    await removeWorktree(run.wt);
    run.status = 'rejected';
    appendAudit('exec:rejected', { runId: run.runId });
    return { ok: true };
  });
}
