import React, { useEffect, useState, useRef } from 'react';
import UpgradesTab from './UpgradesTab';
import { useSettings } from '../store/ui';
import { pickAssetFor, isNewer, Platform, Arch, ReleaseCandidate } from '../lib/autoUpdate';

interface OtaStatus {
  state: 'idle' | 'checking' | 'noUpdate' | 'updateFound' | 'installing' | 'installed' | 'error';
  message?: string;
  candidate?: ReleaseCandidate;
  pickedAssetName?: string;
}

interface PipelineEvent {
  runId: string;
  phase: string;
  status: 'start' | 'ok' | 'fail' | 'skip';
  message?: string;
  data?: any;
  at: number;
}

interface RecursiveStatus {
  sourceRoot: string;
  ready: boolean;
  reason?: string;
  repo: {
    hasGit: boolean;
    isRepo: boolean;
    hasOrigin: boolean;
    originUrl?: string;
    branch?: string;
    dirty?: boolean;
  };
  snapshots: { id: string; createdAt: number }[];
  electronExe: string;
  version: string;
}

interface PatchFile {
  path: string;
  mode: 'create' | 'replace' | 'delete';
  contents?: string;
}
interface PatchSet {
  id: string;
  rationale: string;
  files: PatchFile[];
}
interface Risk {
  level: 'low' | 'medium' | 'high';
  score: number;
  reasons: string[];
}

const RISK_COLOR: Record<Risk['level'], string> = {
  low: '#1e7e34',
  medium: '#b8860b',
  high: '#b22222'
};

