import { BrowserWindow, webContents } from 'electron';
import { type PatchSet, applyPatchSet } from './patcher';
import { assessRisk, type RiskAssessment } from './risk';
import { createSnapshot, restoreSnapshot, type Snapshot } from './snapshot';
import { baselineAudit, runGate, type GateResult } from './gate';
import { runProbe, type ProbeResult, type ProbeCheck } from './probe';
import { runInSandbox, type SandboxResult } from './sandbox';
import { repoStatus, type RepoStatus } from './github';

export type PipelinePhase =
  | 'github-check'
  | 'baseline-audit'
  | 'snapshot'
  | 'apply-patch'
  | 'gate'
  | 'sandbox'
  | 'probe'
  | 'promote'
  | 'rollback';

export interface PipelineEvent {
  runId: string;
  phase: PipelinePhase;
  status: 'start' | 'ok' | 'fail' | 'skip';
  message?: string;
  data?: any;
  at: number;
}

export interface PipelineResult {
  runId: string;
  success: boolean;
  rolledBack: boolean;
  snapshot?: Snapshot;
  risk?: RiskAssessment;
  gate?: GateResult;
  sandbox?: SandboxResult;
  probe?: ProbeResult;
  repo?: RepoStatus;
  error?: string;
  durationMs: number;
}

export interface PipelineOpts {
  runId: string;
  sourceRoot: string;
  patch: PatchSet;
  /** When true, route high-risk patches through sandbox before applying live. */
  sandboxHighRisk: boolean;
  /** When set, the probe is launched with this electron exe path. */
  electronExe?: string;
  probeChecks?: ProbeCheck[];
}

function broadcast(ev: PipelineEvent) {
  for (const wc of webContents.getAllWebContents()) {
    try { wc.send('selfUpgrade:event', ev); } catch { /* ignore closed windows */ }
  }
}

function emit(runId: string, phase: PipelinePhase, status: PipelineEvent['status'], message?: string, data?: any) {
  broadcast({ runId, phase, status, message, data, at: Date.now() });
}

