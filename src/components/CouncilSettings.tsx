import React, { useEffect, useState } from 'react';
import { useCouncil, Assignment, SessionConfig } from '../store/council';

interface RosterAgent { id: string; displayName: string; transport: string; model?: string; binary?: string; capabilities: { canEdit: boolean; canRunTools: boolean; costTier: string } }
const PROTOCOLS = ['COUNCIL', 'CRUCIBLE', 'GAUNTLET', 'DEVIL', 'STEELMAN', 'TOURNAMENT', 'REDTEAM', 'PCRSR', 'GCRJ', 'PAIR', 'SOLO'];

/** What each session protocol does, how it works, and what it's best at (hover tooltips + inline). */
const PROTOCOL_INFO: Record<string, { name: string; how: string; best: string }> = {
  COUNCIL: {
    name: 'Full Council',
    how: 'Independent takes from every panelist → debate to consensus (≤3 rounds, stops early on convergence) → scribe synthesizes one proposal → QA gate → QA⇄judge relay → judge gate → execute.',
    best: 'Hard or ambiguous changes where you want maximum scrutiny and diverse perspectives before any code is touched. Most thorough — and most expensive.',
  },
  CRUCIBLE: {
    name: 'Crucible (steelman ⇄ red-team ×3)',
    how: 'Generate → 3 rounds that each STEELMAN (strengthen the proposal) then RED-TEAM (attack it for new flaws) → scribe synthesizes → one more steelman to harden → QA gate → BLIND judge → build. The full forge.',
    best: 'High-stakes work where you want the proposal repeatedly strengthened AND attacked before building. The most rigorous mode — and the most expensive.',
  },
  GAUNTLET: {
    name: 'Adversarial Gauntlet',
    how: 'Generate → adversarial gauntlet: agents take turns, each REQUIRED to find a NEW flaw the others missed (or say NO_FURTHER_ISSUES) → scribe hardens → BLIND judge (sees only task + patch, never the consensus, asked “what is STILL wrong?”) → execute.',
    best: 'When you don’t trust agreement. Agents are incentivized to break the proposal, not rubber-stamp it. Best for correctness-critical work and catching deprecated/removed-API and edge-case misses.',
  },
  REDTEAM: {
    name: 'Red Team (adversarial audit)',
    how: 'Same adversarial gauntlet + blind judge as Gauntlet, but stops at sign-off — it audits, it does NOT edit your tree.',
    best: 'Reviewing an existing proposal/design for flaws without applying any changes. A pure attack pass.',
  },
  PCRSR: {
    name: 'Propose · Critique · Revise · Synthesize · Ratify',
    how: 'Panelists propose → one critique round → one revise round → scribe synthesizes → judge ratifies (approve, or bounce with notes).',
    best: 'Well-scoped features where you want a structured improve-then-ratify cycle without a full open debate. Balanced cost.',
  },
  GCRJ: {
    name: 'Generate · Cross-critique · Rebuttal · Judge',
    how: 'Panelists generate independently → cross-critique each other → one rebuttal round → judge decides.',
    best: '“Which approach?” design decisions, where adversarial cross-examination between models surfaces flaws fastest.',
  },
  PAIR: {
    name: 'Pair (quick fix)',
    how: 'Skips the swarm entirely: a QA⇄judge relay (≤4 turns) → execute. Just two actors, no panel.',
    best: 'Small, well-understood fixes where a full council is overkill. Fastest two-actor option.',
  },
  SOLO: {
    name: 'Solo (judge only)',
    how: 'One actor, no panel: the judge proposes a fix and executes it directly.',
    best: 'Trivial/mechanical changes where you just want one capable agent to do it. Cheapest and fastest.',
  },
  DEVIL: {
    name: "Devil's Advocate",
    how: 'Panel proposes → ONE fixed adversary (your QA agent) hammers it across turns until it finds nothing new → harden → blind judge → execute.',
    best: 'When you want a single dedicated skeptic relentlessly attacking the panel’s consensus, rather than a diffuse group.',
  },
  STEELMAN: {
    name: 'Steelman (strengthen-then-attack)',
    how: 'Each round agents first STRENGTHEN the proposal (add what’s missing, fix weak spots, add genuinely useful functions) THEN flag remaining flaws → synthesize → blind judge → execute.',
    best: 'Turning a rough idea into something solid — constructive and critical, not just teardown. Pairs well with “run hot”.',
  },
  TOURNAMENT: {
    name: 'Tournament (pick-best)',
    how: 'Panelists each propose independently; the judge PICKS the single strongest candidate (no merging or averaging) → execute.',
    best: 'Generating diverse options and choosing one clear winner. Great with “run hot” for divergent first drafts.',
  },
};
const protocolTitle = (p: string) => `${PROTOCOL_INFO[p]?.name}\n\nHow: ${PROTOCOL_INFO[p]?.how}\n\nBest for: ${PROTOCOL_INFO[p]?.best}`;

