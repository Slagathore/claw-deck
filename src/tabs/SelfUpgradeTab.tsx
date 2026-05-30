import React, { useEffect, useState } from 'react';
import UpgradesTab from './UpgradesTab';
import { pickAssetFor, isNewer, Platform, Arch, ReleaseCandidate } from '../lib/autoUpdate';

interface Status {
  state: 'idle' | 'checking' | 'noUpdate' | 'updateFound' | 'installing' | 'installed' | 'error';
  message?: string;
  candidate?: ReleaseCandidate;
  pickedAssetName?: string;
}

export default function SelfUpgradeTab() {
  const [info, setInfo] = useState<{ version: string; platform: Platform; arch: Arch } | null>(null);
  const [status, setStatus] = useState<Status>({ state: 'idle' });

  useEffect(() => {
    window.api.app.version().then(v => setInfo({ version: v.version, platform: v.platform as Platform, arch: v.arch as Arch }));
  }, []);

  async function check() {
    if (!info) return;
    setStatus({ state: 'checking' });
    try {
      const candidates: ReleaseCandidate[] = await window.api.upgrades.check('self');
      const newer = (candidates ?? []).find(c => isNewer(c.version, info.version));
      if (!newer) {
        setStatus({ state: 'noUpdate', message: `You're on the latest version (${info.version}).` });
        return;
      }
      const asset = pickAssetFor(newer, info.platform, info.arch);
      setStatus({
        state: 'updateFound',
        candidate: newer,
        pickedAssetName: asset?.name,
        message: asset ? `Update ${newer.version} available — asset: ${asset.name}` : `Update ${newer.version} available but no installable asset for ${info.platform}/${info.arch}.`
      });
    } catch (e: any) {
      setStatus({ state: 'error', message: e.message });
    }
  }

  async function install() {
    if (!info || !status.candidate) return;
    const asset = pickAssetFor(status.candidate, info.platform, info.arch);
    if (!asset) { setStatus({ ...status, state: 'error', message: 'No matching asset' }); return; }
    setStatus({ ...status, state: 'installing', message: `Downloading ${asset.name}…` });
    try {
      const r = await window.api.upgrades.install({
        kind: 'self',
        name: 'claw-deck',
        version: status.candidate.version,
        url: asset.url,
        sha256: asset.sha256,
        signature: asset.signature
      });
      if (r?.ok === false) {
        setStatus({ ...status, state: 'error', message: r.reason || 'install failed' });
      } else {
        setStatus({ ...status, state: 'installed', message: `Installed ${status.candidate.version}. Restart Claw Deck to use the new version.` });
      }
    } catch (e: any) {
      setStatus({ ...status, state: 'error', message: e.message });
    }
  }

  return (
    <div className="col">
      <div className="card col">
        <b>Self-Upgrade</b> — uses the same allowlist + hash + signature + scan gate as the OpenClaw tab.
        <div className="label">
          Current version: <code>{info?.version ?? '…'}</code> · {info ? `${info.platform}/${info.arch}` : ''}
        </div>
        <div className="row">
          <button className="primary" onClick={check} disabled={status.state === 'checking' || status.state === 'installing'}>
            {status.state === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
          {status.state === 'updateFound' && status.pickedAssetName && (
            <button onClick={install}>Install {status.candidate?.version}</button>
          )}
        </div>
        {status.message && (
          <div className={`label ${status.state === 'error' ? 'bad' : ''}`}>{status.message}</div>
        )}
      </div>
      <UpgradesTab kind="self" title="Claw Deck Self-Upgrade (manual)" />
    </div>
  );
}
