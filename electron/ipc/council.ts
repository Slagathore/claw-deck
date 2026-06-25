// Council Orchestrator IPC (BOOTSTRAP §3 Phase 3).
//   council:start  → resolve roster + assignment, build transport + executor
//                    hooks, run the protocol in the background, stream
//                    council:event to the renderer, persist council_runs.
//   council:cancel → flip the run's abort signal.
//   council:list   → recent runs from council_runs.
// Gates auto-parse their verdict for now; interactive approveGate is a Phase-4
// refinement (the event stream already surfaces every verdict).

import { ipcMain, BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { getDb } from './db';
import { getSetting } from './settings';
import { appendAudit } from './security';
import { PROTOCOLS } from '../council/protocol';
import { runProtocol, ExecutorHooks, CouncilEvent } from '../council/run';
import { runAutoloop } from '../council/autoloop';
import { makeTransport, TransportConfig } from '../council/transport';
import { RosterAgent, SessionAssignment, validateAssignment, resolveAgents } from '../council/agents';
import { createWorktree, captureDiff, writeArtifacts, applyToLiveTree, removeWorktree, Worktree } from '../executor/worktree';
import { applyDiffToWorktree } from '../executor/applyDiff';
import { validateWorktree } from '../executor/validate';
import { git } from '../executor/git';
import { createSnapshot } from '../selfUpgrade/snapshot';
import { runCaptured } from './runner';
import { trace } from './trace';

const signals = new Map<string, { aborted: boolean; controller: AbortController }>();

function transportConfig(repo?: string, abortSignal?: AbortSignal): TransportConfig {
  // Local Ollama serves *:cloud models itself (no key). ollamaCloudUrl is an
  // OPTIONAL override for a genuinely remote OpenAI-compat endpoint; blank → local.
  const localV1 = getSetting('ollamaUrl', 'http://localhost:11434').replace(/\/$/, '') + '/v1';
  return {
    ollamaCloudUrl: getSetting('ollamaCloudUrl', '') || localV1,
    ollamaCloudKey: getSetting('ollamaCloudKey', '') || process.env.OLLAMA_API_KEY || undefined,
    ollamaLocalUrl: localV1,
    openaiCompatUrl: getSetting('openaiCompatUrl', 'http://localhost:11434/v1'),
    openaiCompatKey: getSetting('openaiCompatKey', '') || undefined,
    paths: { claude: getSetting('claudeCodePath', 'claude'), codex: getSetting('codexPath', 'codex'), openclaw: getSetting('openclawPath', 'openclaw') || 'openclaw' },
    bridgePort: getSetting('clawBridgePort', 39217),
    abortSignal,
    // default: use the claude-login subscription, not API credits → drop ANTHROPIC_API_KEY for claude spawns
    claudeUnsetEnv: getSetting('claudeUseApiKey', false) ? undefined : ['ANTHROPIC_API_KEY'],
    cwd: repo,
  };
}

async function probeAgent(agent: RosterAgent, repo?: string): Promise<{ ok: boolean; detail: string }> {
  try {
    trace('council:probe:start', { agentId: agent.id, transport: agent.transport, model: agent.model, binary: agent.binary, repo });
    if (agent.transport === 'claude-code' || agent.transport === 'codex' || agent.transport === 'openclaw') {
      const cfg = transportConfig(repo);
      const binary = agent.transport === 'claude-code'
        ? (cfg.paths?.claude ?? agent.binary ?? 'claude')
        : agent.transport === 'codex'
          ? (cfg.paths?.codex ?? agent.binary ?? 'codex')
          : (cfg.paths?.openclaw ?? agent.binary ?? 'openclaw');
      const args = agent.transport === 'openclaw' ? ['--version'] : ['--help'];
      const r = await runCaptured({ binary, args, cwd: repo, timeoutMs: 8000 });
      const text = (r.stdout || r.stderr).trim().slice(0, 300);
      const out = r.code === 0 || text ? { ok: true, detail: text || `${binary} responded` } : { ok: false, detail: `${binary} exited ${r.code}` };
      trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: out.ok, detail: out.detail, binary });
      return out;
    }
    if (agent.transport === 'ollama-cloud' || agent.transport === 'ollama-local') {
      const base = getSetting<string>('ollamaUrl', 'http://localhost:11434').replace(/\/$/, '');
      const model = agent.model ?? '';
      const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return { ok: false, detail: `Ollama HTTP ${r.status}` };
      const j: any = await r.json();
      const models: any[] = j.models ?? [];
      const found = models.find((m: any) => m.name === model || m.model === model);
      if (agent.transport === 'ollama-cloud') {
        if (!model) {
          const out = { ok: false, detail: 'missing cloud model' };
          trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: false, detail: out.detail });
          return out;
        }
        if (!found) {
          const out = { ok: false, detail: `${model} not listed by local Ollama; run "ollama pull ${model}" to create the cloud stub` };
          trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: false, detail: out.detail });
          return out;
        }
        if (!found.remote_host) {
          const out = { ok: false, detail: `${model} is local-only; choose a model with remote_host / :cloud / -cloud for ollama-cloud` };
          trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: false, detail: out.detail });
          return out;
        }
        const out = { ok: true, detail: `${model} cloud via ${found.remote_host}${found.remote_model ? ` (${found.remote_model})` : ''}` };
        trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: true, detail: out.detail, remoteHost: found.remote_host, remoteModel: found.remote_model });
        return out;
      }
      const out = !model || found ? { ok: true, detail: model ? `${model} local model available` : `${models.length} models available` } : { ok: false, detail: `${model} not pulled in Ollama` };
      trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: out.ok, detail: out.detail });
      return out;
    }
    if (agent.transport === 'openai-compat') {
      return agent.model ? { ok: true, detail: 'configured; run starts will verify the endpoint' } : { ok: false, detail: 'missing model' };
    }
    if (agent.transport === 'vscode-lm') {
      const st = await (await import('../bridge/client')).bridgeStatus(getSetting('clawBridgePort', 39217));
      return st.connected ? { ok: true, detail: 'VS Code bridge connected' } : { ok: false, detail: 'VS Code bridge offline' };
    }
    const out = { ok: false, detail: `unknown transport ${agent.transport}` };
    trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: false, detail: out.detail });
    return out;
  } catch (e: any) {
    const out = { ok: false, detail: e?.message ?? String(e) };
    trace('council:probe:error', { agentId: agent.id, transport: agent.transport, detail: out.detail });
    return out;
  }
}

