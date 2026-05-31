import React, { useEffect, useMemo, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import { useConsole } from '../store/console';
import {
  MODEL_CATALOG, MCP_CATALOG, TOOL_CATALOG,
  searchModels, searchMcp, searchTools,
  ModelEntry, McpPreset, ToolPreset
} from '../lib/catalog';
import { formatBytes } from '../lib/vram';
import DeepScanReport from '../components/DeepScanReport';

type Section = 'models' | 'mcp' | 'tools';

interface PullState {
  running: boolean;
  status?: string;
  completed?: number;
  total?: number;
  error?: string;
}

interface ScanModalState { id: string; name: string; report: any; path?: string; }

export default function LibraryTab() {
  const { data: s, save } = useSettings();
  const setTab = useUI(u => u.setTab);
  const [section, setSection] = useState<Section>('models');
  const [q, setQ] = useState('');
  const [capFilter, setCapFilter] = useState<string>('all');
  const [installed, setInstalled] = useState<string[]>([]);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});
  const [scanningMcp, setScanningMcp] = useState<string | null>(null);
  const [scanModal, setScanModal] = useState<ScanModalState | null>(null);

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
    if (p.needsArg && extra) {
      if (p.needsArg.key === 'token') {
        if (p.needsArg.env) env[p.needsArg.env] = extra;
      } else {
        args.push(extra); // 'path' or 'arg' — positional
      }
    }
    const existing = s.mcpServers ?? [];
    const next = [...existing.filter((x: any) => x.name !== p.name), { name: p.name, command: p.command, args, env, enabled: true }];
    await save({ mcpServers: next });
  }

  // Fetch the real npm package and deep-scan it (vetting before you trust/run it).
  async function scanMcp(p: McpPreset) {
    if (!p.pkg) return;
    const id = 'mcp-' + p.name;
    setScanningMcp(p.name);
    try {
      const r = await window.api.extensions.install({ id, kind: p.pkg.kind, ref: p.pkg.ref });
      setScanModal(r.ok ? { id, name: p.name, report: r.report, path: r.path } : { id, name: p.name, report: { ok: false, error: r.reason } });
    } catch (e: any) {
      setScanModal({ id, name: p.name, report: { ok: false, error: e?.message ?? String(e) } });
    } finally {
      setScanningMcp(null);
    }
  }

  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="card col">
        <h2 style={{ margin: 0 }}>Library</h2>
        <div className="label">
          One-click installs for popular Ollama models, real Model-Context-Protocol servers, and the system tools
          they need. Models stream into Ollama; MCP presets land in Settings (and can be fetched + security-scanned
          first); system tools open the right installer.
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
          <div className="label">
            Real MCP servers. <strong>Add to Settings</strong> wires the server so it launches alongside your CLI
            sessions; <strong>Install &amp; scan</strong> fetches the actual npm package and runs the static security
            scanner over it first. Node servers run via <code>npx</code>; Python servers via <code>uvx</code> (install
            <code>uv</code> from System Tools).
          </div>
          {searchMcp(q).map(p => (
            <McpRow
              key={p.name}
              preset={p}
              installed={(s.mcpServers ?? []).some((x: any) => x.name === p.name)}
              scanning={scanningMcp === p.name}
              onAdd={addMcp}
              onScan={() => scanMcp(p)}
            />
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

      {scanModal && (
        <ScanModal state={scanModal} onClose={() => setScanModal(null)} />
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
          {isInstalled && (
            <button
              onClick={async () => {
                if (!confirm(`Delete ${variant} from disk? This frees space but you'll need to re-pull to use it again.`)) return;
                const r = await window.api.ollama.delete({ model: variant });
                if (!r.ok) alert('Delete failed: ' + (r.error || r.status));
              }}
              title="Remove this model file from disk via Ollama API"
              style={{ color: 'var(--bad)' }}
            >Delete</button>
          )}
        </div>
        {isInstalled && (
          <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
            <span className="label">Set as:</span>
            <button onClick={() => onAssign('chatModel', variant)} disabled={currentChat === variant} style={{ padding: '3px 8px', fontSize: 11 }} title="Use as default Chat model">chat{currentChat === variant ? ' ✓' : ''}</button>
            <button onClick={() => onAssign('reasoningModel', variant)} disabled={currentReasoning === variant} style={{ padding: '3px 8px', fontSize: 11 }} title="Use as Reasoning model (/reason)">reason{currentReasoning === variant ? ' ✓' : ''}</button>
            <button onClick={() => onAssign('visionModel', variant)} disabled={currentVision === variant} style={{ padding: '3px 8px', fontSize: 11 }} title="Use as Vision model (/vision)">vision{currentVision === variant ? ' ✓' : ''}</button>
          </div>
        )}
      </div>
    </div>
  );
}

function McpRow({ preset, installed, scanning, onAdd, onScan }: {
  preset: McpPreset;
  installed: boolean;
  scanning: boolean;
  onAdd: (p: McpPreset, extra: string) => void;
  onScan: () => void;
}) {
  const [extra, setExtra] = useState('');
  const ready = !preset.needsArg || extra.length > 0;
  return (
    <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 10, alignItems: 'flex-start' }}>
      <div className="col" style={{ flex: 1, gap: 4 }}>
        <div className="row">
          <strong>{preset.name}</strong>
          <span className="badge" style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}>
            {preset.runtime === 'python' ? 'python · uvx' : 'node · npx'}
          </span>
          {installed && <span className="badge ok">configured</span>}
          {preset.homepage && <a href={preset.homepage} target="_blank" rel="noreferrer" className="label">docs ↗</a>}
        </div>
        <div className="label" style={{ color: 'var(--text)' }}>{preset.description}</div>
        <div className="label"><code>{preset.command} {preset.args.join(' ')}{preset.needsArg && preset.needsArg.key !== 'token' ? ' <…>' : ''}</code></div>
        {preset.notes && <div className="label" style={{ color: 'var(--warn)' }}>{preset.notes}</div>}
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
        {preset.pkg && (
          <button onClick={onScan} disabled={scanning} title="Fetch the real npm package and run the static security scanner">
            {scanning ? 'Scanning…' : '🛡 Install & scan'}
          </button>
        )}
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
      const parts = preset.installCheck.split(/\s+/);
      const r = await window.api.runner.start({ backend: 'shell', binary: parts[0], args: parts.slice(1) });
      let done = false;
      const off = window.api.runner.onEvent(ev => {
        if (ev.id !== r.id) return;
        if (ev.kind === 'exit') {
          if (done) return; done = true;
          setPresent(ev.data === 0); setChecking(false); off();
        } else if (ev.kind === 'error') {
          if (done) return; done = true;
          setPresent(false); setChecking(false); off();
        }
      });
      setTimeout(() => { if (!done) { done = true; setChecking(false); setPresent(false); off(); } }, 4000);
    } catch {
      setPresent(false); setChecking(false);
    }
  }

  async function installWith(cmd: string, args: string[]) {
    const r = await window.api.runner.start({ backend: 'shell', binary: cmd, args });
    // Surface the install in the Console (instead of silently dropping the session).
    useConsole.getState().add({
      id: r.id, kind: 'tool', label: `${preset.name} install`,
      detail: `${cmd} ${args.join(' ')}`, startedAt: Date.now(), supportsInput: true,
      output: `[install ${preset.name}] ${cmd} ${args.join(' ')}\n`
    });
    useUI.getState().setTab('console');
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

function ScanModal({ state, onClose }: { state: ScanModalState; onClose: () => void }) {
  const [showAll, setShowAll] = useState(false);
  return (
    <div className="wizard-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={`Scan of ${state.name}`}>
      <div className="wizard" onClick={e => e.stopPropagation()} style={{ maxWidth: 820, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="col" style={{ flex: 1, gap: 2 }}>
            <h2 style={{ margin: 0 }}>🛡 Security scan — {state.name}</h2>
            {state.path && <div className="label" style={{ wordBreak: 'break-all' }}>Fetched to <code style={{ fontSize: 11 }}>{state.path}</code></div>}
          </div>
          <button onClick={onClose} title="Close">×</button>
        </div>
        <div style={{ marginTop: 12 }}>
          <DeepScanReport report={state.report} showAll={showAll} onToggleShowAll={() => setShowAll(s => !s)} />
        </div>
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          {state.path && (
            <>
              <button style={{ marginRight: 'auto' }} onClick={() => window.api.extensions.open(state.id)}>📂 Open folder</button>
              <button onClick={async () => { if (confirm('Delete the fetched files?')) { await window.api.extensions.uninstall(state.id); onClose(); } }} style={{ color: 'var(--bad)' }}>Delete files</button>
            </>
          )}
          <button className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
