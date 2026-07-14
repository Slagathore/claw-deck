import { BrowserWindow, webContents } from 'electron';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { type PatchSet, applyPatchSet } from './patcher';
import { assessRisk, type RiskAssessment } from './risk';
import { createSnapshot, restoreSnapshot, type Snapshot } from './snapshot';
import { baselineAudit, runGate, describeGate, type GateResult } from './gate';
import { runProbe, type ProbeResult, type ProbeCheck } from './probe';
import { runInSandbox, type SandboxResult } from './sandbox';
import { repoStatus, type RepoStatus } from './github';
import type { BuildResult } from './build';
import type { PromotedRecord } from './promoted';

export type PipelinePhase =
  | 'github-check'
  | 'baseline-audit'
  | 'snapshot'
  | 'apply-patch'
  | 'gate'
  | 'sandbox'
  | 'build'
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
  build?: BuildResult;
  /** Set only when the patched tree was actually built and promoted (packaged mode). */
  promoted?: PromotedRecord;
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
  /**
   * Packaged mode: the app boots from the asar, so patching userData/source
   * changes nothing on its own. When set, a passing patch is BUILT into a
   * promoted bundle, boot-probed as a child process, and only then promoted —
   * see promoted.ts. In dev this stays false: the patched tree IS the repo.
   */
  packaged?: boolean;
  /** app.getAppPath() — where the shipped node_modules live (packaged builds). */
  appRoot?: string;
  /** app.getVersion() — stamped into the promoted bundle so it is never loaded by another version. */
  appVersion?: string;
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
    // 'self' scope: refused outright if `sourceRoot` is not Claw Deck's own tree.
    snapshot = await createSnapshot(sourceRoot, `pre-upgrade ${runId}`, 'self');
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
    emit(runId, 'sandbox', 'start', 'high-risk patch: cloning to a sandbox tempdir before touching the live tree');
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

  // 6. gate (delta scan, plus typecheck/tests when the tree has a toolchain).
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
    // Say exactly which checks ran and which could not — a reduced gate must
    // never be reported as if it were the full one.
    emit(runId, 'gate', 'ok', describeGate(gate), { reasons: gate.reasons, mode: gate.mode, ran: gate.ran, skipped: gate.skipped, baseline: gate.baseline, patched: gate.patched });
  } catch (e: any) {
    emit(runId, 'gate', 'fail', e.message);
    try { await restoreSnapshot(snapshot); } catch {}
    return { runId, success: false, rolledBack: true, snapshot, risk, repo, sandbox: sandboxResult, error: `gate error: ${e.message}`, durationMs: Date.now() - started };
  }

  const fail = async (phase: PipelinePhase, message: string, extra: Partial<PipelineResult> = {}): Promise<PipelineResult> => {
    emit(runId, phase, 'fail', message);
    try { await restoreSnapshot(snapshot); emit(runId, 'rollback', 'ok', `restored from snapshot after ${phase} failure`); } catch { /* nothing better to do */ }
    return { runId, success: false, rolledBack: true, snapshot, risk, repo, gate, sandbox: sandboxResult, error: message, durationMs: Date.now() - started, ...extra };
  };

  // 7. packaged mode: BUILD the patched tree into a bundle the app can boot, and
  // boot-probe that bundle in a child process. Without this, a packaged
  // self-upgrade only ever edited a copy of the source that nothing executed.
  let build: BuildResult | undefined;
  let promoted: PromotedRecord | undefined;
  let probe: ProbeResult | undefined;

  if (opts.packaged) {
    const { buildPromotedBundle } = await import('./build');
    const { bundlesDir, writeCurrent } = await import('./promoted');
    const bundleId = `bundle-${runId}`;
    const outDir = path.join(bundlesDir(), bundleId);

    // The bundler resolves the app's runtime deps (react, zustand, xterm, …)
    // from the source tree's own node_modules. Those live inside the read-only
    // asar otherwise, which esbuild (a native binary) cannot read. So the build
    // needs the same "Prepare deps" install the full gate does — fail loudly and
    // actionably rather than emitting a half-bundle.
    try {
      await fsp.access(path.join(sourceRoot, 'node_modules'));
    } catch {
      return await fail('build',
        `cannot build the patched tree into a runnable bundle: ${sourceRoot} has no node_modules. ` +
        `Click "Prepare deps" first (it installs them once), then re-run the upgrade.`);
    }

    emit(runId, 'build', 'start', 'bundling the patched source with the shipped esbuild');
    try {
      build = await buildPromotedBundle({
        sourceRoot,
        outDir,
        appRoot: opts.appRoot ?? '',
        appVersion: opts.appVersion ?? '0.0.0'
      });
    } catch (e: any) {
      await fsp.rm(outDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
      return await fail('build', `build error: ${e.message}`);
    }
    if (!build.ok) {
      await fsp.rm(outDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
      return await fail('build', `build failed: ${build.errors.join(' | ').slice(0, 800)}`, { build });
    }
    emit(runId, 'build', 'ok', `bundled in ${build.durationMs}ms → ${outDir}`, { warnings: build.warnings.length });

    // Boot the freshly built bundle in a throwaway process, with its own userData
    // so it cannot disturb the running app's DB or boot sentinel. A packaged app
    // ignores a path argument, so the child is steered with CLAW_BOOT_PROMOTED,
    // which boot.ts honours only for paths inside the bundles directory.
    const probeUserData = path.join(os.tmpdir(), `claw-deck-probe-${runId}`);
    const checks: ProbeCheck[] = (opts.probeChecks?.length ? opts.probeChecks : ['boot', 'db', 'render']);
    emit(runId, 'probe', 'start', `booting the built bundle with checks: ${checks.join(',')}`);
    try {
      probe = await runProbe({
        electronExe: opts.electronExe ?? process.execPath,
        cwd: sourceRoot,
        env: { CLAW_BOOT_PROMOTED: outDir, CLAW_USER_DATA: probeUserData, CLAW_PROMOTED_ENABLE: '1' },
        checks,
        timeoutMs: 90000
      });
    } catch (e: any) {
      await fsp.rm(outDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
      return await fail('probe', `probe error: ${e.message}`, { build });
    } finally {
      await fsp.rm(probeUserData, { recursive: true, force: true }).catch(() => { /* ignore */ });
    }
    if (!probe.ok) {
      await fsp.rm(outDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
      return await fail('probe', `the built bundle did not boot: ${probe.reason || 'probe failed'}`, { build, probe });
    }
    emit(runId, 'probe', 'ok', `the built bundle booted and passed ${checks.join(',')} in ${probe.durationMs}ms`, probe);

    promoted = {
      id: bundleId,
      dir: outDir,
      appVersion: opts.appVersion ?? '0.0.0',
      promotedAt: Date.now(),
      runId,
      gateMode: gate.mode,
      gateRan: gate.ran,
      gateSkipped: gate.skipped
    };
    writeCurrent(promoted);
    emit(runId, 'promote', 'ok',
      `built and boot-probed (${describeGate(gate)}). Claw Deck will load this upgrade on its next launch; ` +
      `if it fails to boot, it rolls back to the pristine build automatically.`,
      promoted);

    return { runId, success: true, rolledBack: false, snapshot, risk, gate, sandbox: sandboxResult, build, probe, promoted, repo, durationMs: Date.now() - started };
  }

  // 7b. dev mode: optional probe of the patched tree (the repo IS the source).
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
        return await fail('probe', probe.reason || 'probe failed', { probe });
      }
      emit(runId, 'probe', 'ok', `probe passed in ${probe.durationMs}ms`, probe);
    } catch (e: any) {
      return await fail('probe', `probe error: ${e.message}`);
    }
  } else {
    emit(runId, 'probe', 'skip', 'no electron exe configured');
  }

  // 8. promote (dev). There is no separate approval step: the patch has been live
  // in the source tree since step 5 (or, for high-risk patches, since it
  // passed the step-4 sandbox clone), so this event just marks the pipeline
  // as done. Undo with the snapshot from step 3 — see "Revert last upgrade".
  emit(runId, 'promote', 'ok', `${describeGate(gate)}. Change is live in the source tree. Use "Revert last upgrade" if you don't want it.`);
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