function outputSnippet(r: { code: number | null; stdout: string; stderr: string }): string {
  const text = `${r.stdout}\n${r.stderr}`.trim();
  return text.slice(Math.max(0, text.length - 1500)) || `process exited ${r.code}`;
}

async function runEditingDelegate(agent: RosterAgent, prompt: string, wt: Worktree, cfg: TransportConfig): Promise<{ ok: boolean; output?: string; error?: string }> {
  trace('council:delegate:start', { agentId: agent.id, transport: agent.transport, worktree: wt.dir, promptBytes: prompt.length });
  if (agent.transport === 'claude-code') {
    const binary = cfg.paths?.claude ?? agent.binary ?? 'claude';
    const r = await runCaptured({
      binary,
      args: ['--print', '--input-format', 'text', '--permission-mode', 'bypassPermissions', '--no-session-persistence'],
      input: prompt,
      cwd: wt.dir,
      timeoutMs: 600000,
      signal: cfg.abortSignal,
      unsetEnv: cfg.claudeUnsetEnv,
    });
    const out = r.code === 0 ? { ok: true, output: outputSnippet(r) } : { ok: false, error: outputSnippet(r) };
    trace('council:delegate:finish', { agentId: agent.id, transport: agent.transport, ok: out.ok, code: r.code, stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length });
    return out;
  }

  if (agent.transport === 'codex') {
    const binary = cfg.paths?.codex ?? agent.binary ?? 'codex';
    const r = await runCaptured({
      binary,
      args: ['exec', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '--skip-git-repo-check', '--color', 'never', '-'],
      input: prompt,
      cwd: wt.dir,
      timeoutMs: 600000,
      signal: cfg.abortSignal,
    });
    const out = r.code === 0 ? { ok: true, output: outputSnippet(r) } : { ok: false, error: outputSnippet(r) };
    trace('council:delegate:finish', { agentId: agent.id, transport: agent.transport, ok: out.ok, code: r.code, stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length });
    return out;
  }

  if (agent.transport === 'openclaw') {
    const binary = cfg.paths?.openclaw ?? agent.binary ?? 'openclaw';
    const args = ['agent', '--local', '--json', '--message', prompt];
    if (agent.model) args.push('--model', agent.model);
    const r = await runCaptured({ binary, args, cwd: wt.dir, timeoutMs: 600000, signal: cfg.abortSignal });
    const out = r.code === 0 ? { ok: true, output: outputSnippet(r) } : { ok: false, error: outputSnippet(r) };
    trace('council:delegate:finish', { agentId: agent.id, transport: agent.transport, ok: out.ok, code: r.code, stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length });
    return out;
  }

  const out = { ok: false, error: `${agent.displayName} uses ${agent.transport}; direct file editing requires Claude Code, Codex, or OpenClaw.` };
  trace('council:delegate:finish', { agentId: agent.id, transport: agent.transport, ok: false, error: out.error });
  return out;
}

