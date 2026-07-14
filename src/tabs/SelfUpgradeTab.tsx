import React, { useEffect, useState, useRef } from 'react';
import UpgradesTab from './UpgradesTab';
import { useSettings, useUI } from '../store/ui';
import { useConsole } from '../store/console';
import { pickAssetFor, isNewer, type Platform, type Arch, type ReleaseCandidate } from '../lib/autoUpdate';

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
  packaged?: boolean;
  reseeded?: boolean;
  archivedTo?: string;
  supersededVersion?: string;
  promoted?: PromotedStatus;
}

interface PromotedStatus {
  active: boolean;
  running: boolean;
  runningRoot?: string | null;
  appVersion: string;
  current?: { id: string; appVersion: string; promotedAt: number; gateMode?: string; gateSkipped?: { check: string; reason: string }[] } | null;
  lastRollback?: { at: number; id: string; reason: string } | null;
  journal?: { at: number; event: string; id?: string; reason?: string }[];
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
      // upgrades.check resolves to { kind, candidates, note } — not a bare array.
      const res: any = await window.api.upgrades.check('self');
      const candidates: ReleaseCandidate[] = Array.isArray(res) ? res : (res?.candidates ?? []);
      const newer = candidates.find(c => isNewer(c.version, info.version));
      if (!newer) { setOta({ state: 'noUpdate', message: `You're on the latest version (${info.version}).` }); return; }
      const asset = pickAssetFor(newer, info.platform, info.arch);
      setOta({
        state: 'updateFound', candidate: newer, pickedAssetName: asset?.name,
        message: asset ? `Update ${newer.version} available (asset: ${asset.name})` : `Update ${newer.version} available but no installable asset for ${info.platform}/${info.arch}.`
      });
    } catch (e: any) { setOta({ state: 'error', message: e.message }); }
  }

  async function install() {
    if (!info || !ota.candidate) return;
    const asset = pickAssetFor(ota.candidate, info.platform, info.arch);
    if (!asset) { setOta({ ...ota, state: 'error', message: 'No matching asset' }); return; }
    if (info.platform !== 'win32') {
      setOta({ ...ota, state: 'error', message: `Automatic install is only wired up for the Windows NSIS installer (this is ${info.platform}). Use the manual install section below.` });
      return;
    }
    if (!confirm(
      `Download and install Claw Deck ${ota.candidate.version}?\n\n` +
      `This downloads the installer, verifies its hash/signature, then RUNS it. ` +
      `Windows will show the installer (and may ask for elevation). Claw Deck will close so it can update itself; ` +
      `your settings and history in %APPDATA% are left untouched. Reopen Claw Deck when the installer finishes.`
    )) return;
    setOta({ ...ota, state: 'installing', message: `Downloading and verifying ${asset.name}…` });
    try {
      // launchInstaller:true is what turns "downloaded" into "installed": the
      // vetted NSIS .exe is run and the app quits so it can replace its own files.
      const manifest = {
        kind: 'self', name: 'claw-deck', version: ota.candidate.version,
        url: asset.url, sha256: asset.sha256, signature: asset.signature,
        launchInstaller: true
      };
      let r = await window.api.upgrades.install(manifest);
      if (r?.ok === false && r.requiresUnsignedConfirmation) {
        const accept = confirm(
          `"${ota.candidate.version}" has no verifiable signature, and this Claw Deck is set to require one.\n\n` +
          `Install it anyway? Only do this if you trust where it came from (e.g. your own unsigned build).`
        );
        if (accept) r = await window.api.upgrades.install({ ...manifest, acceptUnsigned: true });
      }
      if (r?.ok === false) {
        // Honest failure: download/verify may have passed but the install did not.
        setOta({ ...ota, state: 'error', message: r.reason || 'install failed' });
      } else if (r?.installerLaunched) {
        setOta({ ...ota, state: 'installed', message: `Installer for ${ota.candidate.version} launched. Claw Deck is closing so it can update. Reopen it when the installer finishes.` });
      } else {
        // Should not happen with launchInstaller:true, but never lie about it.
        setOta({ ...ota, state: 'error', message: `Verified but not installed: ${r?.installerReason || 'the installer did not run'}. File is in quarantine: ${r?.file ?? '(unknown)'}` });
      }
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

  async function revertPromotion() {
    if (!confirm('Revert the promoted self-upgrade? On the next launch Claw Deck will load the build that shipped with the installer.')) return;
    setBusy('Reverting promotion…');
    try {
      const r = await window.api.selfUpgrade.revertPromotion();
      if (!r.ok) alert(`Revert failed: ${r.reason}`);
      else if (confirm(`${r.note}\n\nRelaunch now?`)) { await window.api.selfUpgrade.relaunch(); return; }
      await refreshStatus();
    } finally { setBusy(null); }
  }

  async function dismissRollbackNotice() {
    await window.api.selfUpgrade.dismissRollbackNotice();
    await refreshStatus();
  }

  async function setOrigin() {
    const url = prompt('Paste the GitHub remote URL for this source tree (use a PRIVATE repo).\n\nExample: git@github.com:Slagathore/claw-deck.git');
    if (!url) return;
    const r = await window.api.selfUpgrade.setOrigin(url);
    if (!r.ok) alert(`Set origin failed: ${r.reason || 'unknown'}`);
    else { alert('Origin set.'); await refreshStatus(); }
  }

  // In a packaged build the bundled source tree has no node_modules, so the
  // typecheck/test gates can't run until deps are installed. This kicks off
  // `npm install` in the source root and surfaces it in the Console.
  async function prepareDeps() {
    if (!status?.sourceRoot) return;
    const npm = navigator.platform.startsWith('Win') ? 'npm.cmd' : 'npm';
    try {
      const { id } = await window.api.runner.start({ backend: 'shell', binary: npm, args: ['install', '--no-audit', '--no-fund'], cwd: status.sourceRoot });
      useConsole.getState().add({
        id, kind: 'tool', label: 'self-upgrade: npm install',
        detail: `${npm} install (cwd: ${status.sourceRoot})`, cwd: status.sourceRoot,
        startedAt: Date.now(), supportsInput: false,
        output: `[preparing self-upgrade deps] npm install in ${status.sourceRoot}\n`
      });
      useUI.getState().setTab('console');
    } catch (e: any) {
      alert(`Failed to start npm install: ${e.message}`);
    }
  }

  // The snapshot to target for a one-click revert: prefer the one from this
  // session's most recent pipeline run, and fall back to the newest entry in
  // the durable on-disk index (so the button still works after an app
  // restart, or after a run that succeeded and is now just "live but wrong").
  const lastSnapshotId: string | null = lastResult?.snapshot?.id ?? status?.snapshots?.[0]?.id ?? null;
  const lastSnapshotAt: number | null = lastResult?.snapshot?.createdAt ?? status?.snapshots?.[0]?.createdAt ?? null;

  return (
    <div className="col">
      <div className="card col">
        <b>Recursive self-upgrade.</b> The app reads its own source, proposes a change, and runs it through snapshot → patch → security-scan delta → (typecheck + tests, when the tree has deps){status?.packaged ? ' → esbuild build → child-process boot probe → promote' : ' → optional probe-child boot'}. {status?.packaged
          ? 'Because the packaged app boots from the read-only asar, a passing patch is BUILT into a promoted bundle that the app loads on its next launch; if that bundle fails to boot it is rolled back to the shipped build automatically.'
          : 'A patch that passes the gate is live in the source tree immediately, there is no separate approval click.'} Auto-rollback fires on any gate/build/probe failure; to undo a passing change, use "Revert last upgrade" below{status?.packaged ? ', and "Revert to shipped build" for a promoted bundle' : ''}.

        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 8, padding: 8, border: '1px solid #b22222', borderRadius: 6, background: 'rgba(178,34,34,.08)' }}>
          <div>
            <b>Revert last upgrade</b>
            <div className="label">
              {lastSnapshotId
                ? <>Restores the snapshot taken before the last self-upgrade run ({lastSnapshotAt ? new Date(lastSnapshotAt).toLocaleString() : lastSnapshotId}), even if that run passed its gates and is already live.</>
                : 'No snapshot yet. Run a self-upgrade or take a manual snapshot first.'}
            </div>
          </div>
          <button
            disabled={!!busy || !lastSnapshotId}
            onClick={() => lastSnapshotId && rollback(lastSnapshotId)}
            style={{ background: '#b22222', color: '#fff', fontWeight: 700, whiteSpace: 'nowrap' }}
          >
            ⏮ Revert last upgrade
          </button>
        </div>

        {status?.promoted?.lastRollback && (
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 8, padding: 8, border: '1px solid #b8860b', borderRadius: 6, background: 'rgba(184,134,11,.10)' }}>
            <div>
              <b>Self-upgrade rolled back automatically</b>
              <div className="label" style={{ whiteSpace: 'pre-wrap' }}>{status.promoted.lastRollback.reason}</div>
            </div>
            <button onClick={dismissRollbackNotice} style={{ whiteSpace: 'nowrap' }}>Dismiss</button>
          </div>
        )}

        {status?.promoted?.active && (
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginTop: 8, padding: 8, border: '1px solid #1e7e34', borderRadius: 6, background: 'rgba(30,126,52,.10)' }}>
            <div>
              <b>Promoted self-upgrade active</b>
              <div className="label">
                Bundle <code>{status.promoted.current?.id}</code>
                {status.promoted.current?.gateMode ? <> · {status.promoted.current.gateMode} gate</> : null}
                {status.promoted.running ? <> · running now</> : <> · loads on next launch</>}
                {status.promoted.current?.gateSkipped?.length ? <><br/>Not verified in this build: {status.promoted.current.gateSkipped.map(s => s.check).join(', ')}</> : null}
              </div>
            </div>
            <button onClick={revertPromotion} disabled={!!busy} style={{ whiteSpace: 'nowrap' }}>Revert to shipped build</button>
          </div>
        )}

        {status?.reseeded && (
          <div className="label" style={{ marginTop: 8, padding: 8, border: '1px solid #b8860b', borderRadius: 6 }}>
            Source tree re-seeded from {status.supersededVersion} to {status.version} (the old tree was stale and could not carry patches forward). Previous tree archived at <code>{status.archivedTo}</code>.
          </div>
        )}

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
          <button disabled={!!busy} onClick={prepareDeps} title="Run npm install in the source tree so the typecheck/test gates can run (needed once in packaged installs)">📦 Prepare deps (npm install)</button>
          <button disabled={!!busy} onClick={refreshStatus}>🔄 Refresh</button>
          {busy && <span className="label">{busy}</span>}
        </div>
        <div className="label">
          The gate runs <code>npm run lint</code> + <code>npm test</code> in the source tree. In a packaged
          install that tree is bundled without <code>node_modules</code>, so click <strong>Prepare deps</strong>{' '}
          once (needs Node + npm on PATH). The security-scan delta gate runs regardless. If the gate can't run,
          the patch is rolled back automatically; it's never applied unverified.
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
                [{new Date(e.at).toLocaleTimeString()}] {e.phase} · {e.status}{e.message ? `: ${e.message}` : ''}
              </div>
            ))}
          </div>
          {lastResult && (
            <div className="label" style={{ marginTop: 4 }}>
              Result: <b style={{ color: lastResult.success ? '#1e7e34' : '#b22222' }}>{lastResult.success ? 'SUCCESS' : 'FAILED'}</b>
              {lastResult.rolledBack && ' (rolled back)'}
              {lastResult.snapshot && <> · snapshot <code>{lastResult.snapshot.id}</code></>}
              {lastResult.promoted && <> · promoted bundle <code>{lastResult.promoted.id}</code> (loads next launch)</>}
              {lastResult.gate?.mode && <> · {lastResult.gate.mode} gate</>}
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
        <b>OTA update (binary install).</b> Uses the same allowlist + hash + signature + scan gate as the OpenClaw tab.
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
      <UpgradesTab kind="self" title="Manual install & history" showCheck={false} />
    </div>
  );
}
