import React, { useEffect, useState } from 'react';
import WorkspaceTabs from '../components/WorkspaceTabs';
import CouncilSettings from '../components/CouncilSettings';
import DebateTheater from '../components/DebateTheater';
import DiffReview, { Proposal } from '../components/DiffReview';
import { useWorkspaces } from '../store/workspaces';
import { useCouncil } from '../store/council';

export default function CouncilTab() {
  const { active } = useWorkspaces();
  const { runByWs, events, live, running, startRun, appendEvent, finishRun } = useCouncil();

  // single subscription to the council event stream
  useEffect(() => {
    const off = window.api.council.onEvent((e) => {
      appendEvent(e);
      if (e.type === 'finished' || e.type === 'error') finishRun(e.runId);
    });
    return off;
  }, [appendEvent, finishRun]);

  const runId = active ? runByWs[active] : undefined;

  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <WorkspaceTabs />
        <BridgeBadge />
      </div>
      {!active ? (
        <div className="card" style={{ color: 'var(--muted)' }}>Open a folder to start a multi-agent council session on it.</div>
      ) : (
        <div className="row" style={{ flex: 1, alignItems: 'stretch', minHeight: 0, gap: 10 }}>
          <div className="col" style={{ width: 400, minHeight: 0, overflow: 'auto' }}>
            <CouncilSettings workspace={active} key={active} />
            <SessionHistory repo={active} onRerun={(id) => startRun(active, id)} />
            <ManualExecutor repo={active} />
            <RunLedger repo={active} />
          </div>
          <div className="col" style={{ flex: 1, minHeight: 0 }}>
            {runId && running[runId] && (
              <div className="row" style={{ alignSelf: 'flex-end', gap: 8, alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}><Spinner /> session running…</span>
                <button onClick={() => window.api.council.cancel(runId)} style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>Cancel run</button>
              </div>
            )}
            <DebateTheater events={runId ? (events[runId] ?? []) : []} live={runId ? live[runId] : undefined} running={runId ? running[runId] : false} />
          </div>
        </div>
      )}
    </div>
  );
}

function RunLedger({ repo }: { repo: string }) {
  const [rows, setRows] = useState<any[]>([]);
  const [msg, setMsg] = useState('');
  async function refresh() {
    const r = await window.api.exec.list(80);
    if (r.ok) setRows(r.runs.filter((x: any) => x.repo === repo));
  }
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [repo]);
  async function rollback(id: string) {
    if (!confirm(`Rollback snapshot ${id}? This resets the repo to that snapshot.`)) return;
    const r = await window.api.exec.rollback(id);
    setMsg(r.ok ? `Rolled back ${id}` : (r.error ?? 'rollback failed'));
    refresh();
  }
  return (
    <div className="card col" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><strong>Run ledger</strong><button onClick={refresh}>Refresh</button></div>
      {msg && <div className="label">{msg}</div>}
      {rows.length === 0 && <div className="label">No executor history for this workspace yet.</div>}
      {rows.slice(0, 12).map((r) => (
        <div key={r.run_id} className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 6, alignItems: 'flex-start' }}>
          <div className="col" style={{ flex: 1, gap: 2 }}>
            <div><span className={`badge ${r.status === 'approved' ? 'ok' : r.status === 'invalid' || r.status === 'apply-failed' ? 'bad' : 'warn'}`}>{r.status}</span> <code style={{ fontSize: 11 }}>{r.run_id}</code></div>
            <div className="label">{r.mode} · {r.diff_bytes ?? 0} bytes · validation {r.validation_ok == null ? 'n/a' : r.validation_ok ? 'passed' : 'failed'}</div>
            {r.error && <div className="label" style={{ color: 'var(--bad)' }}>{r.error}</div>}
          </div>
          {r.plan_path && <button onClick={() => window.api.app.openPath(r.plan_path)} style={{ padding: '3px 8px', fontSize: 11 }}>Plan</button>}
          {r.diff_path && <button onClick={() => window.api.app.openPath(r.diff_path)} style={{ padding: '3px 8px', fontSize: 11 }}>Diff</button>}
          {r.snapshot_id && <button onClick={() => rollback(r.snapshot_id)} style={{ padding: '3px 8px', fontSize: 11 }}>Rollback</button>}
        </div>
      ))}
    </div>
  );
}

/** claw-bridge status (Phase 6): live when VS Code + the extension are running. */
function BridgeBadge() {
  const [connected, setConnected] = useState(false);
  const [lm, setLm] = useState(0);
  const [diag, setDiag] = useState(0);
  const [folders, setFolders] = useState(0);
  useEffect(() => {
    let on = true;
    const tick = async () => {
      const st = await window.api.bridge.status();
      if (!on) return;
      setConnected(st.connected); setFolders(st.folders?.length ?? 0);
      if (st.connected) { const m = await window.api.bridge.lmModels(); const d = await window.api.bridge.diagnostics(); if (on) { setLm(m.length); setDiag(d.length); } }
    };
    tick(); const t = setInterval(tick, 5000);
    return () => { on = false; clearInterval(t); };
  }, []);
  return connected
    ? <span className="badge ok" title={`${folders} folder(s)`}>VS Code bridge · {lm} lm · {diag} problems</span>
    : <span className="badge" style={{ color: 'var(--muted)' }} title="Open VS Code with the claw-bridge extension for live diagnostics + vscode.lm models">bridge offline</span>;
}

