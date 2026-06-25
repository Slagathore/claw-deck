import React, { useEffect, useState } from 'react';
import { useCouncil, Assignment, SessionConfig } from '../store/council';

interface RosterAgent { id: string; displayName: string; transport: string; model?: string; binary?: string; capabilities: { canEdit: boolean; canRunTools: boolean; costTier: string } }
const PROTOCOLS = ['COUNCIL', 'PCRSR', 'GCRJ', 'REDTEAM', 'PAIR'];

function defaultConfig(roster: RosterAgent[]): SessionConfig {
  const panel = roster.filter((a) => a.transport.startsWith('ollama')).map((a) => a.id).slice(0, 3);
  const judge = roster.find((a) => a.transport === 'claude-code')?.id ?? roster[0]?.id ?? '';
  const qa = roster.find((a) => a.transport === 'codex')?.id ?? roster.find((a) => a.capabilities.canEdit)?.id ?? judge;
  return { protocolId: 'COUNCIL', assignment: { panelists: panel.length ? panel : roster.slice(0, 2).map((a) => a.id), judge, qaGate: qa }, task: '' };
}

/** Per-tab session config — dropdowns populated from the global roster (§4.5). */
export default function CouncilSettings({ workspace }: { workspace: string }) {
  const { configs, setConfig, startRun } = useCouncil();
  const [roster, setRoster] = useState<RosterAgent[]>([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  useEffect(() => { window.api.settings.get().then((s) => setRoster(s.fusionRoster ?? [])); }, []);
  useEffect(() => { if (roster.length && !configs[workspace]) setConfig(workspace, defaultConfig(roster)); }, [roster, workspace, configs, setConfig]);

  const cfg = configs[workspace] ?? defaultConfig(roster);
  const update = (patch: Partial<SessionConfig>) => setConfig(workspace, { ...cfg, ...patch });
  const updateAssign = (patch: Partial<Assignment>) => update({ assignment: { ...cfg.assignment, ...patch } });
  const togglePanelist = (id: string) => updateAssign({ panelists: cfg.assignment.panelists.includes(id) ? cfg.assignment.panelists.filter((x) => x !== id) : [...cfg.assignment.panelists, id] });

  async function start() {
    setErr(''); setBusy('Starting…');
    const r = await window.api.council.start({ repo: workspace, protocolId: cfg.protocolId, assignment: cfg.assignment, task: cfg.task });
    setBusy('');
    if (!r.ok || !r.runId) { setErr(r.error ?? 'failed to start'); return; }
    startRun(workspace, r.runId);
  }

  const opt = (a: RosterAgent) => <option key={a.id} value={a.id}>{a.displayName}</option>;

  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong>Session config</strong>
        <select value={cfg.protocolId} onChange={(e) => update({ protocolId: e.target.value })}>{PROTOCOLS.map((p) => <option key={p} value={p}>{p}</option>)}</select>
      </div>

      <div className="col" style={{ gap: 4 }}>
        <label style={{ fontSize: 11, color: 'var(--muted)' }}>Panelists (multi-select)</label>
        <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
          {roster.map((a) => (
            <label key={a.id} style={{ fontSize: 12 }}>
              <input type="checkbox" checked={cfg.assignment.panelists.includes(a.id)} onChange={() => togglePanelist(a.id)} /> {a.displayName}
            </label>
          ))}
        </div>
      </div>

      <div className="row" style={{ flexWrap: 'wrap', gap: 10 }}>
        <label style={{ fontSize: 12 }}>Judge <select value={cfg.assignment.judge} onChange={(e) => updateAssign({ judge: e.target.value })}>{roster.map(opt)}</select></label>
        <label style={{ fontSize: 12 }}>QA gate <select value={cfg.assignment.qaGate} onChange={(e) => updateAssign({ qaGate: e.target.value })}>{roster.map(opt)}</select></label>
        <label style={{ fontSize: 12 }}>Scribe <select value={cfg.assignment.scribe ?? ''} onChange={(e) => updateAssign({ scribe: e.target.value || undefined })}><option value="">(judge)</option>{roster.map(opt)}</select></label>
      </div>

      <textarea placeholder="Task / goal for the council…" value={cfg.task} onChange={(e) => update({ task: e.target.value })} rows={3} />
      {err && <div style={{ color: 'var(--bad)', fontSize: 12 }}>{err}</div>}
      <div className="row">
        <button onClick={start} disabled={!!busy || !cfg.task.trim() || !cfg.assignment.panelists.length}>▶ Start session</button>
        {busy && <span className="badge warn">{busy}</span>}
        <span style={{ color: 'var(--muted)', fontSize: 11 }}>Roster is edited in Settings → Agent Roster.</span>
      </div>
    </div>
  );
}