export async function runPipeline(opts: PipelineOpts): Promise<PipelineResult> {
  const started = Date.now();
  const { runId, sourceRoot, patch } = opts;

  // 1. github check (informational only — never blocks).
  emit(runId, 'github-check', 'start');
  const repo = await repoStatus(sourceRoot);
  emit(runId, 'github-check', 'ok', repo.hasOrigin ? `origin: ${repo.originUrl}` : 'no origin configured', repo);

  // 2. risk assessment + baseline audit (both inputs to the gate).
  const risk = assessRisk(patch);
  emit(runId, 'baseline-audit', 'start');
  const baseline = await baselineAudit(sourceRoot);
  emit(runId, 'baseline-audit', 'ok', `baseline: ${baseline.findings.length} findings (${baseline.summary.critical} critical, ${baseline.summary.high} high)`, {
    risk,
    baselineSummary: baseline.summary
  });

  // 3. snapshot.
  emit(runId, 'snapshot', 'start');
  let snapshot: Snapshot;
  try {
    snapshot = await createSnapshot(sourceRoot, `pre-upgrade ${runId}`);
    emit(runId, 'snapshot', 'ok', `${snapshot.strategy} snapshot @ ${snapshot.ref.slice(0, 12)}`, snapshot);
  } catch (e: any) {
    emit(runId, 'snapshot', 'fail', e.message);
    return { runId, success: false, rolledBack: false, risk, repo, error: `snapshot failed: ${e.message}`, durationMs: Date.now() - started };
  }

  // 4. optional sandbox pre-check for high-risk patches: clone `sourceRoot` to
  // a tempdir FIRST, apply the patch to that clone, and run the test suite
  // there. The live tree is not written until the clone proves out — a
  // high-risk patch gets a real isolated trial run before it can touch
  // anything real.
  let sandboxResult: SandboxResult | undefined;
  if (opts.sandboxHighRisk && risk.level === 'high') {
    emit(runId, 'sandbox', 'start', 'high-risk patch — cloning to a sandbox tempdir before touching the live tree');
    try {
      sandboxResult = await runInSandbox({ sourceRoot, patch });
    } catch (e: any) {
      emit(runId, 'sandbox', 'fail', e.message);
      // The live tree was never written, so there is nothing to roll back.
      return { runId, success: false, rolledBack: false, snapshot, risk, repo, error: `sandbox error: ${e.message}`, durationMs: Date.now() - started };
    }
    if (!sandboxResult.ok) {
      emit(runId, 'sandbox', 'fail', sandboxResult.reason || 'sandbox tests failed', sandboxResult);
      // The live tree was never written, so there is nothing to roll back.
      return { runId, success: false, rolledBack: false, snapshot, risk, repo, sandbox: sandboxResult, error: 'sandbox stage failed', durationMs: Date.now() - started };
    }
    emit(runId, 'sandbox', 'ok', `sandbox passed in ${sandboxResult.durationMs}ms`, sandboxResult);
  }

  // 5. apply the patch to the live tree. For low/medium risk this is the
  // first write; for high risk it only runs after the sandbox clone above
  // already proved the patch out. Either way the snapshot from step 3 is
  // what backs the "Revert last upgrade" action if this turns out wrong.
  emit(runId, 'apply-patch', 'start');
  try {
    const r = await applyPatchSet(patch, sourceRoot);
    emit(runId, 'apply-patch', 'ok', `wrote ${r.changed.length} file(s)`, r.changed);
  } catch (e: any) {
    emit(runId, 'apply-patch', 'fail', e.message);
    try { await restoreSnapshot(snapshot); } catch { /* ignore */ }
    return { runId, success: false, rolledBack: true, snapshot, risk, repo, sandbox: sandboxResult, error: `apply failed: ${e.message}`, durationMs: Date.now() - started };
  }

  // 6. gate (typecheck + tests + delta scan).
  emit(runId, 'gate', 'start');
  let gate: GateResult;
  try {
    gate = await runGate({ root: sourceRoot, baseline, runTypecheck: true, runTests: true });
    if (!gate.ok) {
      emit(runId, 'gate', 'fail', gate.reasons.join('; '), gate);
      await restoreSnapshot(snapshot);
      emit(runId, 'rollback', 'ok', 'restored from snapshot after gate failure');
      return { runId, success: false, rolledBack: true, snapshot, risk, repo, gate, sandbox: sandboxResult, error: 'gate failed', durationMs: Date.now() - started };
    }
    emit(runId, 'gate', 'ok', `gate passed`, { reasons: gate.reasons, baseline: gate.baseline, patched: gate.patched });
  } catch (e: any) {
    emit(runId, 'gate', 'fail', e.message);
    try { await restoreSnapshot(snapshot); } catch {}
    return { runId, success: false, rolledBack: true, snapshot, risk, repo, sandbox: sandboxResult, error: `gate error: ${e.message}`, durationMs: Date.now() - started };
  }

  // 7. probe (optional — only when an electron exe is provided).
  let probe: ProbeResult | undefined;
  if (opts.electronExe && (opts.probeChecks?.length ?? 0) > 0) {
    emit(runId, 'probe', 'start', `launching probe with checks: ${opts.probeChecks!.join(',')}`);
    try {
      probe = await runProbe({
        electronExe: opts.electronExe,
        appArg: sourceRoot,
        cwd: sourceRoot,
        checks: opts.probeChecks!,
        timeoutMs: 60000
      });
      if (!probe.ok) {
        emit(runId, 'probe', 'fail', probe.reason || 'probe failed', probe);
        await restoreSnapshot(snapshot);
        emit(runId, 'rollback', 'ok', 'restored from snapshot after probe failure');
        return { runId, success: false, rolledBack: true, snapshot, risk, repo, gate, sandbox: sandboxResult, probe, error: 'probe failed', durationMs: Date.now() - started };
      }
      emit(runId, 'probe', 'ok', `probe passed in ${probe.durationMs}ms`, probe);
    } catch (e: any) {
      emit(runId, 'probe', 'fail', e.message);
      try { await restoreSnapshot(snapshot); } catch {}
      return { runId, success: false, rolledBack: true, snapshot, risk, repo, gate, sandbox: sandboxResult, error: `probe error: ${e.message}`, durationMs: Date.now() - started };
    }
  } else {
    emit(runId, 'probe', 'skip', 'no electron exe configured');
  }

  // 8. promote. There is no separate approval step: the patch has been live
  // in the source tree since step 5 (or, for high-risk patches, since it
  // passed the step-4 sandbox clone), so this event just marks the pipeline
  // as done. Undo with the snapshot from step 3 — see "Revert last upgrade".
  emit(runId, 'promote', 'ok', 'gate passed — change is live. Use "Revert last upgrade" if you don\'t want it.');
  return {
    runId,
    success: true,
    rolledBack: false,
    snapshot,
    risk,
    gate,
    sandbox: sandboxResult,
    probe,
    repo,
    durationMs: Date.now() - started
  };
}

export { broadcast as _broadcastPipelineEvent };
