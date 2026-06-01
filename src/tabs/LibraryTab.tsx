import React, { useEffect, useMemo, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import { useConsole } from '../store/console';
import {
  MODEL_CATALOG, MCP_CATALOG, TOOL_CATALOG, OPENCLAW_PLUGIN_CATALOG,
  searchModels, searchMcp, searchTools, searchOpenClawPlugins, openclawInstallRef,
  ModelEntry, McpPreset, ToolPreset, OpenClawPluginEntry
} from '../lib/catalog';
import { formatBytes } from '../lib/vram';
import { isRisky, toggleAllowlist } from '../lib/scanReview';
import DeepScanReport from '../components/DeepScanReport';

type Section = 'models' | 'mcp' | 'openclaw' | 'tools';

interface PullState {
  running: boolean;
  status?: string;
  completed?: number;
  total?: number;
  error?: string;
}

interface ScanModalState { id: string; name: string; report: any; path?: string; install?: () => void; installLabel?: string; }

export default function LibraryTab() {
  const { data: s, save } = useSettings();
  const setTab = useUI(u => u.setTab);
  const [section, setSection] = useState<Section>('models');
  const [q, setQ] = useState('');
  const [capFilter, setCapFilter] = useState<string>('all');
  const [installed, setInstalled] = useState<string[]>([]);
  const [pulls, setPulls] = useState<Record<string, PullState>>({});
  const [scanningKey, setScanningKey] = useState<string | null>(null);
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

  async function doAddMcp(p: McpPreset, extra: string) {
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

  // Adding an MCP server wires it to auto-run, so gate it behind a scan too
  // (node servers carry an npm `pkg` we can fetch + scan; uvx servers add direct).
  function addMcpGated(p: McpPreset, extra: string) {
    if (scanBeforeInstall && p.pkg) {
      scanSource('mcp-' + p.name, p.pkg.kind, p.pkg.ref, p.name, () => doAddMcp(p, extra), 'Add to Settings');
    } else {
      doAddMcp(p, extra);
    }
  }

  const scanBeforeInstall = s.scanBeforeInstall !== false;
  const blockRisky = s.blockRiskyInstalls !== false;
  const allowlist = new Set<string>(s.scanAllowlist ?? []);
  const toggleIgnore = (fp: string) => save({ scanAllowlist: toggleAllowlist(s.scanAllowlist ?? [], fp) });

  // Fetch the real source (npm pack / git clone) and deep-scan it. `install` is an
  // optional "do it for real" action shown in the modal (scan-gated install).
  async function scanSource(id: string, kind: 'npm' | 'github', ref: string, name: string, install?: () => void, installLabel?: string) {
    setScanningKey(id);
    try {
      const r = await window.api.extensions.install({ id, kind, ref });
      setScanModal(r.ok ? { id, name, report: r.report, path: r.path, install, installLabel } : { id, name, report: { ok: false, error: r.reason }, install, installLabel });
    } catch (e: any) {
      setScanModal({ id, name, report: { ok: false, error: e?.message ?? String(e) }, install, installLabel });
    } finally {
      setScanningKey(null);
    }
  }

  // Run the real OpenClaw CLI install; output streams to the Console.
  function runOpenclawInstall(entry: OpenClawPluginEntry) {
    const binary = s.openclawPath;
    if (!binary) { alert('Set the OpenClaw CLI path in Settings → CLIs first.'); return; }
    const ref = openclawInstallRef(entry.source);
    window.api.runner.start({ backend: 'openclaw', binary, args: ['plugins', 'install', ref] }).then(({ id }) => {
      useConsole.getState().add({
        id, kind: 'openclaw', label: `install ${entry.name}`,
        detail: `${binary} plugins install ${ref}`, startedAt: Date.now(), supportsInput: true,
        output: `[openclaw] plugins install ${ref}\n`
      });
      setTab('console');
    }).catch((e: any) => alert(`Failed to start OpenClaw: ${e.message}`));
  }

  // Install honoring the scan-before-install policy (fetch + scan the real source,
  // then install only on confirm). clawhub-sourced refs can't be source-fetched, so
  // they install directly.
  function installOpenClawPlugin(entry: OpenClawPluginEntry) {
    if (!s.openclawPath) { alert('Set the OpenClaw CLI path in Settings → CLIs first.'); return; }
    if (scanBeforeInstall && entry.source.kind !== 'clawhub') {
      scanSource('ocp-' + entry.id, entry.source.kind === 'npm' ? 'npm' : 'github', entry.source.ref, entry.name, () => runOpenclawInstall(entry));
    } else {
      runOpenclawInstall(entry);
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
          <button className={section === 'openclaw' ? 'primary' : ''} onClick={() => setSection('openclaw')}>
            🦞 OpenClaw Plugins ({OPENCLAW_PLUGIN_CATALOG.length})
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
              scanning={scanningKey === 'mcp-' + p.name}
              onAdd={addMcpGated}
              onScan={() => p.pkg && scanSource('mcp-' + p.name, p.pkg.kind, p.pkg.ref, p.name)}
            />
          ))}
        </div>
      )}

      {section === 'openclaw' && (
        <div className="card col">
          <div className="label">
            Real <a href="https://openclaw.ai/ecosystem" target="_blank" rel="noreferrer">OpenClaw</a> plugins, skills,
            and ecosystem tools (verified on GitHub). <strong>Install</strong> runs the real
            <code>openclaw plugins install git:…</code> (set the OpenClaw CLI path in Settings first) — and when
            <em>Security-scan before installing</em> is on (Settings → Install Security), it first clones + scans the
            source and only installs on your confirm. <strong>Fetch &amp; scan</strong> reviews the source any time.
            Discover more at <a href="https://clawhub.ai" target="_blank" rel="noreferrer">ClawHub</a> and{' '}
            <a href="https://openclawdir.com/plugins" target="_blank" rel="noreferrer">openclawdir.com</a>.
          </div>
          {searchOpenClawPlugins(q).map(entry => (
            <OpenClawPluginRow
              key={entry.id}
              entry={entry}
              scanning={scanningKey === 'ocp-' + entry.id}
              onInstall={() => installOpenClawPlugin(entry)}
              onScan={() => scanSource('ocp-' + entry.id, entry.source.kind === 'npm' ? 'npm' : 'github', entry.source.ref, entry.name)}
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
        <ScanModal state={scanModal} blockRisky={blockRisky} allowlist={allowlist} onToggleIgnore={toggleIgnore} onClose={() => setScanModal(null)} />
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

function OpenClawPluginRow({ entry, scanning, onInstall, onScan }: {
  entry: OpenClawPluginEntry;
  scanning: boolean;
  onInstall: () => void;
  onScan: () => void;
}) {
  const typeColor = entry.type === 'plugin' ? 'badge ok' : entry.type === 'skill' ? 'badge' : entry.type === 'distro' ? 'badge warn' : 'badge';
  return (
    <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 10, alignItems: 'flex-start' }}>
      <div className="col" style={{ flex: 1, gap: 4 }}>
        <div className="row">
          <strong>{entry.name}</strong>
          <span className={typeColor}>{entry.type}</span>
          {entry.license && <span className="label">{entry.license}</span>}
        </div>
        <div className="label" style={{ color: 'var(--text)' }}>{entry.description}</div>
        <div className="label"><code>{entry.source.kind}:{entry.source.ref}</code></div>
      </div>
      <div className="col" style={{ width: 230, gap: 6 }}>
        {entry.type === 'plugin' && (
          <button className="primary" onClick={onInstall} title={`openclaw plugins install ${openclawInstallRef(entry.source)}`}>
            ⬇ Install via OpenClaw
          </button>
        )}
        {entry.source.kind !== 'clawhub' && (
          <button onClick={onScan} disabled={scanning} title="Clone the repo and run the static security scanner">
            {scanning ? 'Scanning…' : '🛡 Fetch & scan'}
          </button>
        )}
        <a href={entry.homepage} target="_blank" rel="noreferrer" className="label">Repo ↗</a>
      </div>
    </div>
  );
}

function ScanModal({ state, onClose, blockRisky, allowlist, onToggleIgnore }: {
  state: ScanModalState; onClose: () => void; blockRisky?: boolean;
  allowlist?: ReadonlySet<string>; onToggleIgnore?: (fp: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const risky = isRisky(state.id, state.report?.findings ?? [], allowlist ?? new Set<string>());
  const blocked = risky && !!blockRisky;
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
          <DeepScanReport report={state.report} showAll={showAll} onToggleShowAll={() => setShowAll(s => !s)} allowlist={allowlist} onToggleIgnore={onToggleIgnore} scope={state.id} />
        </div>
        <div className="row" style={{ marginTop: 16, alignItems: 'center', gap: 8 }}>
          {state.path && (
            <>
              <button onClick={() => window.api.extensions.open(state.id)}>📂 Open folder</button>
              <button onClick={async () => { if (confirm('Delete the fetched files?')) { await window.api.extensions.uninstall(state.id); onClose(); } }} style={{ color: 'var(--bad)' }}>Delete files</button>
            </>
          )}
          {state.install && blocked && <span className="label" style={{ color: 'var(--bad)' }}>Blocked: critical/high findings (override in Settings → Install Security)</span>}
          <div style={{ flex: 1 }} />
          {state.install ? (
            <>
              <button onClick={onClose}>Cancel</button>
              <button
                className="primary"
                disabled={blocked}
                style={risky && !blocked ? { background: 'var(--bad)' } : undefined}
                onClick={() => { const fn = state.install!; onClose(); fn(); }}
                title={blocked ? 'Blocked by Install Security policy' : 'Proceed for real'}
              >
                {blocked ? '🚫 Blocked' : `${risky ? '⚠ ' : '⬇ '}${state.installLabel ?? 'Install'}${risky && !state.installLabel ? ' anyway' : ''}`}
              </button>
            </>
          ) : (
            <button className="primary" onClick={onClose}>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}
