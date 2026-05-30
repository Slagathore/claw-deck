import React, { useEffect, useMemo, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import {
  MODEL_CATALOG, MCP_CATALOG, TOOL_CATALOG,
  searchModels, searchMcp, searchTools,
  ModelEntry, McpPreset, ToolPreset
} from '../lib/catalog';
import { formatBytes } from '../lib/vram';

type Section = 'models' | 'mcp' | 'tools';

interface PullState {
  running: boolean;
  status?: string;
  completed?: number;
  total?: number;
  error?: string;
}

export default function LibraryTab() {
  const { data: s, save } = useSettings();
  const setTab = useUI(u => u.setTab);
  const [section, setSection] = useState<Section>('models');
  const [q, setQ] = useState('');
  const [capFilter, setCapFilter] = useState<string>('all');
  const [installed, setInstalled] = useState<string[]>([]);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});

  // Refresh installed model list periodically.
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const r = await window.api.ollama.listModels(s.ollamaUrl);
        if (!cancelled) setInstalled(r.models ?? []);
      } catch { /* ignore */ }
    }
    refresh();
    const t = setInterval(refresh, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [s.ollamaUrl]);

  // Subscribe to pull-progress events.
  useEffect(() => {
    const off = window.api.ollama.onPullProgress(ev => {
      setPulls(p => ({
        ...p,
        [ev.id]: {
          running: ev.status !== 'done' && ev.status !== 'error',
          status: ev.status,
          completed: ev.completed,
          total: ev.total,
          error: ev.error
        }
      }));
    });
    return off;
  }, []);

  const modelMatches = useMemo(() => {
    let xs = searchModels(q);
    if (capFilter !== 'all') xs = xs.filter(m => m.capabilities.includes(capFilter as any));
    return xs;
  }, [q, capFilter]);

  async function pullModel(model: string) {
    setPulls(p => ({ ...p, [model]: { running: true, status: 'starting' } }));
    await window.api.ollama.pull({ baseUrl: s.ollamaUrl, model, id: model });
  }

  async function setAs(slot: 'chatModel' | 'reasoningModel' | 'visionModel', model: string) {
    await save({ [slot]: model });
  }

  async function addMcp(p: McpPreset, extra: string) {
    const args = [...p.args];
    const env: Record<string, string> = {};
    if (p.needsArg?.key === 'path' && extra) args.push(extra);
    if (p.needsArg?.key === 'token' && extra) {
      const envKey = p.needsArg.label.split(' ')[0]; // e.g. "GITHUB_PERSONAL_ACCESS_TOKEN"
      env[envKey] = extra;
    }
    const existing = s.mcpServers ?? [];
    const next = [...existing.filter((x: any) => x.name !== p.name), { name: p.name, command: p.command, args, env, enabled: true }];
    await save({ mcpServers: next });
  }

  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="card col">
        <h2 style={{ margin: 0 }}>Library</h2>
        <div className="label">
          One-click installs for the most common models, MCP servers, and tools.
          Models stream into Ollama; MCP presets land in Settings; system tools open the right install page.
        </div>
        <div className="row">
          <button className={section === 'models' ? 'primary' : ''} onClick={() => setSection('models')}>
            📦 Models ({MODEL_CATALOG.length})
          </button>
          <button className={section === 'mcp' ? 'primary' : ''} onClick={() => setSection('mcp')}>
            🔌 MCP Servers ({MCP_CATALOG.length})
          </button>
          <button className={section === 'tools' ? 'primary' : ''} onClick={() => setSection('tools')}>
            🛠 System Tools ({TOOL_CATALOG.length})
          </button>
          <div style={{ flex: 1 }} />
          <input
            placeholder={`Search ${section}…`}
            value={q}
            onChange={e => setQ(e.target.value)}
            style={{ minWidth: 240 }}
          />
        </div>

        {section === 'models' && (
          <div className="row">
            <span className="label">Filter:</span>
            {['all', 'chat', 'reasoning', 'vision', 'code', 'embed'].map(c => (
              <button key={c} onClick={() => setCapFilter(c)} className={capFilter === c ? 'primary' : ''} style={{ padding: '4px 10px', fontSize: 12 }}>
                {c}
              </button>
            ))}
          </div>
        )}
      </div>

      {section === 'models' && (
        <div className="card col">
          {modelMatches.length === 0 && <div className="label">No models match.</div>}
          {modelMatches.map(m => (
            <ModelRow
              key={m.name}
              entry={m}
              installed={installed}
              pull={pulls[m.name]}
              currentChat={s.chatModel}
              currentReasoning={s.reasoningModel}
              currentVision={s.visionModel}
              onPull={pullModel}
              onAssign={setAs}
              onGoToChat={() => setTab('chat')}
            />
          ))}
        </div>
      )}

      {section === 'mcp' && (
        <div className="card col">
          {searchMcp(q).map(p => (
            <McpRow key={p.name} preset={p} installed={(s.mcpServers ?? []).some((x: any) => x.name === p.name)} onAdd={addMcp} />
          ))}
        </div>
      )}

      {section === 'tools' && (
        <div className="card col">
          {searchTools(q).map(p => (
            <ToolRow key={p.name} preset={p} />
          ))}
        </div>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------

function ModelRow({ entry, installed, pull, currentChat, currentReasoning, currentVision, onPull, onAssign, onGoToChat }: {
  entry: ModelEntry;
  installed: string[];
  pull?: PullState;
  currentChat?: string; currentReasoning?: string; currentVision?: string;
  onPull: (m: string) => void;
  onAssign: (slot: 'chatModel' | 'reasoningModel' | 'visionModel', m: string) => void;
  onGoToChat: () => void;
}) {
  const [variant, setVariant] = useState<string>(entry.name);
  const isInstalled = installed.some(n => n === variant || n.startsWith(variant + ':'));
  const inProgress = pull?.running;
  const pct = pull?.completed && pull?.total ? Math.round((pull.completed / pull.total) * 100) : null;

  return (
    <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 10, alignItems: 'flex-start' }}>
      <div className="col" style={{ flex: 1, gap: 4 }}>
        <div className="row">
          <strong>{entry.name}</strong>
          <span className="label">{entry.paramsB}B · ~{entry.sizeGb} GB</span>
          {entry.capabilities.map(c => <span key={c} className="badge ok" style={{ background: 'rgba(124,156,255,.15)', color: 'var(--accent)' }}>{c}</span>)}
          {isInstalled && <span className="badge ok">installed</span>}
        </div>
        <div className="label" style={{ color: 'var(--text)' }}>{entry.description}</div>
        {inProgress && (
          <div className="label">
            {pull?.status ?? 'pulling…'}
            {pct !== null && ` — ${pct}% (${formatBytes(pull?.completed)}/${formatBytes(pull?.total)})`}
          </div>
        )}
        {pull?.error && <div className="banner">Pull failed: {pull.error}</div>}
      </div>
      <div className="col" style={{ width: 280, gap: 6 }}>
        {entry.variants && entry.variants.length > 0 && (
          <select value={variant} onChange={e => setVariant(e.target.value)}>
            <option value={entry.name}>{entry.name} (default)</option>
            {entry.variants.map(v => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
        <div className="row">
          <button onClick={() => onPull(variant)} disabled={inProgress} className="primary" style={{ flex: 1 }}>
            {inProgress ? 'Pulling…' : isInstalled ? 'Re-pull' : 'Pull'}
          </button>
          {isInstalled && <button onClick={onGoToChat} title="Open Chat tab">→ Chat</button>}
        </div>
        {isInstalled && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
            <span className="label">Set as:</span>
            <button
              onClick={() => onAssign('chatModel', variant)}
              disabled={currentChat === variant}
              style={{ padding: '3px 8px', fontSize: 11 }}
              title="Use as default Chat model"
            >chat{currentChat === variant ? ' ✓' : ''}</button>
            <button
              onClick={() => onAssign('reasoningModel', variant)}
              disabled={currentReasoning === variant}
              style={{ padding: '3px 8px', fontSize: 11 }}
              title="Use as Reasoning model (/reason)"
            >reason{currentReasoning === variant ? ' ✓' : ''}</button>
            <button
              onClick={() => onAssign('visionModel', variant)}
              disabled={currentVision === variant}
              style={{ padding: '3px 8px', fontSize: 11 }}
              title="Use as Vision model (/vision)"
            >vision{currentVision === variant ? ' ✓' : ''}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function McpRow({ preset, installed, onAdd }: { preset: McpPreset; installed: boolean; onAdd: (p: McpPreset, extra: string) => void }) {
  const [extra, setExtra] = useState('');
  const ready = !preset.needsArg || extra.length > 0;
  return (
    <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 10, alignItems: 'flex-start' }}>
      <div className="col" style={{ flex: 1, gap: 4 }}>
        <div className="row">
          <strong>{preset.name}</strong>
          {installed && <span className="badge ok">configured</span>}
          {preset.homepage && <a href={preset.homepage} target="_blank" rel="noreferrer" className="label">docs ↗</a>}
        </div>
        <div className="label" style={{ color: 'var(--text)' }}>{preset.description}</div>
        <div className="label"><code>{preset.command} {preset.args.join(' ')}</code></div>
      </div>
      <div className="col" style={{ width: 280, gap: 6 }}>
        {preset.needsArg && (
          <>
            <label className="label">{preset.needsArg.label}</label>
            <div className="row">
              <input
                value={extra}
                onChange={e => setExtra(e.target.value)}
                placeholder={preset.needsArg.placeholder}
                style={{ flex: 1 }}
                type={preset.needsArg.key === 'token' ? 'password' : 'text'}
              />
              {preset.needsArg.key === 'path' && (
                <button onClick={async () => { const p = await window.api.app.pickPath({ properties: ['openDirectory'] }); if (p) setExtra(p); }}>Pick</button>
              )}
            </div>
          </>
        )}
        <button className="primary" disabled={!ready} onClick={() => onAdd(preset, extra)}>
          {installed ? 'Update in Settings' : 'Add to Settings'}
        </button>
      </div>
    </div>
  );
}

function ToolRow({ preset }: { preset: ToolPreset }) {
  const [checking, setChecking] = useState(false);
  const [present, setPresent] = useState<boolean | null>(null);

  async function check() {
    setChecking(true);
    try {
      // Probe via a shell runner — we just spawn the binary with --version and watch exit code.
      const parts = preset.installCheck.split(/\s+/);
      const r = await window.api.runner.start({ backend: 'shell', binary: parts[0], args: parts.slice(1) });
      let done = false;
      const off = window.api.runner.onEvent(ev => {
        if (ev.id !== r.id) return;
        if (ev.kind === 'exit') {
          if (done) return; done = true;
          setPresent(ev.data === 0);
          setChecking(false);
          off();
        } else if (ev.kind === 'error') {
          if (done) return; done = true;
          setPresent(false);
          setChecking(false);
          off();
        }
      });
      // 4-second safety timeout.
      setTimeout(() => { if (!done) { done = true; setChecking(false); setPresent(false); off(); } }, 4000);
    } catch {
      setPresent(false);
      setChecking(false);
    }
  }

  async function installWith(cmd: string, args: string[]) {
    const r = await window.api.runner.start({ backend: 'shell', binary: cmd, args });
    // The Run a CLI tab will show stdout if user navigates there; we just kick it off.
    return r.id;
  }

  return (
    <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 10, alignItems: 'flex-start' }}>
      <div className="col" style={{ flex: 1, gap: 4 }}>
        <div className="row">
          <strong>{preset.name}</strong>
          {present === true && <span className="badge ok">installed</span>}
          {present === false && <span className="badge bad">not found</span>}
        </div>
        <div className="label" style={{ color: 'var(--text)' }}>{preset.description}</div>
        <div className="label">Probe: <code>{preset.installCheck}</code></div>
      </div>
      <div className="col" style={{ width: 280, gap: 6 }}>
        <button onClick={check} disabled={checking}>{checking ? 'Checking…' : 'Check if installed'}</button>
        {preset.install.winget && (
          <button className="primary" onClick={() => installWith('winget', ['install', '--id', preset.install.winget!, '-e', '--accept-source-agreements', '--accept-package-agreements'])}>
            Install via winget
          </button>
        )}
        {preset.install.choco && (
          <button onClick={() => installWith('choco', ['install', preset.install.choco!, '-y'])}>
            Install via choco
          </button>
        )}
        <a href={preset.install.manualUrl} target="_blank" rel="noreferrer" className="label">Manual download ↗</a>
      </div>
    </div>
  );
}
