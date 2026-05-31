import React, { useEffect, useMemo, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import { useConsole } from '../store/console';
import {
  MODEL_CATALOG, MCP_CATALOG, TOOL_CATALOG, OPENCLAW_LIB_CATALOG_FULL,
  searchModels, searchMcp, searchTools, searchOpenClawLibs, riskSummary,
  ModelEntry, McpPreset, ToolPreset, OpenClawLibEntry, SecurityAudit
} from '../lib/catalog';
import { formatBytes } from '../lib/vram';

type Section = 'models' | 'mcp' | 'tools' | 'openclaw';

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
  const [installedOpenclaw, setInstalledOpenclaw] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem('clawdeck:installedExtensions') ?? '[]'); } catch { return []; }
  });
  const [auditFor, setAuditFor] = useState<OpenClawLibEntry | null>(null);

  function persistInstalledOpenclaw(ids: string[]) {
    setInstalledOpenclaw(ids);
    try { localStorage.setItem('clawdeck:installedExtensions', JSON.stringify(ids)); } catch { /* ignore */ }
  }

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
          <button className={section === 'openclaw' ? 'primary' : ''} onClick={() => setSection('openclaw')}>
            🦞 OpenClaw Extensions ({OPENCLAW_LIB_CATALOG_FULL.length})
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

      {section === 'openclaw' && (
        <div className="card col">
          <div className="label">
            Community packs that extend OpenClaw with skills, prompts, tools, or integrations.
            Click <strong>Security audit</strong> on any row to review what it can access.
            <br />
            <em>Note:</em> these rows are a curated catalog. <strong>Track</strong> records your
            intent locally (so you can keep a shortlist and re-audit) — it does <strong>not</strong>{' '}
            download or install code. Install the package itself through OpenClaw / the CLI, then use{' '}
            <strong>Pick folder &amp; deep-scan</strong> in the audit to vet the installed source.
          </div>
          {searchOpenClawLibs(q).map(lib => (
            <OpenClawRow
              key={lib.id}
              entry={lib}
              installed={installedOpenclaw.includes(lib.id)}
              onAudit={() => setAuditFor(lib)}
              onInstall={() => {
                const next = installedOpenclaw.includes(lib.id) ? installedOpenclaw : [...installedOpenclaw, lib.id];
                persistInstalledOpenclaw(next);
              }}
              onUninstall={() => persistInstalledOpenclaw(installedOpenclaw.filter(x => x !== lib.id))}
            />
          ))}
        </div>
      )}

      {auditFor && (
        <AuditModal entry={auditFor} onClose={() => setAuditFor(null)} />
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
    // Register the session in the Console store so its output is visible, and
    // jump there so the user sees the install progress instead of nothing.
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

// ----------------------------------------------------------------------------

function riskBadgeClass(risk: SecurityAudit['risk']): string {
  if (risk === 'low') return 'badge ok';
  if (risk === 'medium') return 'badge warn';
  if (risk === 'high') return 'badge bad';
  return 'badge';
}

function OpenClawRow({ entry, installed, onAudit, onInstall, onUninstall }: {
  entry: OpenClawLibEntry;
  installed: boolean;
  onAudit: () => void;
  onInstall: () => void;
  onUninstall: () => void;
}) {
  return (
    <div className="row" style={{ borderTop: '1px solid var(--border)', paddingTop: 10, alignItems: 'flex-start' }}>
      <div className="col" style={{ flex: 1, gap: 4 }}>
        <div className="row">
          <strong>{entry.name}</strong>
          <span className="badge" style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}>{entry.category}</span>
          <span className={riskBadgeClass(entry.audit.risk)} title="Click Audit for full report">
            {entry.audit.risk} risk
          </span>
          <span className="label" title="Permissions surface">{riskSummary(entry.audit)}</span>
          {installed && <span className="badge ok" title="On your local shortlist">tracked</span>}
        </div>
        <div className="label" style={{ color: 'var(--text)' }}>{entry.description}</div>
        <div className="label">
          v{entry.version} · {entry.source.kind}:<code>{entry.source.ref}</code> · {entry.audit.license}
        </div>
      </div>
      <div className="col" style={{ width: 220, gap: 6 }}>
        <button onClick={onAudit} title="Show detailed security audit">🛡 Security audit</button>
        {installed
          ? <button onClick={onUninstall} title="Remove from your local shortlist">Untrack</button>
          : <button className="primary" onClick={onInstall} title="Add to your local shortlist (records the id locally; does not download or install code)">＋ Track</button>}
        {entry.homepage && <a href={entry.homepage} target="_blank" rel="noreferrer" className="label">Homepage ↗</a>}
      </div>
    </div>
  );
}

function AuditRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="row" style={{ gap: 8, alignItems: 'flex-start', borderBottom: '1px solid var(--border)', paddingBottom: 6 }}>
      <div className="label" style={{ width: 130, color: 'var(--muted)' }}>{k}</div>
      <div style={{ flex: 1, wordBreak: 'break-word' }}>{v}</div>
    </div>
  );
}

