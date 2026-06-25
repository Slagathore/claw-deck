import React, { useEffect, useState } from 'react';
import WorkspaceTabs from '../components/WorkspaceTabs';
import CouncilSettings from '../components/CouncilSettings';
import DebateTheater from '../components/DebateTheater';
import DiffReview, { Proposal } from '../components/DiffReview';
import { useWorkspaces } from '../store/workspaces';
import { useCouncil } from '../store/council';

export default function CouncilTab() {
  const { active } = useWorkspaces();
  const { runByWs, events, live, questions, running, startRun, appendEvent, clearQuestions, markRunning, newSession, finishRun } = useCouncil();
  const [roster, setRoster] = useState<{ id: string; displayName: string }[]>([]);
  const [expanded, setExpanded] = useState(false);

  // single subscription to the council event stream
  useEffect(() => {
    const off = window.api.council.onEvent((e) => {
      appendEvent(e);
      if (e.type === 'finished' || e.type === 'error') finishRun(e.runId);
    });
    return off;
  }, [appendEvent, finishRun]);

  // roster for id → display name (so the theater shows your configured names)
  useEffect(() => { window.api.settings.get().then((s) => setRoster(s.fusionRoster ?? [])); }, []);
  const nameOf = (id?: string) => roster.find((a) => a.id === id)?.displayName ?? id ?? '';

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
          {!expanded && (
            <div className="col" style={{ width: 400, minHeight: 0, overflow: 'auto' }}>
              <CouncilSettings workspace={active} key={active} />
              <FusionMethods repo={active} />
              <SessionHistory repo={active} onRerun={(id) => startRun(active, id)} />
              <ManualExecutor repo={active} />
              <RunLedger repo={active} />
            </div>
          )}
          <div className="col" style={{ flex: 1, minHeight: 0 }}>
            <div className="row" style={{ justifyContent: 'flex-end', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {runId && running[runId] && <span style={{ color: 'var(--muted)', fontSize: 12 }}><Spinner /> running…</span>}
              {runId && running[runId] && <button onClick={() => window.api.council.cancel(runId)} style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>Cancel</button>}
              <button onClick={() => newSession(active)} title="Clear this view and configure a fresh session (past runs stay in Session history)">＋ New session</button>
              <button onClick={() => setExpanded((x) => !x)} title="Toggle full-width theater">{expanded ? '◧ Show controls' : '⛶ Expand'}</button>
            </div>
            {runId && (questions[runId]?.length ?? 0) > 0 && <ProloguePanel key={runId} runId={runId} questions={questions[runId]} onSubmitted={() => { clearQuestions(runId); markRunning(runId); }} />}
            {runId && !running[runId] && lastFinishedStatus(events[runId]) === 'bounced' && <BounceRecovery runId={runId} onSent={() => markRunning(runId)} />}
            {runId && !running[runId] && isTerminated(events[runId]) && <PostRunPanel runId={runId} roster={roster} />}
            <DebateTheater events={runId ? (events[runId] ?? []) : []} live={runId ? live[runId] : undefined} running={runId ? running[runId] : false} nameOf={nameOf} />
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

const WRAP: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' };

/** §3/§4 — launcher for the fusion methods (foundry / foundry-design / assay / prospect / relay / scatter). */
function FusionMethods({ repo }: { repo: string }) {
  const { startRun } = useCouncil();
  const [methods, setMethods] = useState<{ id: string; name: string; use: string; endPrompt: string; budget: string; card: string }[]>([]);
  const [methodId, setMethodId] = useState('foundry');
  const [task, setTask] = useState('');
  const [focus, setFocus] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { window.api.council.methods().then((r) => { if (r.ok) setMethods(r.methods); }); }, []);
  const sel = methods.find((m) => m.id === methodId);
  const needsFocus = methodId === 'assay' || methodId === 'prospect';
  async function run() {
    if (!task.trim()) { setErr('describe the task first'); return; }
    setBusy(true); setErr('');
    const r = await window.api.council.runMethod({ repo, methodId, task, focus: focus.trim() || undefined });
    setBusy(false);
    if (r.ok && r.runId) startRun(repo, r.runId); else setErr(r.error ?? 'failed to start');
  }
  return (
    <div className="card col" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><strong>⚗ Fusion methods</strong><span className="label">{sel?.budget}</span></div>
      <select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
        {methods.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      {sel && <div className="label" style={{ ...WRAP }}>{sel.use}</div>}
      <textarea placeholder={needsFocus ? 'What to audit / brainstorm about this repo…' : 'Describe the task / problem…'} value={task} onChange={(e) => setTask(e.target.value)} rows={3} style={{ fontSize: 12 }} />
      {needsFocus && <input placeholder='optional focus: e.g. "auth flow, version detection"' value={focus} onChange={(e) => setFocus(e.target.value)} style={{ fontSize: 12 }} />}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="label" title="shown to you when the run finishes">Ends: {sel?.endPrompt}</span>
        <button onClick={run} disabled={busy} style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>{busy ? 'Starting…' : '▶ Run method'}</button>
      </div>
      {err && <div className="label" style={{ color: 'var(--bad)' }}>{err}</div>}
    </div>
  );
}

/** Post-run tools: ask an agent a follow-up, generate a PR description, or replay
 *  the proposal's evolution across phases. */
function PostRunPanel({ runId, roster }: { runId: string; roster: { id: string; displayName: string }[] }) {
  const [tab, setTab] = useState<'ask' | 'pr' | 'replay' | null>(null);
  const [agentId, setAgentId] = useState(roster[0]?.id ?? '');
  const [target, setTarget] = useState<'agent' | 'room'>('agent');
  const [q, setQ] = useState('');
  const [thread, setThread] = useState<{ q: string; who: string; entries: { name: string; answer: string }[] }[]>([]);
  const [pr, setPr] = useState('');
  const [snaps, setSnaps] = useState<{ phaseIndex: number; label: string; artifact: string }[]>([]);
  const [snapIdx, setSnapIdx] = useState(0);
  const [busy, setBusy] = useState('');

  const nameOf = (id: string) => roster.find((a) => a.id === id)?.displayName ?? id;
  useEffect(() => { if (!agentId && roster[0]) setAgentId(roster[0].id); }, [roster, agentId]);
  async function ask() {
    if (!q.trim()) return;
    setBusy('ask');
    const question = q;
    if (target === 'room') {
      const r = await window.api.council.askRoom(runId, question);
      setThread((t) => [...t, { q: question, who: 'the room', entries: r.ok ? (r.answers ?? []).map((a) => ({ name: nameOf(a.agentId), answer: a.answer })) : [{ name: 'error', answer: r.error ?? 'failed' }] }]);
    } else {
      const r = await window.api.council.ask(runId, agentId, question);
      setThread((t) => [...t, { q: question, who: nameOf(agentId), entries: [{ name: nameOf(agentId), answer: r.ok ? (r.answer ?? '') : `error: ${r.error}` }] }]);
    }
    setQ('');
    setBusy('');
  }
  async function genPr() { setBusy('pr'); setPr(''); const r = await window.api.council.prDescription(runId); setBusy(''); setPr(r.ok ? (r.markdown ?? '') : `error: ${r.error}`); }
  async function loadReplay() { setBusy('replay'); const r = await window.api.council.snapshots(runId); setBusy(''); setSnaps(r.snapshots ?? []); setSnapIdx(Math.max(0, (r.snapshots?.length ?? 1) - 1)); setTab('replay'); }

  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <strong>Post-run</strong>
        <button onClick={() => setTab(tab === 'ask' ? null : 'ask')}>💬 Ask</button>
        <button onClick={() => { setTab('pr'); if (!pr && busy !== 'pr') genPr(); }}>📝 PR description</button>
        <button onClick={loadReplay}>⏮ Replay timeline</button>
      </div>

      {tab === 'ask' && (
        <div className="col" style={{ gap: 6 }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            <select value={target} onChange={(e) => setTarget(e.target.value as any)}>
              <option value="agent">one agent</option>
              <option value="room">the whole room</option>
            </select>
            {target === 'agent' && <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>{roster.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}</select>}
            <input style={{ flex: 1, minWidth: 160 }} placeholder={target === 'room' ? 'Ask everyone who spoke…' : 'Ask this agent about its statement…'} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} />
            <button onClick={ask} disabled={busy === 'ask'}>{busy === 'ask' ? '…' : 'Ask'}</button>
          </div>
          {thread.length > 0 && (
            <div className="col" style={{ gap: 8, maxHeight: 380, overflow: 'auto' }}>
              {thread.map((t, i) => (
                <div key={i} className="col" style={{ gap: 4, borderTop: '1px solid var(--border)', paddingTop: 6 }}>
                  <div style={{ fontSize: 12 }}><span style={{ color: 'var(--accent)' }}>You → {t.who}:</span> {t.q}</div>
                  {t.entries.map((e, j) => (
                    <div key={j} className="col" style={{ gap: 2 }}>
                      {t.entries.length > 1 && <div className="label" style={{ color: 'var(--muted)' }}>{e.name}</div>}
                      <pre style={{ margin: 0, fontSize: 12, ...WRAP }}>{e.answer}</pre>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'pr' && (
        <div className="col" style={{ gap: 4 }}>
          <div className="row" style={{ gap: 6 }}><button onClick={genPr} disabled={busy === 'pr'}>{busy === 'pr' ? 'Generating…' : 'Regenerate'}</button>{pr && <button onClick={() => navigator.clipboard.writeText(pr)}>Copy</button>}</div>
          {pr && <pre style={{ margin: 0, fontSize: 12, maxHeight: 360, overflow: 'auto', ...WRAP }}>{pr}</pre>}
        </div>
      )}

      {tab === 'replay' && (snaps.length > 0 ? (
        <div className="col" style={{ gap: 6 }}>
          <input type="range" min={0} max={snaps.length - 1} value={snapIdx} onChange={(e) => setSnapIdx(Number(e.target.value))} />
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>{snaps.map((s, i) => <button key={i} onClick={() => setSnapIdx(i)} style={{ opacity: i === snapIdx ? 1 : 0.5, fontSize: 11 }}>{s.label}</button>)}</div>
          <div className="label">After <strong>{snaps[snapIdx]?.label}</strong>:</div>
          <pre style={{ margin: 0, fontSize: 12, maxHeight: 320, overflow: 'auto', ...WRAP }}>{snaps[snapIdx]?.artifact}</pre>
        </div>
      ) : <div className="label">No phase snapshots for this run.</div>)}
    </div>
  );
}

/** Status of the most recent 'finished' event for a run (e.g. 'bounced'). */
function lastFinishedStatus(evs?: { type: string; status?: string }[]): string | undefined {
  if (!evs) return undefined;
  for (let i = evs.length - 1; i >= 0; i--) if (evs[i].type === 'finished') return evs[i].status;
  return undefined;
}

/** Did the run reach a terminal state (finished OR errored)? Post-run tools (ask,
 *  PR, replay) are available for bounced and failed runs too, not just clean ones. */
function isTerminated(evs?: { type: string }[]): boolean {
  return !!evs?.some((e) => e.type === 'finished' || e.type === 'error');
}

/** A bounced final → send it back (group or QA, repeatedly), or accept-as-is and
 *  salvage it into docs + working code + TODOs for the bad parts. */
function BounceRecovery({ runId, onSent }: { runId: string; onSent: () => void }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function send(target: 'group' | 'qa') {
    setBusy(true); setErr('');
    const r = await window.api.council.continueBounced(runId, target, note);
    setBusy(false);
    if (r.ok) onSent(); else setErr(r.error ?? 'failed');
  }
  async function salvage() {
    setBusy(true); setErr('');
    const r = await window.api.council.salvageBounced(runId, note);
    setBusy(false);
    if (r.ok) onSent(); else setErr(r.error ?? 'salvage failed');
  }
  return (
    <div className="card col" style={{ gap: 8, border: '1px solid var(--bad)' }}>
      <strong style={{ color: 'var(--bad)' }}>Bounced — not a dead end. You can send it back as many times as you like:</strong>
      <textarea placeholder="Optional: clarify, add a constraint, or ask them something — injected as a user follow-up for everyone (and as a note to the salvage actor)…" value={note} onChange={(e) => setNote(e.target.value)} rows={2} style={{ fontSize: 12 }} />
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button disabled={busy} onClick={() => send('group')} title="Re-run the debate/gauntlet with your note, then re-synthesize and re-judge">↩ Back to the group</button>
        <button disabled={busy} onClick={() => send('qa')} title="Re-run just the QA / judge gate on the same proposal with your note">↩ Back to QA / judge</button>
        <button disabled={busy} onClick={salvage} style={{ borderColor: 'var(--warn)', color: 'var(--warn)' }} title="Accept the proposal as-is: the editing actor writes a doc commenting extensively on exactly what's good/bad and why, codes up the good parts, and leaves labeled TODOs for the bad parts. Auto-applies if the build stays green.">📝 Accept & document (code good, TODO bad)</button>
      </div>
      {err && <div className="label" style={{ color: 'var(--bad)' }}>{err}</div>}
    </div>
  );
}

/** Prologue: the panel's clarifying questions, paused for the user's answers. */
function ProloguePanel({ runId, questions, onSubmitted }: { runId: string; questions: string[]; onSubmitted: () => void }) {
  const [answers, setAnswers] = useState<string[]>(() => questions.map(() => ''));
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    const r = await window.api.council.answerQuestions(runId, answers);
    setBusy(false);
    if (r.ok) onSubmitted();
  }
  return (
    <div className="card col" style={{ gap: 8, border: '1px solid var(--accent)' }}>
      <strong style={{ color: 'var(--accent)' }}>🧭 Prologue — answer to begin the session</strong>
      {questions.map((q, i) => (
        <div key={i} className="col" style={{ gap: 2 }}>
          <label style={{ fontSize: 12 }}>{i + 1}. {q}</label>
          <textarea value={answers[i] ?? ''} onChange={(e) => setAnswers((a) => { const n = [...a]; n[i] = e.target.value; return n; })} rows={2} style={{ fontSize: 12 }} placeholder="(leave blank to skip)" />
        </div>
      ))}
      <div className="row"><button onClick={submit} disabled={busy} style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>{busy ? 'Starting…' : '▶ Submit answers & run'}</button></div>
    </div>
  );
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
  async function resume(row: any) {
    setBusy(row.runId);
    const r = await window.api.council.resume(row.runId);
    setBusy('');
    if (r.ok && r.runId) onRerun(r.runId);
    else if (r.error) alert(r.error);
  }
  const canResume = (r: any) => r.resumable && r.status !== 'running' && r.status !== 'completed';
  return (
    <div className="card col" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}><strong>Session history</strong><button onClick={refresh}>Refresh</button></div>
      {rows.length === 0 && <div className="label">No council sessions yet for this workspace.</div>}
      {rows.slice(0, 15).map((r) => (
        <div key={r.runId} className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 6, alignItems: 'flex-start', gap: 6 }}>
          <div className="col" style={{ flex: 1, gap: 2, minWidth: 0 }}>
            <div><span className={`badge ${r.approved || r.status === 'completed' || r.status === 'met' ? 'ok' : r.status === 'running' ? 'warn' : 'bad'}`}>{r.status}</span> <strong>{r.protocol}</strong>{String(r.runId).startsWith('loop-') && <span className="label"> · loop</span>}{canResume(r) && <span className="label" title={`checkpointed after phase ${r.phaseIndex}`}> · resumable</span>}</div>
            <div className="label" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.task}>{r.task}</div>
            <div className="label">{new Date(r.started).toLocaleString()}</div>
          </div>
          <div className="col" style={{ gap: 4 }}>
            {canResume(r) && <button disabled={!!busy} onClick={() => resume(r)} title="Continue this session from the phase it stopped at (mid-protocol resume)" style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>{busy === r.runId ? '…' : '▶ Resume'}</button>}
            <button disabled={!!busy || r.status === 'running'} onClick={() => rerun(r)} title="Restart this session from scratch with the same protocol, agents, and task">{busy === r.runId ? '…' : '↻ Re-run'}</button>
          </div>
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
