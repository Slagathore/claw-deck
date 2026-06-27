import React, { useEffect, useState } from 'react';
import WorkspaceTabs from '../components/WorkspaceTabs';
import CouncilSettings from '../components/CouncilSettings';
import DebateTheater from '../components/DebateTheater';
import DiffReview, { type Proposal } from '../components/DiffReview';
import { useWorkspaces } from '../store/workspaces';
import { useCouncil } from '../store/council';

export default function CouncilTab() {
  const { active } = useWorkspaces();
  const { runByWs, events, live, questions, running, startRun, appendEvent, clearQuestions, markRunning, newSession, finishRun } = useCouncil();
  const [roster, setRoster] = useState<{ id: string; displayName: string }[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [theaterTab, setTheaterTab] = useState<'theater' | 'result' | 'bible' | 'ask' | 'pr' | 'replay'>('theater');
  const [isMethodRun, setIsMethodRun] = useState(false);
  const [isCampaignRun, setIsCampaignRun] = useState(false);

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
  // reset to the live theater on a new run, and learn whether it's a method (→ Result tab) / campaign (→ Bible tab)
  useEffect(() => {
    setTheaterTab('theater'); setIsMethodRun(false); setIsCampaignRun(false);
    if (runId) {
      window.api.council.methodResult(runId).then((r) => setIsMethodRun(!!r.isMethod));
      window.api.council.campaignInfo(runId).then((r) => setIsCampaignRun(!!r.isCampaign));
    }
  }, [runId]);

  const terminated = !!runId && !running[runId] && isTerminated(events[runId]);
  const tabs: { id: 'theater' | 'result' | 'bible' | 'ask' | 'pr' | 'replay'; label: string }[] = [{ id: 'theater', label: '🎭 Theater' }];
  if (isCampaignRun) tabs.push({ id: 'bible', label: '🜂 Bible' });   // live-editable while the campaign runs
  if (terminated && isMethodRun) tabs.push({ id: 'result', label: '⚗ Result' });
  if (terminated) tabs.push({ id: 'ask', label: '💬 Ask' }, { id: 'pr', label: '📝 PR' }, { id: 'replay', label: '⏮ Replay' });
  const activeTab = tabs.some((t) => t.id === theaterTab) ? theaterTab : 'theater';

  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <WorkspaceTabs />
        <BridgeBadge workspace={active ?? undefined} />
      </div>
      {!active ? (
        <div className="card" style={{ color: 'var(--muted)' }}>Open a folder to start a multi-agent council session on it.</div>
      ) : (
        <div className="row" style={{ flex: 1, alignItems: 'stretch', minHeight: 0, gap: 10 }}>
          {!expanded && (
            <div className="col" style={{ width: 400, minHeight: 0, overflow: 'auto' }}>
              <CouncilSettings workspace={active} key={active} />
              <FusionMethods repo={active} />
              <ForgeCampaign repo={active} />
              <SessionHistory repo={active} onRerun={(id) => startRun(active, id)} />
              <ManualExecutor repo={active} />
              <RunLedger repo={active} />
            </div>
          )}
          <div className="col" style={{ flex: 1, minHeight: 0 }}>
            <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <div className="row" style={{ gap: 4, flexWrap: 'wrap', flex: 1 }}>
                {tabs.map((t) => (
                  <button key={t.id} onClick={() => setTheaterTab(t.id)}
                    style={{ fontWeight: activeTab === t.id ? 700 : 400, borderColor: activeTab === t.id ? 'var(--accent)' : undefined, color: activeTab === t.id ? 'var(--accent)' : undefined }}>{t.label}</button>
                ))}
              </div>
              {runId && running[runId] && <span style={{ color: 'var(--muted)', fontSize: 12 }}><Spinner /> running…</span>}
              {runId && running[runId] && <button onClick={() => window.api.council.cancel(runId)} style={{ borderColor: 'var(--bad)', color: 'var(--bad)' }}>Cancel</button>}
              <button onClick={() => newSession(active)} title="Clear this view and configure a fresh session (past runs stay in Session history)">＋ New session</button>
              <button onClick={() => setExpanded((x) => !x)} title="Toggle full-width theater">{expanded ? '◧ Show controls' : '⛶ Expand'}</button>
            </div>
            {runId && (questions[runId]?.length ?? 0) > 0 && <ProloguePanel key={runId} runId={runId} questions={questions[runId]} onSubmitted={() => { clearQuestions(runId); markRunning(runId); }} />}
            {runId && !running[runId] && lastFinishedStatus(events[runId]) === 'bounced' && <BounceRecovery runId={runId} onSent={() => markRunning(runId)} />}
            {activeTab === 'theater' && <DebateTheater events={runId ? (events[runId] ?? []) : []} live={runId ? live[runId] : undefined} running={runId ? running[runId] : false} nameOf={nameOf} />}
            {activeTab === 'result' && runId && <MethodResultPanel runId={runId} repo={active} />}
            {activeTab === 'bible' && runId && <CampaignBible runId={runId} repo={active} running={!!running[runId]} />}
            {(activeTab === 'ask' || activeTab === 'pr' || activeTab === 'replay') && runId && <PostRunView runId={runId} roster={roster} view={activeTab} />}
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

/** claw-bridge status (Phase 6): connects to the VS Code window whose folders match the
 *  active workspace — so it shows THIS project's diagnostics, not another window's. */
function BridgeBadge({ workspace }: { workspace?: string }) {
  const [connected, setConnected] = useState(false);
  const [matched, setMatched] = useState(false);
  const [lm, setLm] = useState(0);
  const [diag, setDiag] = useState(0);
  const [folders, setFolders] = useState(0);
  useEffect(() => {
    let on = true;
    const tick = async () => {
      const st = await window.api.bridge.status(workspace);
      if (!on) return;
      setConnected(st.connected); setMatched(!!st.matched); setFolders(st.folders?.length ?? 0);
      if (st.connected) { const m = await window.api.bridge.lmModels(workspace); const d = st.matched ? await window.api.bridge.diagnostics(workspace) : []; if (on) { setLm(m.length); setDiag(d.length); } }
    };
    tick(); const t = setInterval(tick, 5000);
    return () => { on = false; clearInterval(t); };
  }, [workspace]);
  if (!connected) return <span className="badge" style={{ color: 'var(--muted)' }} title="Open this project in VS Code with the claw-bridge extension for live diagnostics + vscode.lm models. (Optional — the council also reads the filesystem, git, and Atlas.)">bridge offline</span>;
  if (!matched) return <span className="badge warn" title="A VS Code window with claw-bridge is running, but it's open to a DIFFERENT project — open THIS workspace in VS Code to surface its diagnostics.">VS Code bridge · other project</span>;
  return <span className="badge ok" title={`${folders} folder(s) · this project`}>VS Code bridge · {lm} lm · {diag} problems</span>;
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
  const [groundInRepo, setGroundInRepo] = useState(false);
  const [showElig, setShowElig] = useState(false);
  const [elig, setElig] = useState<{ id: string; displayName: string; key: string; eligible: string[]; notEligible: string[]; maxCalls?: number; optional: boolean }[]>([]);
  useEffect(() => { window.api.council.methods().then((r) => { if (r.ok) setMethods(r.methods); }); }, []);
  useEffect(() => { if (showElig && !elig.length) window.api.council.roleEligibility().then((r) => { if (r.ok) setElig(r.rows); }); }, [showElig, elig.length]);
  const sel = methods.find((m) => m.id === methodId);
  const needsFocus = methodId === 'assay' || methodId === 'prospect';   // these already ingest the repo
  async function run() {
    if (!task.trim()) { setErr('describe the task first'); return; }
    setBusy(true); setErr('');
    const r = await window.api.council.runMethod({ repo, methodId, task, focus: focus.trim() || undefined, groundInRepo });
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
      {needsFocus
        ? <div className="label">✓ ingests the repo automatically (Atlas + reads the key files)</div>
        : <label className="label" title="Prepend an ingest phase: query the Atlas + read the top files so the panel frames/diverges from the REAL code, not just your description. Needs the workspace indexed (Project Brain → Index).">
            <input type="checkbox" checked={groundInRepo} disabled={busy} onChange={(e) => setGroundInRepo(e.target.checked)} /> 🔎 Ground in repo first
          </label>}
      {needsFocus && <input placeholder='optional focus: e.g. "auth flow, version detection"' value={focus} onChange={(e) => setFocus(e.target.value)} style={{ fontSize: 12 }} />}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <span className="label" title="shown to you when the run finishes">Ends: {sel?.endPrompt}</span>
        <button onClick={run} disabled={busy} style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>{busy ? 'Starting…' : '▶ Run method'}</button>
      </div>
      {err && <div className="label" style={{ color: 'var(--bad)' }}>{err}</div>}
      <div className="row" style={{ cursor: 'pointer', justifyContent: 'space-between' }} onClick={() => setShowElig((x) => !x)} title="Methods auto-assign advisors from your roster by strength using this table. It does NOT affect the manual Session config above.">
        <span className="label">🧬 Role eligibility (who methods auto-assign to)</span><span className="label">{showElig ? '▾' : '▸'}</span>
      </div>
      {showElig && (
        <div className="col" style={{ gap: 4, paddingLeft: 6 }}>
          {elig.map((r) => (
            <div key={r.id} style={{ fontSize: 11, ...WRAP }}>
              <strong>{r.displayName}</strong> <span style={{ color: 'var(--muted)' }}>({r.key}{r.maxCalls ? `, ≤${r.maxCalls} calls` : ''}{r.optional ? ', optional' : ''})</span>: {r.eligible.join(', ') || '—'}
              {r.notEligible.length ? <span style={{ color: 'var(--bad)' }}> · never: {r.notEligible.join(', ')}</span> : null}
            </div>
          ))}
          <div className="label">Existing Session protocols (Council/Crucible/…) ignore this — they use your manual assignment.</div>
        </div>
      )}
    </div>
  );
}

/** FORGE — loop-only campaign launcher. Authors the GDD bible once, then loops the
 *  crucible cycle over the backlog until done. Design-only mode resolves the bible
 *  (writes no code). Consolidator defaults to Kimi; builder defaults to an edit-capable agent. */
function ForgeCampaign({ repo }: { repo: string }) {
  const { startRun } = useCouncil();
  const [roster, setRoster] = useState<{ id: string; displayName: string; model?: string; transport?: string; capabilities?: { canEdit?: boolean } }[]>([]);
  const [concept, setConcept] = useState('');
  const [design, setDesign] = useState(false);
  const [maxIterations, setMaxIterations] = useState(12);
  const [batchSize, setBatchSize] = useState(2);
  const [lean, setLean] = useState(false);
  const [consolidatorId, setConsolidatorId] = useState('');
  const [builderId, setBuilderId] = useState('');
  const [skip, setSkip] = useState<Record<string, boolean>>({});   // providers to skip (e.g. claude out of tokens)
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeMsg, setProbeMsg] = useState('');

  useEffect(() => {
    window.api.settings.get().then((s: any) => {
      const r: typeof roster = s.fusionRoster ?? [];
      setRoster(r);
      const kimi = r.find((a) => /kimi/i.test(`${a.model ?? ''} ${a.id}`));   // default consolidator = Kimi
      if (kimi) setConsolidatorId(kimi.id);
      const ed = r.find((a) => a.capabilities?.canEdit);                       // default builder = first edit-capable
      if (ed) setBuilderId(ed.id);
    });
  }, []);

  const editors = roster.filter((a) => a.capabilities?.canEdit);
  // map an agent to the engine's provider key so a "skip" toggle disables the right one
  const provKey = (a: { id: string; model?: string; transport?: string }) => {
    const h = `${a.model ?? ''} ${a.id}`.toLowerCase();
    if (a.transport === 'claude-code' || /\bclaude\b/.test(h)) return 'claude';
    if (a.transport === 'codex' || /\bcodex\b/.test(h)) return 'codex';
    return '';
  };
  const presentProviders = Array.from(new Set(roster.map(provKey).filter(Boolean)));
  async function run() {
    if (!concept.trim()) { setErr('describe the game concept first'); return; }
    if (!design && !editors.length) { setErr('build mode needs an edit-capable agent (Claude/Codex/OpenClaw, or a cloud model with "edits" on)'); return; }
    const disableProviders = Object.entries(skip).filter(([, v]) => v).map(([k]) => k);
    setBusy(true); setErr('');
    const r = await window.api.council.startCampaign({ repo, concept, design, maxIterations, batchSize, lean, consolidatorId: consolidatorId || undefined, builderId: builderId || undefined, disableProviders });
    setBusy(false);
    if (r.ok && r.runId) startRun(repo, r.runId); else setErr(r.error ?? 'failed to start');
  }
  async function probe() {
    setProbing(true); setProbeMsg('Probing roster capabilities — can take a minute…');
    const r = await window.api.council.probeCapabilities();
    setProbing(false);
    if (!r.ok || !r.probed) { setProbeMsg(`probe failed: ${r.error ?? 'unknown'}`); return; }
    const models = Object.keys(r.probed);
    const passes = (m: string) => Object.values(r.probed![m]).filter((v) => v === 'pass').length;
    const total = Object.values(r.probed[models[0]] ?? {}).length;
    setProbeMsg(`probed ${models.length} model(s): ${models.map((m) => `${m.split(':')[0]} ${passes(m)}/${total}✓`).join(' · ')} — builds now route to the strongest emitters`);
  }
  return (
    <div className="card col" style={{ gap: 6 }}>
      <div className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setOpen((x) => !x)}>
        <strong>🜂 Forge campaign <span className="label">(loop)</span></strong><span className="label">{open ? '▾' : '▸'}</span>
      </div>
      {open && <>
        <div className="label" style={{ ...WRAP }}>Authors a Game Design Doc (the bible) once, then loops: pick the next dependency-ready batch → crucible cycle → build &amp; validate → mark done → repeat until the backlog is done. Writes <code>.fusion/campaign/GDD.md</code>; re-running continues it.</div>
        <label className="label"><input type="checkbox" checked={design} disabled={busy} onChange={(e) => setDesign(e.target.checked)} /> Design only — resolve the bible, write no code</label>
        <textarea placeholder="Describe the game from nothing: genre, core loop, platform/engine, controls, win/lose, vibe…" value={concept} onChange={(e) => setConcept(e.target.value)} rows={4} style={{ fontSize: 12 }} />
        <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <label style={{ fontSize: 12 }}>max iters <input type="number" min={1} max={50} value={maxIterations} disabled={busy} onChange={(e) => setMaxIterations(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} style={{ width: 56 }} /></label>
          <label style={{ fontSize: 12 }}>batch <input type="number" min={1} max={5} value={batchSize} disabled={busy} onChange={(e) => setBatchSize(Math.max(1, Math.min(5, Number(e.target.value) || 1)))} style={{ width: 48 }} /></label>
          <label style={{ fontSize: 12 }} title="Consolidate once per iteration instead of after every steelman⇄adversarial cycle"><input type="checkbox" checked={lean} disabled={busy} onChange={(e) => setLean(e.target.checked)} /> lean</label>
        </div>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          <label style={{ fontSize: 12 }}>Consolidator <select value={consolidatorId} disabled={busy} onChange={(e) => setConsolidatorId(e.target.value)}><option value="">(auto)</option>{roster.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}</select></label>
          {!design && <label style={{ fontSize: 12 }}>Builder <select value={builderId} disabled={busy} onChange={(e) => setBuilderId(e.target.value)}>{editors.length ? editors.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>) : <option value="">(none can edit)</option>}</select></label>}
        </div>
        {presentProviders.length > 0 && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center' }} title="Skip a provider this run — e.g. when Claude is out of tokens. The run routes around it (framer/consolidator/judge fall back) instead of feeding its error text into the build.">
            <span className="label">Skip provider:</span>
            {presentProviders.map((p) => (
              <label key={p} style={{ fontSize: 12 }}><input type="checkbox" disabled={busy} checked={!!skip[p]} onChange={(e) => setSkip((s) => ({ ...s, [p]: e.target.checked }))} /> {p}</label>
            ))}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
          <button onClick={probe} disabled={probing || busy} title="Ask each roster model to actually produce SVG / GDScript / chiptune / SFX and record what it can do, so builds route to capable agents. Same logic as the standalone capability-probe tool.">{probing ? 'Probing…' : '🧪 Probe capabilities'}</button>
          <button onClick={run} disabled={busy} style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>{busy ? 'Starting…' : '🜂 Start campaign'}</button>
        </div>
        {probeMsg && <div className="label" style={{ ...WRAP }}>{probeMsg}</div>}
        {err && <div className="label" style={{ color: 'var(--bad)' }}>{err}</div>}
        <div className="label" style={{ ...WRAP }}>Index the workspace (Project Brain → Index) so iterations ground in the accumulating code. Gate blockers are logged to <code>gates.md</code> and the loop keeps going (autonomous).</div>
      </>}
    </div>
  );
}

/** FORGE — the live bible. Edit GDD.md in place while the campaign runs; the orchestrator
 *  owns status flips and force-saves-then-pulls our buffer before each worker rotation, so
 *  edits are picked up. Autosaves (debounced), flushes on unmount, and reflects on-disk
 *  progress while the user isn't mid-edit. */
function CampaignBible({ runId, repo, running }: { runId: string; repo: string; running: boolean }) {
  type Stats = { total: number; done: number; blocked: number; todo: number; question: number; ready: number };
  const [content, setContent] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [info, setInfo] = useState<{ loop?: string; iterations?: number } | null>(null);
  const contentRef = React.useRef('');
  const dirtyRef = React.useRef(false);
  const saveTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const setBuf = (v: string) => { contentRef.current = v; setContent(v); };
  const save = React.useCallback(async () => {
    setSaving(true);
    const r = await window.api.council.campaignWriteGdd(repo, contentRef.current);
    setSaving(false); dirtyRef.current = false; setDirty(false);
    if (r.ok && r.stats) setStats(r.stats);
  }, [repo]);
  const loadFromDisk = React.useCallback(async () => {
    const r = await window.api.council.campaignReadGdd(repo);
    if (r.ok) { setBuf(r.content); setStats(r.stats); dirtyRef.current = false; setDirty(false); }
  }, [repo]);

  useEffect(() => {
    window.api.council.campaignBibleActive(runId, true);
    loadFromDisk();
    window.api.council.campaignInfo(runId).then((r) => setInfo(r.result ?? null));
    return () => {
      if (dirtyRef.current) window.api.council.campaignWriteGdd(repo, contentRef.current);   // flush on unmount
      window.api.council.campaignBibleActive(runId, false);
    };
  }, [runId, repo, loadFromDisk]);

  // honor the worker's force-save request: save the in-progress buffer, then ack so it pulls
  useEffect(() => {
    const off = window.api.council.onEvent(async (e: { runId?: string; type?: string }) => {
      if (e.runId !== runId || e.type !== 'gdd-flush') return;
      if (dirtyRef.current) await window.api.council.campaignWriteGdd(repo, contentRef.current);
      await window.api.council.campaignFlushAck(runId);
    });
    return off;
  }, [runId, repo]);

  // while running, reflect the orchestrator's on-disk status flips (only when not mid-edit)
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => { if (!dirtyRef.current) loadFromDisk(); }, 4000);
    return () => clearInterval(t);
  }, [running, loadFromDisk]);

  const onChange = (v: string) => {
    setBuf(v); dirtyRef.current = true; setDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { void save(); }, 800);
  };
  const pct = stats && stats.total ? Math.round((stats.done / stats.total) * 100) : 0;

  return (
    <div className="card col" style={{ gap: 6, flex: 1, minHeight: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 6 }}>
        <strong>🜂 Bible — GDD.md</strong>
        {stats && <span className="label">{stats.done}/{stats.total} done · {stats.ready} ready · {stats.blocked} blocked{stats.question ? ` · ${stats.question} open Q` : ''} · {pct}%</span>}
      </div>
      {info?.loop && <div className="label">Campaign: {info.loop}{info.iterations != null ? ` · ${info.iterations} iteration(s)` : ''}</div>}
      <textarea value={content} onChange={(e) => onChange(e.target.value)} spellCheck={false}
        style={{ flex: 1, minHeight: 200, fontFamily: 'var(--mono, monospace)', fontSize: 12, resize: 'none', whiteSpace: 'pre', overflow: 'auto' }} />
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        <span className="label">{dirty ? (saving ? 'saving…' : 'unsaved — autosaves; workers pull the latest each rotation') : 'saved'}{running ? ' · live' : ''}</span>
        <div className="row" style={{ gap: 6 }}>
          <button onClick={loadFromDisk} title="Discard local edits and reload the on-disk bible (with the orchestrator's latest status flips)">Reload</button>
          <button onClick={save} disabled={saving} style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>Save now</button>
        </div>
      </div>
      <div className="label" style={{ ...WRAP }}>Edit freely. The <code>## Backlog</code> grammar (<code>[ ]</code> todo · <code>[x]</code> done · <code>[~]</code> blocked · <code>[?]</code> question) drives the loop. The orchestrator owns status flips; your prose/acceptance edits are picked up at the next worker rotation.</div>
    </div>
  );
}

