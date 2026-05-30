import React, { useEffect, useState } from 'react';

interface Candidate {
  source: string;
  name: string;
  version: string;
  rawTag: string;
  publishedAt?: number;
  notes?: string;
  htmlUrl?: string;
  assets: { name: string; url: string; size?: number }[];
}

export default function UpgradesTab({ kind, title }: { kind: 'openclaw' | 'self'; title: string }) {
  const [list, setList] = useState<any[]>([]);
  const [url, setUrl] = useState('');
  const [version, setVersion] = useState('');
  const [name, setName] = useState(kind === 'self' ? 'claw-deck' : 'openclaw');
  const [sha, setSha] = useState('');
  const [status, setStatus] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [checkNote, setCheckNote] = useState<string>('');
  const [checking, setChecking] = useState(false);

  async function refresh() {
    const all = await window.api.upgrades.list();
    setList(all.filter((x: any) => x.kind === kind));
  }
  useEffect(() => { refresh(); }, [kind]);

  async function check() {
    setChecking(true);
    try {
      const r = await window.api.upgrades.check(kind);
      setCandidates(r.candidates ?? []);
      setCheckNote(r.note ?? '');
    } finally { setChecking(false); }
  }

  function applyAsset(c: Candidate, a: { name: string; url: string }) {
    setName(c.name);
    setVersion(c.version);
    setUrl(a.url);
    setSha('');
  }

  async function install() {
    setBusy(true); setStatus(null);
    try {
      const r = await window.api.upgrades.install({ kind, name, version, url, sha256: sha });
      setStatus(r);
      await refresh();
    } finally { setBusy(false); }
  }

  return (
    <div className="col">
      <h2 style={{ margin: 0 }}>{title}</h2>

      <div className="card col">
        <div className="row">
          <h3 style={{ margin: 0, flex: 1 }}>Available Releases</h3>
          <button onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check for updates'}</button>
        </div>
        {checkNote && <div className="label">{checkNote}</div>}
        {candidates.map(c => (
          <div key={c.source + c.rawTag} className="card" style={{ background: 'var(--panel-2)' }}>
            <div className="row">
              <b>{c.name}</b>
              <span className="badge ok">{c.rawTag}</span>
              {c.publishedAt && <span className="label">{new Date(c.publishedAt).toLocaleDateString()}</span>}
              <div style={{ flex: 1 }} />
              {c.htmlUrl && <a href={c.htmlUrl} target="_blank" rel="noreferrer" className="label">release page</a>}
            </div>
            {c.notes && (
              <details style={{ marginTop: 6 }}>
                <summary className="label">release notes</summary>
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>{c.notes.slice(0, 4000)}{c.notes.length > 4000 ? '\n…(truncated)' : ''}</pre>
              </details>
            )}
            {c.assets.length === 0 && <div className="label">No downloadable assets in this release.</div>}
            {c.assets.map(a => (
              <div key={a.url} className="row">
                <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}>{a.name}</span>
                {a.size && <span className="label">{Math.round(a.size / 1024)} KB</span>}
                <button onClick={() => applyAsset(c, a)}>Use</button>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>Install / Update</h3>
        <div className="row"><input placeholder="name" value={name} onChange={e => setName(e.target.value)} style={{ flex: 1 }} />
          <input placeholder="version" value={version} onChange={e => setVersion(e.target.value)} /></div>
        <input placeholder="download URL (https, must be allowlisted)" value={url} onChange={e => setUrl(e.target.value)} />
        <input placeholder="expected SHA-256 (recommended)" value={sha} onChange={e => setSha(e.target.value)} />
        <div className="row">
          <button className="primary" disabled={busy || !url || !version} onClick={install}>Download, Scan, Install</button>
        </div>
        {status && (
          <div className={`card`} style={{ background: status.ok ? 'rgba(74,222,128,.08)' : 'rgba(248,113,113,.08)' }}>
            <b>{status.ok ? 'OK' : 'Blocked'}:</b> {status.reason ?? `installed ${status.file}`}
            {status.scanResults && (
              <ul>{status.scanResults.map((s: any, i: number) => (
                <li key={i}><span className={`badge ${s.ok ? 'ok' : 'bad'}`}>{s.engine}</span> {s.detail}</li>
              ))}</ul>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Installed</h3>
        <table>
          <thead><tr><th>When</th><th>Name</th><th>Version</th><th>SHA-256</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {list.map(r => (
              <tr key={r.id}>
                <td>{new Date(r.installed_at).toLocaleString()}</td>
                <td>{r.name}</td>
                <td>{r.version}</td>
                <td style={{ fontFamily: 'monospace', fontSize: 10 }}>{r.sha256?.slice(0, 16)}…</td>
                <td><span className={`badge ${r.status === 'installed' ? 'ok' : 'warn'}`}>{r.status}</span></td>
                <td>{r.status === 'installed' && <button onClick={async () => { await window.api.upgrades.rollback(r.id); refresh(); }}>Rollback</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