/** Animated braille spinner — shows the session is alive even while an agent thinks silently. */
function Spinner() {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const [i, setI] = useState(0);
  useEffect(() => { const t = setInterval(() => setI((x) => (x + 1) % frames.length), 80); return () => clearInterval(t); }, []);
  return <span style={{ color: 'var(--accent)' }}>{frames[i]}</span>;
}

/** Past council sessions for this workspace (from council_runs) with a one-click Re-run. */
function SessionHistory({ repo, onRerun }: { repo: string; onRerun: (runId: string) => void }) {
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState('');
  async function refresh() { const r = await window.api.council.list(); if (r.ok) setRows(r.runs.filter((x: any) => x.repo === repo)); }
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [repo]);
  async function rerun(row: any) {
    let assignment: any;
    try { assignment = JSON.parse(row.assignment); } catch { return; }
    setBusy(row.runId);
    const isLoop = String(row.runId).startsWith('loop-');
    const r = isLoop
      ? await window.api.council.startLoop({ repo, protocolId: row.protocol, assignment, goal: row.task })
      : await window.api.council.start({ repo, protocolId: row.protocol, assignment, task: row.task });
    setBusy('');
    if (r.ok && r.runId) onRerun(r.runId);
  }
  return (
    <div className="card col" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><strong>Session history</strong><button onClick={refresh}>Refresh</button></div>
      {rows.length === 0 && <div className="label">No council sessions yet for this workspace.</div>}
      {rows.slice(0, 15).map((r) => (
        <div key={r.runId} className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 6, alignItems: 'flex-start', gap: 6 }}>
          <div className="col" style={{ flex: 1, gap: 2, minWidth: 0 }}>
            <div><span className={`badge ${r.approved || r.status === 'completed' || r.status === 'met' ? 'ok' : r.status === 'running' ? 'warn' : 'bad'}`}>{r.status}</span> <strong>{r.protocol}</strong>{String(r.runId).startsWith('loop-') && <span className="label"> · loop</span>}</div>
            <div className="label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.task}>{r.task}</div>
            <div className="label">{new Date(r.started).toLocaleString()}</div>
          </div>
          <button disabled={!!busy || r.status === 'running'} onClick={() => rerun(r)} title="Restart this session with the same protocol, agents, and task">{busy === r.runId ? '…' : '↻ Re-run'}</button>
        </div>
      ))}
    </div>
  );
}

/**
 * In-tab manual executor (Phase 2): begin an apply-mode worktree run, paste a
 * plan + unified diff, then Validate → Approve/Reject via DiffReview. Lets Cole
 * approve/reject a diff in-tab independent of an auto council run.
 */
function ManualExecutor({ repo }: { repo: string }) {
  const [open, setOpen] = useState(false);
  const [plan, setPlan] = useState('');
  const [diff, setDiff] = useState('');
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  async function propose() {
    setErr(''); setBusy('Creating worktree + applying diff…');
    const begun = await window.api.exec.beginRun(repo, 'apply');
    if (!begun.ok || !begun.runId) { setBusy(''); setErr(begun.error ?? 'beginRun failed'); return; }
    const p = await window.api.exec.proposal(begun.runId, plan, diff);
    setBusy('');
    if (!p.ok) { setErr(p.error ?? 'proposal failed'); return; }
    setProposal({ runId: begun.runId, plan: p.plan ?? plan, diff: p.diff ?? diff });
  }

  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <strong>Manual change (executor)</strong><span style={{ color: 'var(--muted)' }}>{open ? '▾' : '▸'}</span>
      </div>
      {open && !proposal && (
        <>
          <textarea placeholder="CHANGE_PLAN.md — intent / approach" value={plan} onChange={(e) => setPlan(e.target.value)} rows={3} />
          <textarea placeholder="unified diff (git diff format)" value={diff} onChange={(e) => setDiff(e.target.value)} rows={6} style={{ fontFamily: 'monospace', fontSize: 11 }} />
          {err && <div style={{ color: 'var(--bad)', fontSize: 12 }}>{err}</div>}
          <div className="row"><button onClick={propose} disabled={!!busy || !diff.trim()}>Stage proposal</button>{busy && <span className="badge warn">{busy}</span>}</div>
        </>
      )}
      {open && proposal && <DiffReview proposal={proposal} onResolved={() => { setProposal(null); setPlan(''); setDiff(''); }} />}
    </div>
  );
}
