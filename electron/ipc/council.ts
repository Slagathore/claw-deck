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
import { appendAudit } from './security';
import { PROTOCOLS } from '../council/protocol';
import { runProtocol, ExecutorHooks, CouncilEvent } from '../council/run';
import { makeTransport, TransportConfig } from '../council/transport';
import { RosterAgent, SessionAssignment, validateAssignment } from '../council/agents';
import { createWorktree, captureDiff, writeArtifacts, applyToLiveTree, removeWorktree, Worktree } from '../executor/worktree';
import { applyDiffToWorktree } from '../executor/applyDiff';
import { validateWorktree } from '../executor/validate';

const signals = new Map<string, { aborted: boolean }>();

function getSetting<T>(key: string, fallback: T): T {
  try { const r = getDb().prepare('SELECT value FROM settings WHERE key=?').get(key) as { value: string } | undefined; return r ? JSON.parse(r.value) as T : fallback; }
  catch { return fallback; }
}

function transportConfig(repo?: string): TransportConfig {
  return {
    ollamaCloudUrl: getSetting('ollamaCloudUrl', 'https://ollama.com/v1'),
    ollamaCloudKey: getSetting('ollamaCloudKey', '') || process.env.OLLAMA_API_KEY || undefined,
    ollamaLocalUrl: getSetting('ollamaUrl', 'http://localhost:11434').replace(/\/$/, '') + '/v1',
    openaiCompatUrl: getSetting('openaiCompatUrl', 'http://localhost:11434/v1'),
    openaiCompatKey: getSetting('openaiCompatKey', '') || undefined,
    paths: { claude: getSetting('claudeCodePath', 'claude'), codex: getSetting('codexPath', 'codex'), openclaw: getSetting('openclawPath', 'openclaw') || 'openclaw' },
    cwd: repo,
  };
}

/** Executor hooks for the execute phase: a lazily-created worktree run on `repo`. */
function makeExecutorHooks(repo: string, runId: string): ExecutorHooks {
  let wt: Worktree | null = null;
  let lastDiff = '';
  return {
    propose: async (plan, diff) => {
      if (!diff || !diff.trim()) return { ok: false, error: 'no diff to apply' };
      if (!wt) { const c = await createWorktree(repo, `council-${runId}`); if (!c.ok) return { ok: false, error: c.error }; wt = c.wt; }
      const a = await applyDiffToWorktree(wt, diff);
      if (!a.ok) return { ok: false, error: a.error };
      lastDiff = await captureDiff(wt);
      writeArtifacts(wt, plan, lastDiff);
      appendAudit('council:proposal', { runId, diffBytes: lastDiff.length });
      return { ok: true, diff: lastDiff };
    },
    validate: async () => (wt ? { ok: (await validateWorktree(wt)).ok } : { ok: false }),
    approve: async () => {
      if (!wt) return { ok: false, error: 'no worktree' };
      const ap = await applyToLiveTree(wt, lastDiff);
      if (ap.ok) { appendAudit('council:approved', { runId, diffBytes: lastDiff.length }); await removeWorktree(wt); }
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
    const signal = { aborted: false };
    signals.set(runId, signal);

    const db = getDb();
    db.prepare('INSERT INTO council_runs(run_id, repo, protocol, task, assignment, status, started) VALUES(?,?,?,?,?,?,?)')
      .run(runId, opts.repo ?? null, protocol.id, opts.task, JSON.stringify(opts.assignment), 'running', Date.now());
    appendAudit('council:start', { runId, protocol: protocol.id, repo: opts.repo ?? null });

    const transport = makeTransport(transportConfig(opts.repo));
    const executor = opts.repo ? makeExecutorHooks(opts.repo, runId) : undefined;

    // run in the background; resolve the handle immediately with the runId
    void runProtocol(protocol, { roster, assignment: opts.assignment, task: opts.task, transport, executor, signal, emit: (ev) => send(runId, ev) })
      .then((res) => {
        db.prepare('UPDATE council_runs SET status=?, approved=?, finished=?, result=? WHERE run_id=?')
          .run(res.status, res.approved ? 1 : 0, Date.now(), JSON.stringify({ phasesRun: res.phasesRun, verdicts: res.verdicts, transcriptLen: res.transcript.length }), runId);
        appendAudit('council:finish', { runId, status: res.status, approved: res.approved });
        send(runId, { type: 'finished', status: res.status, ok: res.approved });
      })
      .catch((err) => {
        db.prepare('UPDATE council_runs SET status=?, finished=? WHERE run_id=?').run('error', Date.now(), runId);
        send(runId, { type: 'error', content: String(err?.message ?? err) });
      })
      .finally(() => signals.delete(runId));

    return { ok: true, runId };
  });

  ipcMain.handle('council:cancel', (_e, opts: { runId: string }) => {
    const s = signals.get(opts.runId);
    if (s) s.aborted = true;
    return { ok: !!s };
  });

  ipcMain.handle('council:list', () => {
    const rows = getDb().prepare('SELECT run_id AS runId, repo, protocol, task, status, approved, started, finished FROM council_runs ORDER BY started DESC LIMIT 50').all();
    return { ok: true, runs: rows };
  });
}
