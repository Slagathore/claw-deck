import React, { useEffect, useRef, useState } from 'react';

interface Shell {
  id: string;
  label: string;
  binary: string;
  args: string[];
  available: boolean;
}

interface Session {
  id: string;
  shellId: string;
  label: string;
  cwd?: string;
  startedAt: number;
  exited?: number | null;
  output: string;
  elevated?: boolean;
}

export default function TerminalTab() {
  const [shells, setShells] = useState<Shell[]>([]);
  const [shellId, setShellId] = useState<string>('pwsh');
  const [customBinary, setCustomBinary] = useState('');
  const [customArgs, setCustomArgs] = useState('');
  const [cwd, setCwd] = useState('');
  const [elevated, setElevated] = useState(false);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const offRef = useRef<null | (() => void)>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    window.api.terminal.shells().then(s => setShells([...s, { id: 'custom', label: 'Custom binary…', binary: '', args: [], available: true }]));
  }, []);

  useEffect(() => {
    offRef.current?.();
    offRef.current = window.api.runner.onEvent((ev: any) => {
      setSessions(prev => prev.map(sess => {
        if (sess.id !== ev.id) return sess;
        if (ev.kind === 'stdout' || ev.kind === 'stderr') return { ...sess, output: sess.output + ev.data };
        if (ev.kind === 'error') return { ...sess, output: sess.output + `\n[error] ${ev.data}\n` };
        if (ev.kind === 'exit') return { ...sess, exited: ev.data, output: sess.output + `\n[exit ${ev.data}]\n` };
        return sess;
      }));
    });
    return () => { offRef.current?.(); };
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [sessions, activeId]);

  const picked = shells.find(s => s.id === shellId);

  function resolveLaunch(): { binary: string; args: string[]; label: string } | null {
    if (shellId === 'custom') {
      if (!customBinary.trim()) return null;
      const args = customArgs.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(s => s.replace(/^"|"$/g, '')) ?? [];
      return { binary: customBinary.trim(), args, label: customBinary.trim().split(/[\\/]/).pop() || 'custom' };
    }
    if (!picked || !picked.available) return null;
    return { binary: picked.binary, args: picked.args, label: picked.label };
  }

  async function start() {
    const r = resolveLaunch();
    if (!r) { alert('Shell not available. Pick another preset or fill in Custom binary.'); return; }
    if (elevated) {
      const res = await window.api.terminal.launchElevated({ binary: r.binary, args: r.args, cwd: cwd || undefined });
      if (!res.ok) alert(`Elevated launch failed: ${res.reason || 'unknown'}`);
      return;
    }
    try {
      const res = await window.api.runner.start({ backend: 'shell', binary: r.binary, args: r.args, cwd: cwd || undefined });
      const sess: Session = {
        id: res.id, shellId, label: r.label, cwd: cwd || undefined,
        startedAt: Date.now(), exited: null,
        output: `[start] ${r.binary} ${r.args.join(' ')}\n`
      };
      setSessions(prev => [sess, ...prev]);
      setActiveId(res.id);
    } catch (e: any) {
      alert(`Failed to start: ${e.message}`);
    }
  }

  async function send() {
    if (!activeId || !input.trim()) return;
    const text = input;
    setInput('');
    setSessions(prev => prev.map(s => s.id === activeId ? { ...s, output: s.output + `\n> ${text}\n` } : s));
    await window.api.runner.input(activeId, text);
  }

  async function stop(id: string) { await window.api.runner.stop(id); }
  function close(id: string) {
    setSessions(prev => prev.filter(p => p.id !== id));
    if (activeId === id) setActiveId(null);
  }

  const active = sessions.find(s => s.id === activeId) ?? null;

  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="card col">
        <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
          <select value={shellId} onChange={e => setShellId(e.target.value)} style={{ minWidth: 220 }}>
            {shells.map(s => (
              <option key={s.id} value={s.id} disabled={!s.available && s.id !== 'custom'}>{s.label}</option>
            ))}
          </select>
          {shellId === 'custom' ? (
            <>
              <input placeholder="binary path or name" value={customBinary} onChange={e => setCustomBinary(e.target.value)} style={{ flex: 1, minWidth: 200 }} />
              <button onClick={async () => { const p = await window.api.app.pickPath(); if (p) setCustomBinary(p); }}>Pick</button>
              <input placeholder='args (space-separated, "quote spaces")' value={customArgs} onChange={e => setCustomArgs(e.target.value)} style={{ flex: 1, minWidth: 160 }} />
            </>
          ) : (
            <code className="label" title={picked?.binary} style={{ flex: 1 }}>
              {picked?.binary || '(no preset)'}
            </code>
          )}
          <input placeholder="cwd (optional)" value={cwd} onChange={e => setCwd(e.target.value)} style={{ width: 220 }} />
          <button onClick={async () => { const p = await window.api.app.pickPath({ properties: ['openDirectory'] }); if (p) setCwd(p); }}>Pick cwd</button>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title="Spawns a separate elevated console window (UAC prompt). Output won't stream back into Claw Deck.">
            <input type="checkbox" checked={elevated} onChange={e => setElevated(e.target.checked)} /> Elevated
          </label>
          <button className="primary" onClick={start}>Open</button>
        </div>
        <div className="label">
          Streamed sessions support piping further commands via the input bar below. Elevated launches open in their own Windows console (UAC) and aren't captured here.
        </div>
      </div>

      <div className="card col" style={{ flex: 1, overflow: 'hidden' }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {sessions.length === 0 && <div className="label">No sessions yet. Pick a shell above and click Open.</div>}
          {sessions.map(sess => (
            <button
              key={sess.id}
              className={sess.id === activeId ? 'tab-btn active' : 'tab-btn'}
              onClick={() => setActiveId(sess.id)}
              style={{ padding: '4px 10px' }}
              title={sess.label}
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
              <span className="label" title={active.label}>{active.label}{active.cwd ? ` @ ${active.cwd}` : ''}</span>
              <div style={{ flex: 1 }} />
              {active.exited == null && <button onClick={() => stop(active.id)}>Stop</button>}
              <button onClick={() => close(active.id)}>Close</button>
            </div>
            <pre style={{
              flex: 1, overflow: 'auto', background: 'var(--panel-2)',
              borderRadius: 6, padding: 10, margin: 0,
              fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word', minHeight: 200
            }}>
              {active.output}
              <div ref={bottomRef} />
            </pre>
            <div className="row">
              <input
                placeholder="type command + Enter"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); send(); } }}
                disabled={active.exited != null}
                style={{ flex: 1, fontFamily: 'Cascadia Code, Consolas, monospace' }}
              />
              <button onClick={send} disabled={active.exited != null || !input.trim()}>Send</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