/** §5 — a finished method run: its report + scores + the end-prompt, with a chain-to-Foundry
 *  button that pre-seeds Foundry's P0 from this run (no re-ingest). */
function MethodResultPanel({ runId, repo }: { runId: string; repo: string }) {
  const { startRun } = useCouncil();
  const [data, setData] = useState<{ isMethod: boolean; methodId?: string; result?: { report?: string; scores?: { agentId: string; verdict: string }[]; endPrompt?: string; confidence?: 'high' | 'low'; humanDecision?: string[]; seed?: { task: string; focus?: string; contract: string; artifacts: string[] } } | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { window.api.council.methodResult(runId).then((r) => setData(r.ok ? r : null)); }, [runId]);
  if (!data?.isMethod) return null;
  const res = data.result ?? {};
  const canChain = ['assay', 'prospect', 'foundry-design'].includes(data.methodId ?? '');
  async function chain() {
    setBusy(true);
    const r = await window.api.council.runMethod({ repo, methodId: 'foundry', task: `Build from the ${data!.methodId} result (seed attached).`, seed: res.seed });
    setBusy(false);
    if (r.ok && r.runId) startRun(repo, r.runId);
  }
  return (
    <div className="card col" style={{ gap: 6, flex: 1, minHeight: 0 }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}><strong>⚗ Method result — {data.methodId}</strong>{res.scores?.length ? <span className="label">{res.scores.map((s) => s.verdict).join(' · ')}{res.confidence ? ` · ${res.confidence} confidence` : ''}</span> : null}</div>
      {!!res.humanDecision?.length && (
        <div className="banner warn" style={{ ...WRAP }}>
          <strong>⚠ Human decision required ({res.humanDecision.length})</strong> — invariant blocker(s) survived auto-repair; the judges scored it anyway. Resolve before shipping:
          <pre style={{ margin: '4px 0 0', fontSize: 11, ...WRAP }}>{res.humanDecision.join('\n')}</pre>
        </div>
      )}
      {res.report && <pre style={{ margin: 0, fontSize: 12, flex: 1, minHeight: 0, overflow: 'auto', ...WRAP }}>{res.report}</pre>}
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
        <span className="label">{res.endPrompt}</span>
        <div className="row" style={{ gap: 6 }}>
          {res.report && <button onClick={() => navigator.clipboard.writeText(res.report ?? '')}>Copy report</button>}
          {canChain && <button onClick={chain} disabled={busy} style={{ borderColor: 'var(--good)', color: 'var(--good)' }}>{busy ? 'Starting…' : '→ Foundry (seeded)'}</button>}
        </div>
      </div>
    </div>
  );
}