function defaultConfig(roster: RosterAgent[]): SessionConfig {
  const panel = roster.filter((a) => a.transport.startsWith('ollama')).map((a) => a.id).slice(0, 3);
  const judge = roster.find((a) => a.transport === 'claude-code')?.id ?? roster[0]?.id ?? '';
  const qa = roster.find((a) => a.transport === 'codex')?.id ?? roster.find((a) => a.capabilities.canEdit)?.id ?? judge;
  return { protocolId: 'COUNCIL', assignment: { panelists: panel.length ? panel : roster.slice(0, 2).map((a) => a.id), judge, qaGate: qa }, task: '' };
}

/** Per-tab session config — dropdowns populated from the global roster (§4.5). */
export default function CouncilSettings({ workspace }: { workspace: string }) {
  const { configs, setConfig, startRun, runByWs, running } = useCouncil();
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [loopGoal, setLoopGoal] = useState('');
  const [loopMax, setLoopMax] = useState(5);
  const [loopMethod, setLoopMethod] = useState('');
  const [methodList, setMethodList] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => { window.api.council.methods().then((r) => { if (r.ok) setMethodList(r.methods.map((m) => ({ id: m.id, name: m.name }))); }); }, []);
  const [probe, setProbe] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [dryRun, setDryRun] = useState(false);
  const [context, setContext] = useState('');
  const [hot, setHot] = useState(false);
  const [hotAgents, setHotAgents] = useState<string[]>([]);
  const [hotTemp, setHotTemp] = useState(1.15);
  const [prologue, setPrologue] = useState(false);
  const [forceBlind, setForceBlind] = useState(false);
  const [groundInRepo, setGroundInRepo] = useState(false);
  const [personaDefs, setPersonaDefs] = useState<{ id: string; name: string; prompt: string }[]>([]);
  const [personas, setPersonas] = useState<Record<string, string>>({});
  const [showPersonas, setShowPersonas] = useState(false);

  useEffect(() => { window.api.settings.get().then((s) => { setRoster(s.fusionRoster ?? []); setPersonaDefs(s.fusionPersonas ?? []); const saved = s.councilEnvByWorkspace?.[workspace]; if (saved) setContext(saved); }); }, [workspace]);
  useEffect(() => { if (roster.length && !configs[workspace]) setConfig(workspace, defaultConfig(roster)); }, [roster, workspace, configs, setConfig]);

  const cfg = configs[workspace] ?? defaultConfig(roster);
  const activeRun = runByWs[workspace];
  const locked = !!activeRun && running[activeRun];
  const update = (patch: Partial<SessionConfig>) => setConfig(workspace, { ...cfg, ...patch });
  const updateAssign = (patch: Partial<Assignment>) => update({ assignment: { ...cfg.assignment, ...patch } });
  const togglePanelist = (id: string) => updateAssign({ panelists: cfg.assignment.panelists.includes(id) ? cfg.assignment.panelists.filter((x) => x !== id) : [...cfg.assignment.panelists, id] });

  const assignedIds = [...new Set([...cfg.assignment.panelists, cfg.assignment.judge, cfg.assignment.qaGate, cfg.assignment.scribe].filter(Boolean) as string[])];
  const hotConfig = hot && hotAgents.length ? { agents: hotAgents.filter((id) => assignedIds.includes(id)), temperature: hotTemp } : undefined;
  const toggleHot = (id: string) => setHotAgents((h) => h.includes(id) ? h.filter((x) => x !== id) : [...h, id]);
  async function saveEnv() {
    const s = await window.api.settings.get();
    window.api.settings.set({ councilEnvByWorkspace: { ...(s.councilEnvByWorkspace ?? {}), [workspace]: context } });
  }
  const nameOf = (id: string) => roster.find((a) => a.id === id)?.displayName ?? id;

  async function start() {
    const ready = await preflight();
    if (!ready) return;
    setErr(''); setBusy('Starting…');
    const r = await window.api.council.start({ repo: dryRun ? undefined : workspace, protocolId: cfg.protocolId, assignment: cfg.assignment, task: cfg.task, context, hot: hotConfig, prologue, personas, forceBlind, groundInRepo });
    setBusy('');
    if (!r.ok || !r.runId) { setErr(r.error ?? 'failed to start'); return; }
    startRun(workspace, r.runId);
  }

  async function detectEnv() {
    setBusy('Detecting…');
    const r = await window.api.council.detectEnv(workspace);
    setBusy('');
    if (r.ok) setContext((c) => (c.trim() ? c : r.facts));
  }

  async function preflight(): Promise<boolean> {
    const ids = [...new Set([...cfg.assignment.panelists, cfg.assignment.judge, cfg.assignment.qaGate, cfg.assignment.scribe].filter(Boolean) as string[])];
    const next: Record<string, { ok: boolean; detail: string }> = {};
    setBusy('Checking agents…'); setErr('');
    for (const id of ids) {
      const agent = roster.find(a => a.id === id);
      if (!agent) { next[id] = { ok: false, detail: 'not found in roster' }; continue; }
      next[id] = await window.api.council.probeAgent(agent as any, workspace);
    }
    setProbe(next);
    setBusy('');
    const bad = Object.entries(next).filter(([, r]) => !r.ok);
    if (bad.length) setErr(`Not ready: ${bad.map(([id, r]) => `${id} (${r.detail})`).join('; ')}`);
    return bad.length === 0;
  }

  async function startLoop() {
    setErr(''); setBusy('Starting loop…');
    const r = await window.api.council.startLoop({ repo: workspace, protocolId: cfg.protocolId, assignment: cfg.assignment, goal: loopGoal, maxIterations: loopMax, context, hot: hotConfig, personas, forceBlind, groundInRepo, methodId: loopMethod || undefined });
    setBusy('');
    if (!r.ok || !r.runId) { setErr(r.error ?? 'failed to start loop'); return; }
    startRun(workspace, r.runId);
  }

  const opt = (a: RosterAgent) => <option key={a.id} value={a.id}>{a.displayName}</option>;
  const probed = Object.entries(probe);

  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong title="Hover a protocol for what it does; the selected one is described below.">Session config</strong>
        <select value={cfg.protocolId} disabled={locked} title={protocolTitle(cfg.protocolId)} onChange={(e) => update({ protocolId: e.target.value })}>
          {PROTOCOLS.map((p) => <option key={p} value={p} title={protocolTitle(p)}>{p}</option>)}
        </select>
      </div>
      <div className="label" style={{ fontSize: 11 }} title={protocolTitle(cfg.protocolId)}>
        <strong style={{ color: 'var(--accent)' }}>{PROTOCOL_INFO[cfg.protocolId]?.name}</strong> — {PROTOCOL_INFO[cfg.protocolId]?.how}
        <br /><span style={{ color: 'var(--muted)' }}>Best for: {PROTOCOL_INFO[cfg.protocolId]?.best}</span>
      </div>

      <div className="col" style={{ gap: 4 }}>
        <label style={{ fontSize: 11, color: 'var(--muted)' }}>Panelists (multi-select)</label>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {roster.map((a) => (
            <label key={a.id} style={{ fontSize: 12 }}>
              <input type="checkbox" disabled={locked} checked={cfg.assignment.panelists.includes(a.id)} onChange={() => togglePanelist(a.id)} /> {a.displayName}
              {probe[a.id] && <span className={`badge ${probe[a.id].ok ? 'ok' : 'bad'}`} title={probe[a.id].detail}>{probe[a.id].ok ? 'ready' : 'bad'}</span>}
            </label>
          ))}
        </div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <label style={{ fontSize: 12 }}>Judge <select disabled={locked} value={cfg.assignment.judge} onChange={(e) => updateAssign({ judge: e.target.value })}>{roster.map(opt)}</select></label>
        <label style={{ fontSize: 12 }}>QA gate <select disabled={locked} value={cfg.assignment.qaGate} onChange={(e) => updateAssign({ qaGate: e.target.value })}>{roster.map(opt)}</select></label>
        <label style={{ fontSize: 12 }}>Scribe <select disabled={locked} value={cfg.assignment.scribe ?? ''} onChange={(e) => updateAssign({ scribe: e.target.value || undefined })}><option value="">(judge)</option>{roster.map(opt)}</select></label>
      </div>

      <div className="col" style={{ gap: 4 }}>
        <div className="row" style={{ cursor: 'pointer', justifyContent: 'space-between' }} onClick={() => setShowPersonas((x) => !x)} title="Give each agent a stance (system-prompt flavor) so the panel argues from genuinely different angles.">
          <label style={{ fontSize: 11, color: 'var(--muted)', cursor: 'pointer' }}>🎭 Personalities{Object.values(personas).filter(Boolean).length ? ` (${Object.values(personas).filter(Boolean).length})` : ''}</label>
          <span style={{ color: 'var(--muted)' }}>{showPersonas ? '▾' : '▸'}</span>
        </div>
        {showPersonas && (
          <div className="col" style={{ gap: 4, paddingLeft: 6 }}>
            {assignedIds.map((id) => (
              <div key={id} className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
                <span style={{ fontSize: 12 }}>{nameOf(id)}</span>
                <select value={personas[id] ?? ''} disabled={locked} onChange={(e) => setPersonas((p) => ({ ...p, [id]: e.target.value }))}>
                  <option value="">(default)</option>
                  {personaDefs.map((pd) => <option key={pd.id} value={pd.id} title={pd.prompt}>{pd.name}</option>)}
                </select>
              </div>
            ))}
            <div className="label">Edit or add personas in Settings → Fusion Council.</div>
          </div>
        )}
      </div>

      <div className="col" style={{ gap: 4 }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <label style={{ fontSize: 11, color: 'var(--muted)' }} title="Authoritative facts the models can't infer (engine/lib versions, plugins, OS). Injected as ground truth so they don't suggest deprecated/removed APIs.">Environment / ground truth</label>
          <button onClick={detectEnv} disabled={!!busy} title="Probe the workspace (project.godot, package.json, …) to prefill version + plugin facts">Detect</button>
        </div>
        <textarea disabled={locked} placeholder="e.g. Godot 4.x (set your version), GDScript 2.0; addons: …. Authoritative — agents must not contradict it." value={context} onChange={(e) => setContext(e.target.value)} onBlur={saveEnv} rows={3} style={{ fontSize: 12 }} />
      </div>

      <div className="col" style={{ gap: 4 }}>
        <label style={{ fontSize: 12 }} title="Raise temperature for the chosen agents (more divergent / creative). Great for first drafts; pair with Tournament/Steelman. Other dials like top_p help less — temperature is the main lever.">
          <input type="checkbox" disabled={locked} checked={hot} onChange={(e) => setHot(e.target.checked)} /> 🌡️ Run hot (raise temperature)
        </label>
        {hot && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 11, color: 'var(--muted)' }}>hot agents:</span>
            {assignedIds.map((id) => (
              <label key={id} style={{ fontSize: 12 }}><input type="checkbox" checked={hotAgents.includes(id)} onChange={() => toggleHot(id)} /> {nameOf(id)}</label>
            ))}
            <label style={{ fontSize: 12 }}>temp <input type="number" step={0.05} min={0.1} max={2} value={hotTemp} onChange={(e) => setHotTemp(Math.min(2, Math.max(0.1, Number(e.target.value) || 1.15)))} style={{ width: 60 }} /></label>
          </div>
        )}
      </div>

      <textarea disabled={locked} placeholder="Task / goal for the council…" value={cfg.task} onChange={(e) => update({ task: e.target.value })} rows={3} />
      {err && <div className="banner warn" style={{ fontSize: 12 }}>{err}</div>}
      {!!probed.length && (
        <div className="col" style={{ gap: 3 }}>
          {probed.map(([id, r]) => {
            const agent = roster.find(a => a.id === id);
            return <div key={id} className="label"><span className={`badge ${r.ok ? 'ok' : 'bad'}`}>{r.ok ? 'ready' : 'not ready'}</span> {agent?.displayName ?? id}: {r.detail}</div>;
          })}
        </div>
      )}
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label className="label"><input type="checkbox" checked={dryRun} disabled={locked} onChange={e => setDryRun(e.target.checked)} /> dry-run (no merge)</label>
        <label className="label" title="Before round 1, the panel agrees on up to 6 clarifying questions, then PAUSES for you to answer. Your answers are injected as authoritative context; the chosen mode then runs in full (nothing is skipped).">
          <input type="checkbox" checked={prologue} disabled={locked} onChange={e => setPrologue(e.target.checked)} /> 🧭 Prologue (ask me questions first)
        </label>
        <label className="label" title="Force EVERY judge gate to be blind — the judge sees only the task + the patch, never the panel's discussion or consensus, and is asked 'what is still wrong?'. Gauntlet/Red-team/Steelman/Devil/Crucible are already blind; this adds it to Council/PCRSR/GCRJ/etc.">
          <input type="checkbox" checked={forceBlind} disabled={locked} onChange={e => setForceBlind(e.target.checked)} /> 🙈 Blind judge
        </label>
        <label className="label" title="Add an ingest phase first: query the Atlas (code-brain) for symbols relevant to the task + read the top files, and feed that to the panel so it reasons about the REAL code, not just your description. Needs the workspace indexed (Project Brain → Index).">
          <input type="checkbox" checked={groundInRepo} disabled={locked} onChange={e => setGroundInRepo(e.target.checked)} /> 🔎 Ground in repo
        </label>
        <button onClick={preflight} disabled={!!busy}>Check agents</button>
        <button onClick={start} disabled={!!busy || locked || !cfg.task.trim() || !cfg.assignment.panelists.length}>▶ Start session</button>
        <button onClick={() => window.api.app.openTraceLog()}>Open trace log</button>
        {busy && <span className="badge warn">{busy}</span>}
        {locked && <span className="badge warn">session locked while running</span>}
        <span style={{ color: 'var(--muted)', fontSize: 11 }}>Roster is edited in Settings → Agent Roster.</span>
      </div>

      <div className="col" style={{ gap: 6, borderTop: '1px solid var(--border)', paddingTop: 8 }}>
        <label style={{ fontSize: 11, color: 'var(--muted)' }}>Autonomous goal loop — branch → run → checkpoint each iteration → goal-check → repeat (halts on success / cap / oscillation)</label>
        <textarea disabled={locked} placeholder="High-level goal to drive autonomously…" value={loopGoal} onChange={(e) => setLoopGoal(e.target.value)} rows={2} />
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <label style={{ fontSize: 12 }} title="Drive each iteration with the session protocol, or a full Fusion method (its build step auto-applies so iterations accumulate).">driver
            <select disabled={locked} value={loopMethod} onChange={(e) => setLoopMethod(e.target.value)} style={{ marginLeft: 4 }}>
              <option value="">Session protocol ({cfg.protocolId})</option>
              {methodList.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <label style={{ fontSize: 12 }}>max iterations <input disabled={locked} type="number" min={1} max={50} value={loopMax} onChange={(e) => setLoopMax(Math.max(1, Number(e.target.value) || 1))} style={{ width: 60 }} /></label>
          <button onClick={startLoop} disabled={!!busy || locked || !loopGoal.trim() || !cfg.assignment.panelists.length}>⟳ Start autonomous loop</button>
        </div>
      </div>
    </div>
  );
}