/** Executor hooks for the execute phase: a lazily-created worktree run on `repo`. */
function makeExecutorHooks(repo: string, runId: string, abortSignal?: AbortSignal): ExecutorHooks {
  let wt: Worktree | null = null;
  let lastDiff = '';
  const started = Date.now();
  const cfg = transportConfig(repo, abortSignal);
  const ensureWorktree = async (): Promise<{ ok: boolean; wt?: Worktree; error?: string }> => {
    if (wt) return { ok: true, wt };
    const c = await createWorktree(repo, `council-${runId}`);
    if (!c.ok) return { ok: false, error: c.error };
    wt = c.wt;
    return { ok: true, wt };
  };
  const persist = (status: string, extra: Record<string, unknown> = {}) => {
    if (!wt) return;
    getDb().prepare(`
      INSERT INTO executor_runs(run_id, repo, mode, status, wt_dir, branch, plan_path, diff_path, diff_bytes, validation_ok, snapshot_id, started, updated, error)
      VALUES(@runId, @repo, 'council', @status, @wtDir, @branch, @planPath, @diffPath, @diffBytes, @validationOk, @snapshotId, @started, @updated, @error)
      ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, plan_path=COALESCE(excluded.plan_path, executor_runs.plan_path),
      diff_path=COALESCE(excluded.diff_path, executor_runs.diff_path), diff_bytes=excluded.diff_bytes,
      validation_ok=excluded.validation_ok, snapshot_id=COALESCE(excluded.snapshot_id, executor_runs.snapshot_id), updated=excluded.updated, error=excluded.error
    `).run({
      runId: `council-${runId}`,
      repo,
      status,
      wtDir: wt.dir,
      branch: wt.branch,
      planPath: extra.planPath ?? null,
      diffPath: extra.diffPath ?? null,
      diffBytes: lastDiff.length,
      validationOk: extra.validationOk ?? null,
      snapshotId: extra.snapshotId ?? null,
      started,
      updated: Date.now(),
      error: extra.error ?? null,
    });
  };
  return {
    propose: async (plan, diff) => {
      if (!diff || !diff.trim()) return { ok: false, error: 'no diff to apply' };
      const c = await ensureWorktree();
      if (!c.ok || !c.wt) return { ok: false, error: c.error };
      const a = await applyDiffToWorktree(c.wt, diff);
      if (!a.ok) return { ok: false, error: a.error };
      lastDiff = await captureDiff(c.wt);
      const paths = writeArtifacts(c.wt, plan, lastDiff);
      persist('proposed', paths);
      appendAudit('council:proposal', { runId, diffBytes: lastDiff.length });
      return { ok: true, diff: lastDiff };
    },
    delegate: async (agent, prompt) => {
      const c = await ensureWorktree();
      if (!c.ok || !c.wt) return { ok: false, error: c.error };
      const r = await runEditingDelegate(agent, prompt, c.wt, cfg);
      if (!r.ok) {
        persist('delegate-failed', { error: r.error ?? 'delegate failed' });
        appendAudit('council:delegateFailed', { runId, agentId: agent.id, error: (r.error ?? '').slice(0, 300) });
        return { ok: false, error: r.error };
      }
      lastDiff = await captureDiff(c.wt);
      if (!lastDiff.trim()) {
        persist('no-changes', { error: 'delegate completed without modifying files' });
        appendAudit('council:delegateNoChanges', { runId, agentId: agent.id });
        return { ok: false, error: `${agent.displayName} completed without modifying files` };
      }
      const paths = writeArtifacts(c.wt, `${prompt}\n\n## Delegate output\n\n${r.output ?? ''}`, lastDiff);
      persist('proposed', paths);
      appendAudit('council:delegate', { runId, agentId: agent.id, diffBytes: lastDiff.length });
      return { ok: true, diff: lastDiff };
    },
    validate: async () => {
      if (!wt) return { ok: false };
      const result = await validateWorktree(wt);
      persist(result.ok ? 'validated' : 'invalid', { validationOk: result.ok ? 1 : 0 });
      return { ok: result.ok };
    },
    approve: async () => {
      if (!wt) return { ok: false, error: 'no worktree' };
      const snap = await createSnapshot(wt.repo, `fusion council pre-approve ${runId}`);
      const ap = await applyToLiveTree(wt, lastDiff);
      if (ap.ok) { appendAudit('council:approved', { runId, diffBytes: lastDiff.length, snapshotId: snap.id }); persist('approved', { snapshotId: snap.id, validationOk: 1 }); await removeWorktree(wt); }
      else persist('apply-failed', { snapshotId: snap.id, error: ap.error ?? 'apply failed' });
      return ap;
    },
  };
}

