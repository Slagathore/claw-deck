import React, { useEffect, useRef, useState } from 'react';
import { useSettings } from '../store/ui';
import { useConsole, type SessionKind } from '../store/console';
import { parseArgs } from '../lib/cliargs';
import TerminalView from '../components/TerminalView';

/**
 * Unified Console — merges the former "Run a CLI" and "Terminal" tabs.
 *
 * Sources:
 *   - AI CLIs : OpenClaw / Claude Code (binary from Settings)
 *   - Shells  : PowerShell / cmd / Git Bash / WSL / gh (detected) + custom binary
 *
 * Every source streams stdout/stderr live, accepts stdin via the input bar, and
 * supports Stop/Close. Shells & custom binaries additionally support an elevated
 * (UAC) launch that opens in its own Windows console. MCP servers configured in
 * Settings are surfaced here too, since their PIDs are passed to spawned CLIs.
 */

interface Shell {
  id: string;
  label: string;
  binary: string;
  args: string[];
  available: boolean;
}

type SourceId = 'openclaw' | 'claude' | 'custom' | string; // string = shell preset id

export default function ConsoleTab() {
  const { data: s } = useSettings();
  const { sessions, activeId, setActive, add, remove } = useConsole();

  const [shells, setShells] = useState<Shell[]>([]);
  const [source, setSource] = useState<SourceId>('openclaw');
  const [argsLine, setArgsLine] = useState('');
  const [customBinary, setCustomBinary] = useState('');
  const [cwd, setCwd] = useState('');
  const [elevated, setElevated] = useState(false);
  const [input, setInput] = useState('');
  const [mcp, setMcp] = useState<{ name: string; status: string; pid?: number; lastError?: string; enabled: boolean }[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.api.terminal.shells().then(list => setShells(list)).catch(() => setShells([]));
  }, []);

  async function reloadMcp() {
    try { setMcp((await window.api.mcp.list()) as any); } catch { /* ignore */ }
  }
  useEffect(() => {
    reloadMcp();
    const t = setInterval(reloadMcp, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [sessions, activeId]);

  const isAiCli = source === 'openclaw' || source === 'claude';
  const isCustom = source === 'custom';
  const pickedShell = shells.find(sh => sh.id === source);
  // Elevation only applies to shells / custom binaries (AI CLIs stream in-app).
  const canElevate = !isAiCli;

  function resolveLaunch(): { kind: SessionKind; binary: string; args: string[]; label: string } | null {
    const extraArgs = parseArgs(argsLine);
    if (source === 'openclaw') {
      const binary = s.openclawPath || '';
      if (!binary) { alert('No path set for OpenClaw. Configure it in Settings → CLIs.'); return null; }
      return { kind: 'openclaw', binary, args: extraArgs, label: 'openclaw' };
    }
    if (source === 'claude') {
      const binary = s.claudeCodePath || 'claude';
      return { kind: 'claude', binary, args: extraArgs, label: 'claude' };
    }
    if (isCustom) {
      if (!customBinary.trim()) { alert('Fill in a custom binary path or name.'); return null; }
      const label = customBinary.trim().split(/[\\/]/).pop() || 'custom';
      return { kind: 'shell', binary: customBinary.trim(), args: extraArgs, label };
    }
    // shell preset
    if (!pickedShell || !pickedShell.available) { alert('Shell not available. Pick another preset or use a custom binary.'); return null; }
    return { kind: 'shell', binary: pickedShell.binary, args: [...pickedShell.args, ...extraArgs], label: pickedShell.label };
  }

  async function start() {
    const r = resolveLaunch();
    if (!r) return;

    if (elevated && canElevate) {
      const res = await window.api.terminal.launchElevated({ binary: r.binary, args: r.args, cwd: cwd || undefined });
      if (!res.ok) alert(`Elevated launch failed: ${res.reason || 'unknown'}`);
      else {
        // Elevated processes run detached in their own console; record a note-only session.
        add({
          id: `elevated-${Date.now()}`, kind: r.kind, label: `${r.label} (elevated)`,
          detail: `${r.binary} ${r.args.join(' ')}`, cwd: cwd || undefined,
          startedAt: Date.now(), exited: 0, supportsInput: false,
          output: `[launched elevated in a separate Windows console — output is not captured here]\n`
        });
      }
      return;
    }

    try {
      const backend = isAiCli ? r.kind : 'shell';
      // Shells & custom binaries get a real pseudo-terminal (rendered with xterm);
      // AI CLIs / tools stay piped (rendered in a <pre> with the input bar).
      const wantPty = !isAiCli;
      const res = await window.api.runner.start({ backend, binary: r.binary, args: r.args, cwd: cwd || undefined, pty: wantPty });
      add({
        id: res.id, kind: r.kind, label: r.label,
        detail: `${r.binary} ${r.args.join(' ')}`.trim(), cwd: cwd || undefined,
        startedAt: Date.now(), supportsInput: true, pty: !!res.pty,
        output: res.pty ? '' : `[start] ${r.binary} ${r.args.join(' ')}\n`
      });
    } catch (e: any) {
      alert(`Failed to start: ${e.message}`);
    }
  }

  async function send() {
    const active = sessions.find(x => x.id === activeId);
    if (!active || !input.trim() || active.exited != null) return;
    const text = input;
    setInput('');
    // Optimistically echo into the session output.
    useConsole.getState().handleEvent({ id: active.id, kind: 'stdout', data: `\n> ${text}\n` });
    await window.api.runner.input(active.id, text);
  }

  async function stop(id: string) { await window.api.runner.stop(id); }

  const active = sessions.find(x => x.id === activeId) ?? null;

  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="card col">
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <select value={source} onChange={e => setSource(e.target.value)} style={{ minWidth: 220 }}>
            <optgroup label="AI CLIs">
              <option value="openclaw">OpenClaw</option>
              <option value="claude">Claude Code</option>
            </optgroup>
            <optgroup label="Shells">
              {shells.map(sh => (
                <option key={sh.id} value={sh.id} disabled={!sh.available}>{sh.label}</option>
              ))}
              <option value="custom">Custom binary…</option>
            </optgroup>
          </select>

          {isCustom ? (
            <>
              <input placeholder="binary path or name" value={customBinary} onChange={e => setCustomBinary(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
              <button onClick={async () => { const p = await window.api.app.pickPath(); if (p) setCustomBinary(p); }}>Pick</button>
            </>
          ) : (
            <code className="label" title={isAiCli ? undefined : pickedShell?.binary} style={{ flex: 1, minWidth: 120 }}>
              {isAiCli
                ? (source === 'openclaw' ? (s.openclawPath || '(set OpenClaw path in Settings)') : (s.claudeCodePath || 'claude'))
                : (pickedShell?.binary || '(no preset)')}
            </code>
          )}

          <input
            placeholder='args (space-separated, "quote spaces")'
            value={argsLine}
            onChange={e => setArgsLine(e.target.value)}
            style={{ flex: 1, minWidth: 160 }}
          />
          <input placeholder="cwd (optional)" value={cwd} onChange={e => setCwd(e.target.value)} style={{ width: 220 }} />
          <button onClick={async () => { const p = await window.api.app.pickPath({ properties: ['openDirectory'] }); if (p) setCwd(p); }}>Pick cwd</button>

          {canElevate && (
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title="Spawns a separate elevated console window (UAC prompt). Output won't stream back into Claw Deck.">
              <input type="checkbox" checked={elevated} onChange={e => setElevated(e.target.checked)} /> Elevated
            </label>
          )}
          <button className="primary" onClick={start}>Start</button>
        </div>

        <div className="label">
          Streamed sessions accept further input via the bar below. Elevated launches open in their own
          Windows console (UAC) and aren't captured here.
        </div>

        <div className="row" style={{ flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          <span className="label">MCP:</span>
          {mcp.length === 0 && <span className="label">none configured</span>}
          {mcp.map(m => (
            <span key={m.name} className={`badge ${m.status === 'running' ? 'ok' : m.status === 'error' ? 'bad' : ''}`} title={m.lastError || ''}>
              {m.name}:{m.status}{m.pid ? ` (${m.pid})` : ''}
            </span>
          ))}
          {mcp.some(m => m.status !== 'running' && m.enabled) && (
            <button onClick={async () => { await window.api.mcp.startAll(); reloadMcp(); }}>Start all</button>
          )}
          {mcp.filter(m => m.status === 'running').map(m => (
            <button key={'stop-' + m.name} onClick={async () => { await window.api.mcp.stop(m.name); reloadMcp(); }}>Stop {m.name}</button>
          ))}
        </div>
      </div>

      <div className="card col" style={{ flex: 1, overflow: 'hidden' }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {sessions.length === 0 && <div className="label">No sessions yet. Pick a source above and click Start.</div>}
          {sessions.map(sess => (
            <button
              key={sess.id}
              className={sess.id === activeId ? 'tab-btn active' : 'tab-btn'}
              onClick={() => setActive(sess.id)}
              style={{ padding: '4px 10px' }}
              title={sess.detail || sess.label}
            >
              <span className={`badge ${sess.exited == null ? 'ok' : sess.exited === 0 ? 'ok' : 'bad'}`}>
                {sess.exited == null ? 'running' : `exit ${sess.exited}`}
              </span>{' '}
              {sess.label.split(' ')[0]} · {sess.id.slice(0, 6)}
            </button>
          ))}
        </div>

        {active && (
          <>
            <div className="row">
              <span className="label" title={active.detail}>
                {active.pty && <span className="badge ok" style={{ marginRight: 6 }}>pty</span>}
                {active.detail || active.label}{active.cwd ? ` @ ${active.cwd}` : ''}
              </span>
              <div style={{ flex: 1 }} />
              {active.exited == null && <button onClick={() => stop(active.id)}>Stop</button>}
              <button onClick={() => remove(active.id)}>Close</button>
            </div>
            {active.pty ? (
              <TerminalView key={active.id} session={active} />
            ) : (
              <>
                <pre style={{
                  flex: 1, overflow: 'auto', background: 'var(--panel-2)',
                  borderRadius: 6, padding: 10, margin: 0,
                  fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', minHeight: 200
                }}>
                  {active.output}
                  <div ref={bottomRef} />
                </pre>
                {active.supportsInput && (
                  <div className="row">
                    <input
                      placeholder="type input + Enter (piped to the process stdin)"
                      value={input}
                      onChange={e => setInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
                      disabled={active.exited != null}
                      style={{ flex: 1, fontFamily: 'Cascadia Code, Consolas, monospace' }}
                    />
                    <button onClick={send} disabled={active.exited != null || !input.trim()}>Send</button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
