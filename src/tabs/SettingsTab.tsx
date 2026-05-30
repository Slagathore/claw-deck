import React, { useState } from 'react';
import { useSettings } from '../store/ui';

export default function SettingsTab() {
  const { data, save } = useSettings();
  const [draft, setDraft] = useState<any>(data);
  function set<K extends string>(k: K, v: any) { setDraft({ ...draft, [k]: v }); }
  return (
    <div className="col">
      <div className="card col">
        <h3 style={{ margin: 0 }}>Ollama</h3>
        <label className="label">Ollama base URL</label>
        <input value={draft.ollamaUrl ?? ''} onChange={e => set('ollamaUrl', e.target.value)} />
        <label className="label">OpenAI-compatible URL (for vision / Gemini-flash workaround)</label>
        <input value={draft.openaiCompatUrl ?? ''} onChange={e => set('openaiCompatUrl', e.target.value)} />
        <label className="label">OpenAI-compatible API key (Ollama accepts any non-empty value)</label>
        <input value={draft.openaiCompatKey ?? ''} onChange={e => set('openaiCompatKey', e.target.value)} />
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>Models</h3>
        <label className="label">Default chat model</label>
        <input value={draft.chatModel ?? ''} onChange={e => set('chatModel', e.target.value)} />
        <label className="label">Reasoning model</label>
        <input value={draft.reasoningModel ?? ''} onChange={e => set('reasoningModel', e.target.value)} />
        <label className="label">Vision model (e.g. gemini-flash-3-preview routed through your OpenAI-compat proxy)</label>
        <input value={draft.visionModel ?? ''} onChange={e => set('visionModel', e.target.value)} />
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>CLIs</h3>
        <div className="row">
          <input value={draft.openclawPath ?? ''} onChange={e => set('openclawPath', e.target.value)} placeholder="Path to openclaw binary" style={{ flex: 1 }} />
          <button onClick={async () => { const p = await window.api.app.pickPath(); if (p) set('openclawPath', p); }}>Pick</button>
        </div>
        <div className="row">
          <input value={draft.claudeCodePath ?? ''} onChange={e => set('claudeCodePath', e.target.value)} placeholder="claude" style={{ flex: 1 }} />
          <button onClick={async () => { const p = await window.api.app.pickPath(); if (p) set('claudeCodePath', p); }}>Pick</button>
        </div>
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>UX</h3>
        <label><input type="checkbox" checked={!!draft.showThinking} onChange={e => set('showThinking', e.target.checked)} /> Show thinking pane</label>
        <label><input type="checkbox" checked={!!draft.quietMode} onChange={e => set('quietMode', e.target.checked)} /> Quiet / focus mode</label>
        <label><input type="checkbox" checked={!!draft.airgapped} onChange={e => set('airgapped', e.target.checked)} /> Air-gapped mode (blocks upgrade downloads)</label>
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>Upgrade Policy</h3>
        <label className="label">Allowed hosts (comma-separated)</label>
        <input
          value={(draft.policy?.allowlist ?? []).join(', ')}
          onChange={e => set('policy', { ...(draft.policy ?? {}), allowlist: e.target.value.split(',').map(x => x.trim()).filter(Boolean) })}
        />
        <label><input type="checkbox" checked={!!draft.policy?.requireSignature} onChange={e => set('policy', { ...(draft.policy ?? {}), requireSignature: e.target.checked })} /> Require signature</label>
        <label><input type="checkbox" checked={draft.policy?.autoScan !== false} onChange={e => set('policy', { ...(draft.policy ?? {}), autoScan: e.target.checked })} /> Auto-scan downloads</label>

        <label className="label">Ed25519 signing keys (one per line: <code>name|pem|&lt;PEM&gt;</code> or <code>name|hex|&lt;64 hex chars&gt;</code>)</label>
        <textarea
          rows={4}
          placeholder="release-key|hex|3a7f...&#10;build-key|pem|-----BEGIN PUBLIC KEY-----..."
          value={(draft.policy?.signingKeys ?? []).map((k: any) => `${k.name}|${k.format}|${k.key.replace(/\n/g, '\\n')}`).join('\n')}
          onChange={e => {
            const lines = e.target.value.split('\n').map(l => l.trim()).filter(Boolean);
            const keys = lines.map(line => {
              const [name, format, ...rest] = line.split('|');
              return { name, format, key: rest.join('|').replace(/\\n/g, '\n') };
            }).filter(k => k.name && (k.format === 'pem' || k.format === 'hex') && k.key);
            set('policy', { ...(draft.policy ?? {}), signingKeys: keys });
          }}
        />
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>Upgrade Feeds</h3>
        <label className="label">OpenClaw release feeds (GitHub <code>owner/repo</code>, comma-separated)</label>
        <input
          value={(draft.feeds?.openclaw ?? []).join(', ')}
          onChange={e => set('feeds', { ...(draft.feeds ?? {}), openclaw: e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean) })}
        />
        <label className="label">Self-upgrade feeds (Claw Deck itself)</label>
        <input
          value={(draft.feeds?.self ?? []).join(', ')}
          onChange={e => set('feeds', { ...(draft.feeds ?? {}), self: e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean) })}
        />
        <label className="label">GitHub token (optional; raises API rate limit)</label>
        <input type="password" value={draft.githubToken ?? ''} onChange={e => set('githubToken', e.target.value)} />
        <label className="label">VirusTotal API key (optional; enables hash reputation lookup)</label>
        <input type="password" value={draft.virusTotalApiKey ?? ''} onChange={e => set('virusTotalApiKey', e.target.value)} />
      </div>

      <div className="row">
        <button className="primary" onClick={() => save(draft)}>Save</button>
        <button onClick={() => setDraft(data)}>Revert</button>
      </div>
    </div>
  );
}