export function registerCouncilHandlers(getWindow: () => BrowserWindow | null) {
  const send = (runId: string, ev: CouncilEvent) => { try { getWindow()?.webContents.send('council:event', { runId, ...ev }); } catch { /* gone */ } };

  ipcMain.handle('council:start', (_e, opts: { repo?: string; protocolId: string; assignment: SessionAssignment; task: string }) => {
    const protocol = PROTOCOLS[opts.protocolId];
    if (!protocol) return { ok: false, error: `unknown protocol: ${opts.protocolId}` };
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    const va = validateAssignment(roster, opts.assignment);
    if (!va.ok) return { ok: false, error: `invalid assignment${va.missing.length ? ` (unknown ids: ${va.missing.join(', ')})` : ' (need ≥1 panelist + judge + qa-gate)'}` };

    const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    const signal = { aborted: false, controller };
    signals.set(runId, signal);

    const db = getDb();
    db.prepare('INSERT INTO council_runs(run_id, repo, protocol, task, assignment, status, started) VALUES(?,?,?,?,?,?,?)')
      .run(runId, opts.repo ?? null, protocol.id, opts.task, JSON.stringify(opts.assignment), 'running', Date.now());
    appendAudit('council:start', { runId, protocol: protocol.id, repo: opts.repo ?? null });
    trace('council:start', { runId, protocol: protocol.id, repo: opts.repo ?? null, assignment: opts.assignment, taskBytes: opts.task.length });

    const transport = makeTransport(transportConfig(opts.repo, controller.signal));
    const executor = opts.repo ? makeExecutorHooks(opts.repo, runId, controller.signal) : undefined;

    // run in the background; resolve the handle immediately with the runId
    void runProtocol(protocol, { roster, assignment: opts.assignment, task: opts.task, transport, executor, signal, emit: (ev) => send(runId, ev) })
      .then((res) => {
        db.prepare('UPDATE council_runs SET status=?, approved=?, finished=?, result=? WHERE run_id=?')
          .run(res.status, res.approved ? 1 : 0, Date.now(), JSON.stringify({ phasesRun: res.phasesRun, verdicts: res.verdicts, transcriptLen: res.transcript.length }), runId);
        appendAudit('council:finish', { runId, status: res.status, approved: res.approved });
        trace('council:finish', { runId, status: res.status, approved: res.approved, phasesRun: res.phasesRun });
        send(runId, { type: 'finished', status: res.status, ok: res.approved });
      })
      .catch((err) => {
        db.prepare('UPDATE council_runs SET status=?, finished=? WHERE run_id=?').run('error', Date.now(), runId);
        trace('council:error', { runId, error: String(err?.message ?? err), stack: err?.stack });
        send(runId, { type: 'error', content: String(err?.message ?? err) });
      })
      .finally(() => signals.delete(runId));

    return { ok: true, runId };
  });

  // Autonomous goal loop (Phase 5): branch → run protocol → checkpoint → goal-check → repeat.
  ipcMain.handle('council:startLoop', (_e, opts: { repo: string; protocolId: string; assignment: SessionAssignment; goal: string; maxIterations?: number; costCeiling?: number }) => {
    if (!opts?.repo) return { ok: false, error: 'autonomous loop needs a workspace (for checkpoints)' };
    const protocol = PROTOCOLS[opts.protocolId];
    if (!protocol) return { ok: false, error: `unknown protocol: ${opts.protocolId}` };
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    const va = validateAssignment(roster, opts.assignment);
    if (!va.ok) return { ok: false, error: `invalid assignment${va.missing.length ? ` (unknown ids: ${va.missing.join(', ')})` : ''}` };

    const runId = `loop-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const controller = new AbortController();
    const signal = { aborted: false, controller };
    signals.set(runId, signal);
    const transport = makeTransport(transportConfig(opts.repo, controller.signal));
    const checker = resolveAgents(roster, ['@judge'], opts.assignment)[0];
    const db = getDb();
    db.prepare('INSERT INTO council_runs(run_id, repo, protocol, task, assignment, status, started) VALUES(?,?,?,?,?,?,?)')
      .run(runId, opts.repo, protocol.id, opts.goal, JSON.stringify(opts.assignment), 'running', Date.now());
    appendAudit('council:loopStart', { runId, protocol: protocol.id, repo: opts.repo, maxIterations: opts.maxIterations ?? 5 });

    const CHECKER_SYS = 'You verify whether a coding goal is satisfied. Reply MET only with concrete evidence; otherwise reply NOT MET and the single most useful next step. Default to NOT MET when uncertain.';

    void runAutoloop({
      goal: opts.goal,
      maxIterations: opts.maxIterations ?? 5,
      costCeiling: opts.costCeiling,
      signal,
      emit: (ev) => send(runId, { ...ev, type: `loop:${ev.type}` } as any),
      runIteration: (task, iter) => runProtocol(protocol, { roster, assignment: opts.assignment, task, transport, executor: makeExecutorHooks(opts.repo, `${runId}-i${iter}`, controller.signal), signal, emit: (ev) => send(runId, ev) }),
      checkpoint: async (iter) => {
        await git(opts.repo, ['add', '-A']);
        await git(opts.repo, ['commit', '-m', `fusion autoloop ${runId} iter ${iter}`, '--allow-empty', '--no-verify']);
        const t = await git(opts.repo, ['rev-parse', 'HEAD^{tree}']);
        return { signature: t.stdout.trim() || `iter-${iter}` };
      },
      checkGoal: async (goal, _iter, last) => {
        if (!checker) return { met: false, reason: 'no checker agent' };
        const reply = await transport(checker, [{ role: 'system', content: CHECKER_SYS }, { role: 'user', content: `Goal:\n${goal}\n\nLatest result (approved=${last.approved}):\n${last.artifact.slice(0, 2000)}` }]).catch(() => 'NOT MET');
        const met = /\bmet\b/i.test(reply) && !/not\s*met/i.test(reply);
        return { met, reason: reply.slice(0, 300), nextSubtask: met ? undefined : reply.slice(0, 600) };
      },
    }).then((res) => {
      db.prepare('UPDATE council_runs SET status=?, approved=?, finished=?, result=? WHERE run_id=?')
        .run(res.status, res.status === 'met' ? 1 : 0, Date.now(), JSON.stringify({ iterations: res.iterations, signatures: res.signatures }), runId);
      appendAudit('council:loopFinish', { runId, status: res.status, iterations: res.iterations });
      send(runId, { type: 'loop:done', status: res.status, ok: res.status === 'met' });
    }).catch((err) => {
      db.prepare('UPDATE council_runs SET status=?, finished=? WHERE run_id=?').run('error', Date.now(), runId);
      send(runId, { type: 'error', content: String(err?.message ?? err) });
    }).finally(() => signals.delete(runId));

    return { ok: true, runId };
  });

  ipcMain.handle('council:cancel', (_e, opts: { runId: string }) => {
    const s = signals.get(opts.runId);
    if (s) {
      s.aborted = true;
      try { s.controller.abort(); } catch { /* already aborted */ }     // aborts in-flight HTTP + kills CLI children
      appendAudit('council:cancel', { runId: opts.runId });
      trace('council:cancel', { runId: opts.runId });
    }
    return { ok: !!s };
  });

  ipcMain.handle('council:list', () => {
    const rows = getDb().prepare('SELECT run_id AS runId, repo, protocol, task, status, approved, started, finished FROM council_runs ORDER BY started DESC LIMIT 50').all();
    return { ok: true, runs: rows };
  });

  ipcMain.handle('council:probeAgent', async (_e, opts: { agent: RosterAgent; repo?: string }) => {
    if (!opts?.agent) return { ok: false, detail: 'missing agent' };
    return probeAgent(opts.agent, opts.repo);
  });
}