export default function SelfUpgradeTab() {
  const [info, setInfo] = useState<{ version: string; platform: Platform; arch: Arch } | null>(null);
  const [ota, setOta] = useState<OtaStatus>({ state: 'idle' });

  const { data: s } = useSettings();
  const su = (s as any).selfUpgrade || {};
  const [status, setStatus] = useState<RecursiveStatus | null>(null);
  const [proposal, setProposal] = useState<PatchSet | null>(null);
  const [risk, setRisk] = useState<Risk | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [events, setEvents] = useState<PipelineEvent[]>([]);
  const [manualText, setManualText] = useState('');
  const [showFileIdx, setShowFileIdx] = useState<number | null>(null);
  const [lastResult, setLastResult] = useState<any>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    window.api.app.version().then(v => setInfo({ version: v.version, platform: v.platform as Platform, arch: v.arch as Arch }));
    refreshStatus();
    const off = window.api.selfUpgrade.onEvent((e: PipelineEvent) => {
      setEvents(prev => [...prev.slice(-200), e]);
      setTimeout(() => { logRef.current?.scrollTo({ top: 99999 }); }, 10);
    });
    return () => off?.();
  }, []);

  async function refreshStatus() {
    try {
      const st = await window.api.selfUpgrade.status();
      setStatus(st);
    } catch { /* ignore */ }
  }

  async function check() {
    if (!info) return;
    setOta({ state: 'checking' });
    try {
      const candidates: ReleaseCandidate[] = await window.api.upgrades.check('self');
      const newer = (candidates ?? []).find(c => isNewer(c.version, info.version));
      if (!newer) { setOta({ state: 'noUpdate', message: `You're on the latest version (${info.version}).` }); return; }
      const asset = pickAssetFor(newer, info.platform, info.arch);
      setOta({
        state: 'updateFound', candidate: newer, pickedAssetName: asset?.name,
        message: asset ? `Update ${newer.version} available — asset: ${asset.name}` : `Update ${newer.version} available but no installable asset for ${info.platform}/${info.arch}.`
      });
    } catch (e: any) { setOta({ state: 'error', message: e.message }); }
  }

  async function install() {
    if (!info || !ota.candidate) return;
    const asset = pickAssetFor(ota.candidate, info.platform, info.arch);
    if (!asset) { setOta({ ...ota, state: 'error', message: 'No matching asset' }); return; }
    setOta({ ...ota, state: 'installing', message: `Downloading ${asset.name}…` });
    try {
      const r = await window.api.upgrades.install({
        kind: 'self', name: 'claw-deck', version: ota.candidate.version,
        url: asset.url, sha256: asset.sha256, signature: asset.signature
      });
      if (r?.ok === false) setOta({ ...ota, state: 'error', message: r.reason || 'install failed' });
      else setOta({ ...ota, state: 'installed', message: `Installed ${ota.candidate.version}. Restart Claw Deck to use the new version.` });
    } catch (e: any) { setOta({ ...ota, state: 'error', message: e.message }); }
  }

  async function reflect() {
    setBusy('Reflecting on codebase…');
    setProposal(null); setRisk(null); setEvents([]);
    try {
      const r = await window.api.selfUpgrade.reflect({
        backend: su.backend || 'local',
        ollamaUrl: su.ollamaUrl, ollamaModel: su.ollamaModel,
        remoteUrl: su.remoteUrl, remoteKey: su.remoteKey, remoteModel: su.remoteModel,
        goal: su.goal
      });
      if (!r.ok) { alert(`Reflect failed: ${r.reason || 'unknown'}`); return; }
      setProposal(r.proposal); setRisk(r.risk);
    } finally { setBusy(null); }
  }

  async function parseManual() {
    if (!manualText.trim()) return;
    setBusy('Parsing manual patch…');
    try {
      const r = await window.api.selfUpgrade.parseManualPatch(manualText);
      if (!r.ok) { alert(`Parse failed: ${r.reason}`); return; }
      setProposal(r.proposal); setRisk(r.risk);
    } finally { setBusy(null); }
  }

  async function runPatch(launchProbe: boolean) {
    if (!proposal) return;
    setBusy('Running pipeline…'); setEvents([]); setLastResult(null);
    try {
      const r = await window.api.selfUpgrade.run({
        patch: proposal,
        autoApply: !!su.autoApply,
        sandboxHighRisk: su.sandboxHighRisk !== false,
        probeChecks: su.probeChecks || ['boot', 'db', 'tray'],
        launchProbe
      });
      setLastResult(r);
      await refreshStatus();
    } finally { setBusy(null); }
  }

  async function rollback(id: string) {
    if (!confirm(`Roll back to snapshot ${id}?`)) return;
    setBusy('Rolling back…');
    try {
      const r = await window.api.selfUpgrade.rollback(id);
      if (!r.ok) alert(`Rollback failed: ${r.reason}`);
      else { alert('Rolled back.'); await refreshStatus(); }
    } finally { setBusy(null); }
  }

  async function makeSnapshot() {
    setBusy('Creating snapshot…');
    try { await window.api.selfUpgrade.snapshot('manual snapshot'); await refreshStatus(); }
    finally { setBusy(null); }
  }

  async function setOrigin() {
    const url = prompt('Paste the GitHub remote URL for this source tree (use a PRIVATE repo).\n\nExample: git@github.com:Slagathore/claw-deck.git');
    if (!url) return;
    const r = await window.api.selfUpgrade.setOrigin(url);
    if (!r.ok) alert(`Set origin failed: ${r.reason || 'unknown'}`);
    else { alert('Origin set.'); await refreshStatus(); }
  }

  return (
    <div className="col">
      <div className="card col">
        <b>Recursive self-upgrade</b> — the app reads its own source, proposes a change, and runs it through snapshot → patch → typecheck → tests → security scan delta → probe-child boot. Rolls back automatically on any failure.

        <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
          <div><span className="label">Source: </span><code style={{ fontSize: 11 }}>{status?.sourceRoot || '…'}</code></div>
          <div><span className="label">Ready: </span><b style={{ color: status?.ready ? '#1e7e34' : '#b22222' }}>{status?.ready ? 'yes' : 'no'}</b></div>
          <div><span className="label">Git: </span>{status?.repo.hasGit ? (status.repo.isRepo ? `repo · ${status.repo.branch || '?'}${status.repo.dirty ? ' (dirty)' : ''}` : 'not a repo') : 'not installed'}</div>
          <div><span className="label">Origin: </span>{status?.repo.hasOrigin ? <code style={{ fontSize: 11 }}>{status.repo.originUrl}</code> : <i>none</i>}</div>
        </div>
        {status?.reason && <div className="label bad">{status.reason}</div>}

        <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
          <button className="primary" disabled={!!busy || !status?.ready} onClick={reflect}>🧠 Reflect now</button>
          <button disabled={!!busy} onClick={makeSnapshot}>📸 Manual snapshot</button>
          <button disabled={!!busy} onClick={setOrigin}>🔗 Set GitHub origin</button>
          <button disabled={!!busy} onClick={() => window.api.selfUpgrade.openSourceRoot()}>📂 Open source folder</button>
          <button disabled={!!busy} onClick={refreshStatus}>🔄 Refresh</button>
          {busy && <span className="label">{busy}</span>}
        </div>

        <details style={{ marginTop: 8 }}>
          <summary className="label">Paste a manual patch (JSON) instead</summary>
          <textarea
            placeholder='{"id":"...", "rationale":"...", "files":[{"path":"...","mode":"replace","contents":"..."}]}'
            value={manualText} onChange={e => setManualText(e.target.value)}
            style={{ width: '100%', minHeight: 100, fontFamily: 'monospace', fontSize: 12, marginTop: 4 }}
          />
          <button disabled={!!busy} onClick={parseManual} style={{ marginTop: 4 }}>Parse</button>
        </details>
      </div>

      {proposal && (
        <div className="card col">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <b>Proposal: {proposal.id}</b>
            {risk && (
              <span style={{
                padding: '2px 10px', borderRadius: 10, color: '#fff',
                background: RISK_COLOR[risk.level], fontSize: 11, fontWeight: 700
              }}>{risk.level.toUpperCase()} · score {risk.score}</span>
            )}
          </div>
          <div className="label" style={{ whiteSpace: 'pre-wrap' }}>{proposal.rationale}</div>
          {risk?.reasons && risk.reasons.length > 0 && (
            <details>
              <summary className="label">Why this risk score</summary>
              <ul style={{ margin: '4px 0 0 16px', fontSize: 12 }}>
                {risk.reasons.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            </details>
          )}
          <div style={{ marginTop: 8 }}>
            {proposal.files.map((f, i) => (
              <div key={i} style={{ borderTop: '1px solid #333', padding: '6px 0' }}>
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <code style={{ fontSize: 12 }}>{f.mode}: {f.path}</code>
                  <button onClick={() => setShowFileIdx(showFileIdx === i ? null : i)}>{showFileIdx === i ? 'hide' : 'show'} contents</button>
                </div>
                {showFileIdx === i && f.contents !== undefined && (
                  <pre style={{ background: '#111', padding: 8, fontSize: 11, overflow: 'auto', maxHeight: 300 }}>{f.contents}</pre>
                )}
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 6, marginTop: 8 }}>
            <button className="primary" disabled={!!busy} onClick={() => runPatch(false)}>🛡️ Apply with gates (no probe)</button>
            <button disabled={!!busy} onClick={() => runPatch(true)}>🚀 Apply + launch probe child</button>
            <button disabled={!!busy} onClick={() => { setProposal(null); setRisk(null); }}>✕ Discard</button>
          </div>
        </div>
      )}

      {events.length > 0 && (
        <div className="card col">
          <b>Pipeline log</b>
          <div ref={logRef} style={{
            background: '#0a0a0a', color: '#cfcfcf', fontFamily: 'monospace',
            fontSize: 11, padding: 8, maxHeight: 280, overflow: 'auto', borderRadius: 4
          }}>
            {events.map((e, i) => (
              <div key={i} style={{
                color: e.status === 'fail' ? '#ff6b6b' : e.status === 'ok' ? '#6bcf6b' : e.status === 'skip' ? '#888' : '#cfcfcf'
              }}>
                [{new Date(e.at).toLocaleTimeString()}] {e.phase} · {e.status}{e.message ? ` — ${e.message}` : ''}
              </div>
            ))}
          </div>
          {lastResult && (
            <div className="label" style={{ marginTop: 4 }}>
              Result: <b style={{ color: lastResult.success ? '#1e7e34' : '#b22222' }}>{lastResult.success ? 'SUCCESS' : 'FAILED'}</b>
              {lastResult.rolledBack && ' (rolled back)'}
              {lastResult.snapshot && <> · snapshot <code>{lastResult.snapshot.id}</code></>}
              {typeof lastResult.durationMs === 'number' && <> · {(lastResult.durationMs / 1000).toFixed(1)}s</>}
            </div>
          )}
        </div>
      )}

      {status?.snapshots && status.snapshots.length > 0 && (
        <div className="card col">
          <b>Snapshot history</b>
          <div className="label">Copy-mode snapshots only. Git-mode snapshots live as commits on the repo (use <code>git log</code>).</div>
          {status.snapshots.slice(0, 20).map(snap => (
            <div key={snap.id} className="row" style={{ justifyContent: 'space-between', padding: '4px 0', borderTop: '1px solid #222' }}>
              <div>
                <code style={{ fontSize: 11 }}>{snap.id}</code>{' '}
                <span className="label">{new Date(snap.createdAt).toLocaleString()}</span>
              </div>
              <button onClick={() => rollback(snap.id)}>Roll back</button>
            </div>
          ))}
        </div>
      )}

      <div className="card col">
        <b>OTA update (binary install)</b> — uses the same allowlist + hash + signature + scan gate as the OpenClaw tab.
        <div className="label">Current version: <code>{info?.version ?? '…'}</code> · {info ? `${info.platform}/${info.arch}` : ''}</div>
        <div className="row">
          <button className="primary" onClick={check} disabled={ota.state === 'checking' || ota.state === 'installing'}>
            {ota.state === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
          {ota.state === 'updateFound' && ota.pickedAssetName && (
            <button onClick={install}>Install {ota.candidate?.version}</button>
          )}
        </div>
        {ota.message && (<div className={`label ${ota.state === 'error' ? 'bad' : ''}`}>{ota.message}</div>)}
      </div>
      <UpgradesTab kind="self" title="Claw Deck Self-Upgrade (manual)" />
    </div>
  );
}