/** Post-run views (full-height, tab-driven): ask an agent/room, generate a PR
 *  description, or replay the proposal's evolution. The `view` prop comes from the
 *  theater tab bar so each is read full-width instead of squeezed beside the theater. */
function PostRunView({ runId, roster, view }: { runId: string; roster: { id: string; displayName: string }[]; view: 'ask' | 'pr' | 'replay' }) {
  const [agentId, setAgentId] = useState(roster[0]?.id ?? '');
  const [target, setTarget] = useState<'agent' | 'room'>('agent');
  const [q, setQ] = useState('');
  const [thread, setThread] = useState<{ q: string; who: string; entries: { name: string; answer: string }[] }[]>([]);
  const [pr, setPr] = useState('');
  const [snaps, setSnaps] = useState<{ phaseIndex: number; label: string; artifact: string }[]>([]);
  const [snapIdx, setSnapIdx] = useState(0);
  const [loaded, setLoaded] = useState({ pr: false, replay: false });
  const [busy, setBusy] = useState('');

  const nameOf = (id: string) => roster.find((a) => a.id === id)?.displayName ?? id;
  useEffect(() => { if (!agentId && roster[0]) setAgentId(roster[0].id); }, [roster, agentId]);
  const genPr = React.useCallback(async () => { setBusy('pr'); setLoaded((l) => ({ ...l, pr: true })); const r = await window.api.council.prDescription(runId); setBusy(''); setPr(r.ok ? (r.markdown ?? '') : `error: ${r.error}`); }, [runId]);
  const loadReplay = React.useCallback(async () => { setBusy('replay'); setLoaded((l) => ({ ...l, replay: true })); const r = await window.api.council.snapshots(runId); setBusy(''); setSnaps(r.snapshots ?? []); setSnapIdx(Math.max(0, (r.snapshots?.length ?? 1) - 1)); }, [runId]);
  // lazy-load the active view's data the first time it's opened
  useEffect(() => { if (view === 'pr' && !loaded.pr) genPr(); if (view === 'replay' && !loaded.replay) loadReplay(); }, [view, loaded.pr, loaded.replay, genPr, loadReplay]);

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

  return (
    <div className="card col" style={{ gap: 8, flex: 1, minHeight: 0 }}>
      {view === 'ask' && (<>
        <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
          <select value={target} onChange={(e) => setTarget(e.target.value as any)}>
            <option value="agent">one agent</option>
            <option value="room">the whole room</option>
          </select>
          {target === 'agent' && <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>{roster.map((a) => <option key={a.id} value={a.id}>{a.displayName}</option>)}</select>}
          <input style={{ flex: 1, minWidth: 160 }} placeholder={target === 'room' ? 'Ask everyone who spoke…' : 'Ask this agent about its statement…'} value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && ask()} />
          <button onClick={ask} disabled={busy === 'ask'}>{busy === 'ask' ? '…' : 'Ask'}</button>
        </div>
        <div className="col" style={{ gap: 8, flex: 1, minHeight: 0, overflow: 'auto' }}>
          {thread.length === 0 && <div className="label">Ask an agent — or the whole room — about anything from this session.</div>}
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
      </>)}

      {view === 'pr' && (<>
        <div className="row" style={{ gap: 6 }}><button onClick={genPr} disabled={busy === 'pr'}>{busy === 'pr' ? 'Generating…' : 'Regenerate'}</button>{pr && <button onClick={() => navigator.clipboard.writeText(pr)}>Copy</button>}</div>
        <pre style={{ margin: 0, fontSize: 12, flex: 1, minHeight: 0, overflow: 'auto', ...WRAP }}>{busy === 'pr' ? 'Generating PR description…' : pr || '(no PR description)'}</pre>
      </>)}

      {view === 'replay' && (snaps.length > 0 ? (<>
        <input type="range" min={0} max={snaps.length - 1} value={snapIdx} onChange={(e) => setSnapIdx(Number(e.target.value))} />
        <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>{snaps.map((s, i) => <button key={i} onClick={() => setSnapIdx(i)} style={{ opacity: i === snapIdx ? 1 : 0.5, fontSize: 11 }}>{s.label}</button>)}</div>
        <div className="label">After <strong>{snaps[snapIdx]?.label}</strong>:</div>
        <pre style={{ margin: 0, fontSize: 12, flex: 1, minHeight: 0, overflow: 'auto', ...WRAP }}>{snaps[snapIdx]?.artifact}</pre>
      </>) : <div className="label">{busy === 'replay' ? 'Loading…' : 'No phase snapshots for this run.'}</div>)}
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
  const { loadRun } = useCouncil();
  const [rows, setRows] = useState<any[]>([]);
  const [busy, setBusy] = useState('');
  async function refresh() { const r = await window.api.council.list(); if (r.ok) setRows(r.runs.filter((x: any) => x.repo === repo)); }
  useEffect(() => { refresh(); const t = setInterval(refresh, 5000); return () => clearInterval(t); }, [repo]);
  async function view(row: any) {
    setBusy(row.runId);
    const r = await window.api.council.events(row.runId);
    setBusy('');
    loadRun(repo, row.runId, r.ok ? (r.events ?? []) : []);
  }
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
            {!!r.hasEvents && <button disabled={!!busy} onClick={() => view(r)} title="Open this past session in the debate theater (full transcript replay)">{busy === r.runId ? '…' : '👁 View'}</button>}
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
