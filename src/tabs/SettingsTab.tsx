import React, { useEffect, useState } from 'react';
import { useSettings } from '../store/ui';

interface McpStatus {
  name: string; status: string; pid?: number; lastError?: string;
}

export default function SettingsTab() {
  const { data, save } = useSettings();
  const [draft, setDraft] = useState<any>(data);
  const [mcpStatuses, setMcpStatuses] = useState<McpStatus[]>([]);
  const [ollamaHealth, setOllamaHealth] = useState<'unknown' | 'ok' | 'bad'>('unknown');
  function set<K extends string>(k: K, v: any) { setDraft({ ...draft, [k]: v }); }

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      try {
        const list = await window.api.mcp.list();
        if (!cancelled) setMcpStatuses(list);
      } catch { /* ignore */ }
    }
    refresh();
    const t = setInterval(refresh, 3000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  async function probeOllama() {
    try {
      const r = await window.api.ollama.listModels(draft.ollamaUrl);
      setOllamaHealth(r.error ? 'bad' : 'ok');
    } catch { setOllamaHealth('bad'); }
  }

  function statusFor(name: string) { return mcpStatuses.find(s => s.name === name); }
  return (
    <div className="col">
      <div className="card col">
        <h3 style={{ margin: 0 }}>Ollama</h3>
        <label className="label">Ollama base URL</label>
        <div className="row">
          <input value={draft.ollamaUrl ?? ''} onChange={e => set('ollamaUrl', e.target.value)} style={{ flex: 1 }} />
          <button onClick={probeOllama}>Test connection</button>
          {ollamaHealth === 'ok' && <span className="badge ok">reachable</span>}
          {ollamaHealth === 'bad' && <span className="badge bad">unreachable</span>}
        </div>
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
        <label className="label">ClawHub CLI (for the Skills tab; <code>npm i -g clawhub</code>)</label>
        <div className="row">
          <input value={draft.clawhubPath ?? ''} onChange={e => set('clawhubPath', e.target.value)} placeholder="clawhub" style={{ flex: 1 }} />
          <button onClick={async () => { const p = await window.api.app.pickPath(); if (p) set('clawhubPath', p); }}>Pick</button>
        </div>
        <label className="label">Skills workspace (skills live under <code>&lt;dir&gt;/skills/</code>)</label>
        <div className="row">
          <input value={draft.skillsDir ?? ''} onChange={e => set('skillsDir', e.target.value)} placeholder="C:\\Users\\you\\openclaw-workspace" style={{ flex: 1 }} />
          <button onClick={async () => { const p = await window.api.app.pickPath({ properties: ['openDirectory'] }); if (p) set('skillsDir', p); }}>Pick</button>
        </div>
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>UX</h3>
        <label><input type="checkbox" checked={!!draft.showThinking} onChange={e => set('showThinking', e.target.checked)} /> Show thinking pane</label>
        <label><input type="checkbox" checked={!!draft.quietMode} onChange={e => set('quietMode', e.target.checked)} /> Quiet / focus mode</label>
        <label><input type="checkbox" checked={!!draft.airgapped} onChange={e => set('airgapped', e.target.checked)} /> Air-gapped mode (blocks upgrade downloads)</label>
        <label title="When on, clicking the window's X hides Claw Deck to the system tray instead of quitting. Right-click the tray icon to actually quit.">
          <input
            type="checkbox"
            checked={draft.closeToTray !== false}
            onChange={async e => {
              set('closeToTray', e.target.checked);
              try { await window.api.app.setCloseToTray(e.target.checked); } catch { /* ignore */ }
            }}
          /> Close to tray (keep running in background)
        </label>
        <div className="row">
          <button onClick={() => window.api.app.quit()} title="Fully quit the app (bypasses close-to-tray)">
            ⏻ Quit Claw Deck
          </button>
          <span className="label">Use this to fully exit when close-to-tray is on.</span>
        </div>
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>Recursive Self-Upgrade</h3>
        <div className="label">Controls how the "Reflect now" pipeline generates and applies patches to Claw Deck's own source.</div>
        <label className="label">Backend</label>
        <select
          value={draft.selfUpgrade?.backend || 'local'}
          onChange={e => set('selfUpgrade', { ...(draft.selfUpgrade || {}), backend: e.target.value })}
        >
          <option value="local">Local Ollama</option>
          <option value="remote">Remote OpenAI-compatible API</option>
          <option value="openclaw">OpenClaw (local OpenAI-compatible)</option>
        </select>
        {(draft.selfUpgrade?.backend || 'local') === 'local' && (
          <div className="row" style={{ gap: 6 }}>
            <input
              placeholder="http://localhost:11434"
              value={draft.selfUpgrade?.ollamaUrl ?? ''}
              onChange={e => set('selfUpgrade', { ...(draft.selfUpgrade || {}), ollamaUrl: e.target.value })}
              style={{ flex: 2 }}
            />
            <input
              placeholder="llama3.2"
              value={draft.selfUpgrade?.ollamaModel ?? ''}
              onChange={e => set('selfUpgrade', { ...(draft.selfUpgrade || {}), ollamaModel: e.target.value })}
              style={{ flex: 1 }}
            />
          </div>
        )}
        {draft.selfUpgrade?.backend === 'remote' && (
          <>
            <div className="row" style={{ gap: 6 }}>
              <input
                placeholder="https://api.openai.com/v1"
                value={draft.selfUpgrade?.remoteUrl ?? ''}
                onChange={e => set('selfUpgrade', { ...(draft.selfUpgrade || {}), remoteUrl: e.target.value })}
                style={{ flex: 2 }}
              />
              <input
                placeholder="gpt-4o-mini"
                value={draft.selfUpgrade?.remoteModel ?? ''}
                onChange={e => set('selfUpgrade', { ...(draft.selfUpgrade || {}), remoteModel: e.target.value })}
                style={{ flex: 1 }}
              />
            </div>
            <input
              type="password"
              placeholder="API key (stored locally only)"
              value={draft.selfUpgrade?.remoteKey ?? ''}
              onChange={e => set('selfUpgrade', { ...(draft.selfUpgrade || {}), remoteKey: e.target.value })}
            />
          </>
        )}
        {draft.selfUpgrade?.backend === 'openclaw' && (
          <div className="row" style={{ gap: 6 }}>
            <input
              placeholder="http://localhost:7531/v1"
              value={draft.selfUpgrade?.remoteUrl ?? ''}
              onChange={e => set('selfUpgrade', { ...(draft.selfUpgrade || {}), remoteUrl: e.target.value })}
              style={{ flex: 2 }}
            />
            <input
              placeholder="openclaw-default"
              value={draft.selfUpgrade?.remoteModel ?? ''}
              onChange={e => set('selfUpgrade', { ...(draft.selfUpgrade || {}), remoteModel: e.target.value })}
              style={{ flex: 1 }}
            />
          </div>
        )}
        <label className="label">Goal prompt</label>
        <textarea
          rows={2}
          value={draft.selfUpgrade?.goal ?? ''}
          onChange={e => set('selfUpgrade', { ...(draft.selfUpgrade || {}), goal: e.target.value })}
          placeholder="propose a small, safe improvement to code quality or test coverage"
        />
        <label title="When on and all gates pass, the patch promotes without a click. When off, you must click Apply after gates pass.">
          <input type="checkbox" checked={!!draft.selfUpgrade?.autoApply}
            onChange={e => set('selfUpgrade', { ...(draft.selfUpgrade || {}), autoApply: e.target.checked })} />
          {' '}Auto-apply when gates pass (advisory only — the pipeline already gates everything)
        </label>
        <label title="High-risk patches first run in a cloned tempdir; live tree only updated if that passes.">
          <input type="checkbox" checked={draft.selfUpgrade?.sandboxHighRisk !== false}
            onChange={e => set('selfUpgrade', { ...(draft.selfUpgrade || {}), sandboxHighRisk: e.target.checked })} />
          {' '}Stage high-risk patches in a sandbox clone first
        </label>
        <label className="label">Probe checks (the patched build must pass these before promotion)</label>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {['boot', 'db', 'tray', 'ollama', 'render', 'scan'].map(c => {
            const sel = draft.selfUpgrade?.probeChecks ?? [];
            const on = sel.includes(c);
            return (
              <label key={c}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={e => {
                    const next = e.target.checked
                      ? [...sel.filter((x: string) => x !== c), c]
                      : sel.filter((x: string) => x !== c);
                    set('selfUpgrade', { ...(draft.selfUpgrade || {}), probeChecks: next });
                  }}
                /> {c}
              </label>
            );
          })}
        </div>
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>Install Security</h3>
        <div className="label">Applies to Skills (ClawHub) and OpenClaw plugin installs.</div>
        <label title="Before installing, fetch the skill/plugin into a throwaway quarantine dir and run the static security scanner over its files. Nothing runs during the scan.">
          <input type="checkbox" checked={draft.scanBeforeInstall !== false} onChange={e => set('scanBeforeInstall', e.target.checked)} />
          {' '}Security-scan before installing
        </label>
        <label title="When a pre-install scan finds critical or high-severity matches, block the install entirely instead of just warning.">
          <input type="checkbox" checked={draft.blockRiskyInstalls !== false} onChange={e => set('blockRiskyInstalls', e.target.checked)} />
          {' '}Block installs with critical/high findings (otherwise warn + allow override)
        </label>
        <div className="row">
          <span className="label">{(draft.scanAllowlist?.length ?? 0)} ignored finding{(draft.scanAllowlist?.length ?? 0) === 1 ? '' : 's'} on the allowlist (known false-positives, set via the scan reports).</span>
          {(draft.scanAllowlist?.length ?? 0) > 0 && <button onClick={() => set('scanAllowlist', [])}>Clear allowlist</button>}
        </div>
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
        <label className="label">YARA rules file (optional; <code>.yar</code> / <code>.yara</code>, recursive)</label>
        <div className="row">
          <input value={draft.yaraRulesPath ?? ''} onChange={e => set('yaraRulesPath', e.target.value)} placeholder="path to rules file" style={{ flex: 1 }} />
          <button onClick={async () => { const p = await window.api.app.pickPath(); if (p) set('yaraRulesPath', p); }}>Pick</button>
        </div>
        <label className="label">YARA binary (optional override; defaults to <code>yara</code> on PATH)</label>
        <input value={draft.yaraBinary ?? ''} onChange={e => set('yaraBinary', e.target.value)} placeholder="yara" />
      </div>

      <div className="card col">
        <h3 style={{ margin: 0 }}>MCP Servers</h3>
        <div className="label">Configure Model Context Protocol servers to launch alongside CLI sessions. Running PIDs are passed to OpenClaw / Claude Code via <code>MCP_SERVERS_JSON</code>.</div>
        <div className="row">
          <button className="primary" onClick={async () => { await save(draft); const r = await window.api.mcp.startAll(); console.log('startAll', r); }} title="Save settings then spawn every enabled MCP server">
            ▶ Save & Start All
          </button>
          <button onClick={async () => { const r = await window.api.mcp.stopAll(); console.log('stopAll', r); }} title="Kill every running MCP child process">
            ■ Stop All
          </button>
          <span className="label">{mcpStatuses.filter(s => s.status === 'running').length} running / {mcpStatuses.length} configured</span>
        </div>
        {(draft.mcpServers ?? []).map((srv: any, i: number) => {
          const st = statusFor(srv.name);
          return (
          <div key={i} className="row" style={{ gap: 6, alignItems: 'flex-start', borderTop: '1px solid #1c2030', paddingTop: 8 }}>
            <div className="col" style={{ flex: 1, gap: 4 }}>
              <div className="row">
                <input placeholder="name" value={srv.name ?? ''} onChange={e => {
                  const next = [...draft.mcpServers]; next[i] = { ...srv, name: e.target.value }; set('mcpServers', next);
                }} style={{ flex: 1 }} />
                {st?.status === 'running' && <span className="badge ok">running · pid {st.pid}</span>}
                {st?.status === 'exited' && <span className="badge warn">exited</span>}
                {st?.status === 'error' && <span className="badge bad">error</span>}
                {st?.status === 'stopped' && <span className="badge" style={{ background: 'var(--panel-2)', color: 'var(--muted)' }}>stopped</span>}
              </div>
              <input placeholder="command (e.g. npx)" value={srv.command ?? ''} onChange={e => {
                const next = [...draft.mcpServers]; next[i] = { ...srv, command: e.target.value }; set('mcpServers', next);
              }} />
              <input placeholder="args (space-separated; quote with double quotes)"
                value={Array.isArray(srv.args) ? srv.args.join(' ') : ''}
                onChange={e => {
                  const args = e.target.value.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(s => s.replace(/^"|"$/g, '')) ?? [];
                  const next = [...draft.mcpServers]; next[i] = { ...srv, args }; set('mcpServers', next);
                }}
              />
              {st?.lastError && <div className="label" style={{ color: 'var(--bad)' }}>{st.lastError.slice(0, 200)}</div>}
              <label className="label" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={srv.enabled !== false} onChange={e => {
                  const next = [...draft.mcpServers]; next[i] = { ...srv, enabled: e.target.checked }; set('mcpServers', next);
                }} /> enabled
              </label>
            </div>
            <div className="col" style={{ gap: 4 }}>
              {st?.status === 'running'
                ? <button onClick={() => window.api.mcp.stop(srv.name)} title="Kill this server">Stop</button>
                : <button onClick={async () => { await save(draft); window.api.mcp.start(srv.name); }} title="Save then start">Start</button>}
              <button onClick={() => {
                const next = [...draft.mcpServers]; next.splice(i, 1); set('mcpServers', next);
              }} title="Remove from config">×</button>
            </div>
          </div>
        );})}
        <button onClick={() => set('mcpServers', [...(draft.mcpServers ?? []), { name: '', command: '', args: [], enabled: true }])}>+ Add MCP server</button>
      </div>

      <div className="row">
        <button className="primary" onClick={() => save(draft)}>Save</button>
        <button onClick={() => setDraft(data)}>Revert</button>
      </div>
    </div>
  );
}
