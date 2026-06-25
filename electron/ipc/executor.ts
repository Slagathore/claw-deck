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
import { getDb } from './db';
import { createWorktree, captureDiff, writeArtifacts, applyToLiveTree, removeWorktree, Worktree } from '../executor/worktree';
import { applyDiffToWorktree } from '../executor/applyDiff';
import { validateWorktree } from '../executor/validate';
import { SandboxResult } from '../selfUpgrade/sandbox';
import { createSnapshot, restoreSnapshot, findSnapshotById } from '../selfUpgrade/snapshot';

type Mode = 'delegate' | 'apply';
interface ExecRun {
  runId: string; repo: string; wt: Worktree; mode: Mode;
  plan: string; diff: string; validation: SandboxResult | null; snapshotId?: string;
  status: 'open' | 'proposed' | 'validated' | 'invalid' | 'approved' | 'rejected';
}

const runs = new Map<string, ExecRun>();

export function getExecRun(runId: string): ExecRun | undefined { return runs.get(runId); }

function upsertRun(run: ExecRun, patch: Partial<{ planPath: string; diffPath: string; error: string | null }> = {}): void {
  getDb().prepare(`
    INSERT INTO executor_runs(run_id, repo, mode, status, wt_dir, branch, plan_path, diff_path, diff_bytes, validation_ok, snapshot_id, started, updated, error)
    VALUES(@runId, @repo, @mode, @status, @wtDir, @branch, @planPath, @diffPath, @diffBytes, @validationOk, @snapshotId, @started, @updated, @error)
    ON CONFLICT(run_id) DO UPDATE SET
      status=excluded.status, plan_path=COALESCE(excluded.plan_path, executor_runs.plan_path),
      diff_path=COALESCE(excluded.diff_path, executor_runs.diff_path), diff_bytes=excluded.diff_bytes,
      validation_ok=excluded.validation_ok, snapshot_id=COALESCE(excluded.snapshot_id, executor_runs.snapshot_id),
      updated=excluded.updated, error=excluded.error
  `).run({
    runId: run.runId,
    repo: run.repo,
    mode: run.mode,
    status: run.status,
    wtDir: run.wt.dir,
    branch: run.wt.branch,
    planPath: patch.planPath ?? null,
    diffPath: patch.diffPath ?? null,
    diffBytes: run.diff.length,
    validationOk: run.validation ? (run.validation.ok ? 1 : 0) : null,
    snapshotId: run.snapshotId ?? null,
    started: Number(run.runId.split('-')[0] ? parseInt(run.runId.split('-')[0], 36) : Date.now()) || Date.now(),
    updated: Date.now(),
    error: patch.error ?? null,
  });
}

export function registerExecutorHandlers() {
  ipcMain.handle('exec:beginRun', async (_e, opts: { repo: string; mode?: Mode }) => {
    if (!opts?.repo) return { ok: false, error: 'no repo' };
    const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const { ok, wt, error } = await createWorktree(opts.repo, runId);
    if (!ok) return { ok: false, error };
    runs.set(runId, { runId, repo: opts.repo, wt, mode: opts.mode ?? 'delegate', plan: '', diff: '', validation: null, status: 'open' });
    upsertRun(runs.get(runId)!);
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
    upsertRun(run, { planPath, diffPath });
    appendAudit('exec:proposal', { runId: run.runId, mode: run.mode, diffBytes: diff.length });
    return { ok: true, plan: run.plan, diff, planPath, diffPath, empty: !diff.trim() };
  });

  ipcMain.handle('exec:validate', async (_e, opts: { runId: string }) => {
    const run = runs.get(opts.runId);
    if (!run) return { ok: false, error: 'unknown run' };
    const result = await validateWorktree(run.wt);
    run.validation = result;
    run.status = result.ok ? 'validated' : 'invalid';
    upsertRun(run);
    appendAudit('exec:validate', { runId: run.runId, ok: result.ok });
    return { ok: true, result };
  });

  ipcMain.handle('exec:approve', async (_e, opts: { runId: string }) => {
    const run = runs.get(opts.runId);
    if (!run) return { ok: false, error: 'unknown run' };
    if (!run.validation?.ok) return { ok: false, error: 'validation must pass before approval' };
    const snap = await createSnapshot(run.repo, `fusion pre-approve ${run.runId}`);
    run.snapshotId = snap.id;
    const ap = await applyToLiveTree(run.wt, run.diff);
    if (!ap.ok) { upsertRun(run, { error: ap.error ?? 'apply failed' }); return { ok: false, error: `apply to live tree failed: ${ap.error}`, snapshotId: snap.id }; }
    appendAudit('exec:approved', { runId: run.runId, repo: run.repo, diffBytes: run.diff.length, validated: run.validation?.ok ?? null, snapshotId: snap.id });
    await removeWorktree(run.wt);
    run.status = 'approved';
    upsertRun(run);
    runs.delete(run.runId);
    return { ok: true, snapshotId: snap.id };
  });

  ipcMain.handle('exec:reject', async (_e, opts: { runId: string }) => {
    const run = runs.get(opts.runId);
    if (!run) return { ok: false, error: 'unknown run' };
    await removeWorktree(run.wt);
    run.status = 'rejected';
    upsertRun(run);
    appendAudit('exec:rejected', { runId: run.runId });
    runs.delete(run.runId);
    return { ok: true };
  });

  ipcMain.handle('exec:list', (_e, opts?: { limit?: number }) => {
    const limit = Math.max(1, Math.min(200, opts?.limit ?? 50));
    const rows = getDb().prepare('SELECT * FROM executor_runs ORDER BY updated DESC LIMIT ?').all(limit);
    return { ok: true, runs: rows };
  });

  ipcMain.handle('exec:rollback', async (_e, opts: { snapshotId: string }) => {
    const snap = await findSnapshotById(opts.snapshotId);
    if (!snap) return { ok: false, error: 'snapshot not found' };
    try {
      await restoreSnapshot(snap);
      appendAudit('exec:rollback', { snapshotId: opts.snapshotId, repo: snap.root });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  });
}