function AuditModal({ entry, onClose }: { entry: OpenClawLibEntry; onClose: () => void }) {
  const a = entry.audit;
  const [scanning, setScanning] = useState(false);
  const [report, setReport] = useState<any | null>(null);
  const [showAllFindings, setShowAllFindings] = useState(false);

  async function runDeepScan(picker: boolean) {
    setScanning(true);
    setReport(null);
    try {
      const r = picker
        ? await window.api.audit.pickAndScan()
        : await window.api.audit.scan(`${entry.id}`); // best-effort path; user usually wants picker
      setReport(r);
    } catch (e: any) {
      setReport({ ok: false, error: e?.message ?? String(e) });
    } finally {
      setScanning(false);
    }
  }

  return (
    <div
      className="wizard-backdrop"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Security audit for ${entry.name}`}
    >
      <div className="wizard" onClick={e => e.stopPropagation()} style={{ maxWidth: 820, maxHeight: '85vh', overflowY: 'auto' }}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div className="col" style={{ flex: 1, gap: 2 }}>
            <h2 style={{ margin: 0 }}>🛡 Security audit</h2>
            <div className="label">{entry.name} · v{entry.version}</div>
          </div>
          <span className={riskBadgeClass(a.risk)} style={{ fontSize: 14, padding: '4px 10px' }}>
            {a.risk.toUpperCase()} RISK
          </span>
          <button onClick={onClose} title="Close (Esc)">×</button>
        </div>

        <div className="col" style={{ gap: 6, marginTop: 12 }}>
          <AuditRow k="Source" v={<code>{entry.source.kind}:{entry.source.ref}</code>} />
          <AuditRow k="Maintainer" v={<code>{a.maintainer}</code>} />
          <AuditRow k="License" v={a.license} />
          <AuditRow k="Reviewed" v={`${a.reviewedAt} by ${a.reviewer}`} />
          <AuditRow k="Tarball hash" v={<code style={{ fontSize: 11 }}>{a.hash}</code>} />
          <AuditRow k="Dependencies" v={`${a.depCount} direct`} />
          <AuditRow
            k="Known CVEs"
            v={a.cves.length === 0
              ? <span className="badge ok">none</span>
              : <span className="badge bad">{a.cves.join(', ')}</span>}
          />
          <AuditRow
            k="Network"
            v={a.permissions.network === 'none'
              ? <span className="badge ok">no network</span>
              : <span className="badge warn">{a.permissions.network}</span>}
          />
          <AuditRow
            k="Filesystem"
            v={a.permissions.filesystem === 'none'
              ? <span className="badge ok">no fs access</span>
              : <span className={a.permissions.filesystem === 'read' ? 'badge' : 'badge warn'}>{a.permissions.filesystem}</span>}
          />
          <AuditRow
            k="Shell exec"
            v={a.permissions.shell
              ? <span className="badge warn">can spawn child processes</span>
              : <span className="badge ok">no shell</span>}
          />
          <AuditRow
            k="Secrets"
            v={a.permissions.secrets
              ? <span className="badge warn">reads env vars / credentials</span>
              : <span className="badge ok">no secret access</span>}
          />
        </div>

        {a.notes.length > 0 && (
          <div className="col" style={{ marginTop: 12, gap: 4 }}>
            <div className="label" style={{ color: 'var(--muted)' }}>Reviewer notes</div>
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {a.notes.map((n, i) => <li key={i} style={{ marginBottom: 4 }}>{n}</li>)}
            </ul>
          </div>
        )}

        <div className="col" style={{ marginTop: 16, gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <div className="row">
            <strong>Deep file scan</strong>
            <span className="label" style={{ color: 'var(--muted)' }}>
              Walks a folder for risky JS/TS patterns (eval, child_process, secret reads, obfuscation, exfil endpoints).
            </span>
          </div>
          <div className="row">
            <button onClick={() => runDeepScan(true)} disabled={scanning} className="primary">
              {scanning ? 'Scanning…' : '📂 Pick folder & deep-scan'}
            </button>
            <span className="label">Use this after npm-installing the package locally, or on any source tree.</span>
          </div>

          {report && <DeepScanReport report={report} showAll={showAllFindings} onToggleShowAll={() => setShowAllFindings(s => !s)} />}
        </div>

        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          {entry.homepage && (
            <a href={entry.homepage} target="_blank" rel="noreferrer" className="label" style={{ marginRight: 'auto' }}>
              View on homepage ↗
            </a>
          )}
          <button className="primary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function severityBadge(sev: string): string {
  if (sev === 'critical') return 'badge bad';
  if (sev === 'high') return 'badge bad';
  if (sev === 'medium') return 'badge warn';
  if (sev === 'low') return 'badge';
  return 'badge';
}

function DeepScanReport({ report, showAll, onToggleShowAll }: {
  report: any;
  showAll: boolean;
  onToggleShowAll: () => void;
}) {
  if (!report.ok) {
    return <div className="banner warn">Scan failed: {report.error ?? 'unknown error'}</div>;
  }
  const findings: any[] = report.findings ?? [];
  const summary = report.summary ?? {};
  const visible = showAll ? findings : findings.slice(0, 25);
  const worst = ['critical', 'high', 'medium', 'low', 'info'].find(s => (summary[s] ?? 0) > 0);

  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <span className="badge ok">{report.fileCount} files</span>
        <span className="badge">{Math.round((report.bytesScanned ?? 0) / 1024)} KB scanned</span>
        <span className="badge">{report.durationMs} ms</span>
        {summary.critical > 0 && <span className="badge bad">{summary.critical} critical</span>}
        {summary.high > 0 && <span className="badge bad">{summary.high} high</span>}
        {summary.medium > 0 && <span className="badge warn">{summary.medium} medium</span>}
        {summary.low > 0 && <span className="badge">{summary.low} low</span>}
        {summary.info > 0 && <span className="badge">{summary.info} info</span>}
        {findings.length === 0 && <span className="badge ok">no risky patterns matched</span>}
      </div>

      {report.manifest && (
        <div className="col" style={{ gap: 2, padding: 8, background: 'var(--panel-2)', borderRadius: 4 }}>
          <div className="label"><strong>{report.manifest.name ?? '(unnamed)'}</strong> v{report.manifest.version ?? '?'} · {report.manifest.license ?? 'no license'}</div>
          <div className="label" style={{ fontSize: 10, wordBreak: 'break-all' }}>{report.manifest.hash}</div>
          {report.manifest.scripts && Object.keys(report.manifest.scripts).length > 0 && (
            <div className="label">
              Scripts: {Object.keys(report.manifest.scripts).join(', ')}
              {(report.manifest.scripts.preinstall || report.manifest.scripts.install || report.manifest.scripts.postinstall) &&
                <span className="badge warn" style={{ marginLeft: 6 }}>lifecycle hook present</span>}
            </div>
          )}
          {report.manifest.dependencies && (
            <div className="label">{Object.keys(report.manifest.dependencies).length} runtime deps</div>
          )}
        </div>
      )}

      {findings.length > 0 && (
        <div className="col" style={{ gap: 4 }}>
          <div className="label" style={{ color: 'var(--muted)' }}>
            Findings (worst first; {showAll ? 'showing all' : `showing first ${visible.length} of ${findings.length}`})
          </div>
          {visible.map((f, i) => (
            <div key={i} className="col" style={{ padding: 6, borderLeft: `3px solid ${f.severity === 'critical' || f.severity === 'high' ? 'var(--bad)' : f.severity === 'medium' ? '#d4a017' : 'var(--muted)'}`, paddingLeft: 8, background: 'var(--panel-2)', gap: 2 }}>
              <div className="row">
                <span className={severityBadge(f.severity)}>{f.severity}</span>
                <code style={{ fontSize: 11 }}>{f.rule}</code>
                <span className="label" style={{ fontSize: 11 }}>{f.file}:{f.line}</span>
              </div>
              <code style={{ fontSize: 11, wordBreak: 'break-all', color: 'var(--text)' }}>{f.snippet}</code>
              <div className="label" style={{ fontSize: 11 }}>{f.reason}</div>
            </div>
          ))}
          {findings.length > visible.length && (
            <button onClick={onToggleShowAll} style={{ alignSelf: 'flex-start' }}>
              Show all {findings.length}
            </button>
          )}
          {showAll && findings.length > 25 && (
            <button onClick={onToggleShowAll} style={{ alignSelf: 'flex-start' }}>Collapse</button>
          )}
        </div>
      )}

      {findings.length === 0 && worst === undefined && (
        <div className="label" style={{ color: 'var(--ok)' }}>
          ✓ No matches for the built-in rule set. This is NOT proof the code is safe — only that the static checks didn't fire.
        </div>
      )}
    </div>
  );
}
