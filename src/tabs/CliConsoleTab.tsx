import React, { useEffect, useRef, useState } from 'react';
import { useSettings } from '../store/ui';

type Backend = 'openclaw' | 'claude';

interface Session {
  id: string;
  backend: Backend;
  binary: string;
  args: string[];
  cwd?: string;
  startedAt: number;
  exited?: number | null;
  output: string;
}

export default function CliConsoleTab() {
  const { data: s } = useSettings();
  const [backend, setBackend] = useState<Backend>('openclaw');
  const [argsLine, setArgsLine] = useState('');
  const [cwd, setCwd] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const offRef = useRef<null | (() => void)>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    offRef.current?.();
    offRef.current = window.api.runner.onEvent((ev: any) => {
      setSessions(prev => prev.map(sess => {
        if (sess.id !== ev.id) return sess;
        if (ev.kind === 'stdout' || ev.kind === 'stderr') {
          return { ...sess, output: sess.output + ev.data };
        }
        if (ev.kind === 'error') {
          return { ...sess, output: sess.output + `\n[error] ${ev.data}\n` };
        }
        if (ev.kind === 'exit') {
          return { ...sess, exited: ev.data, output: sess.output + `\n[exit ${ev.data}]\n` };
        }
        return sess;
      }));
    });
    return () => { offRef.current?.(); };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [sessions, activeId]);

  function pickBinary(): string {
    return backend === 'openclaw' ? (s.openclawPath || '') : (s.claudeCodePath || 'claude');
  }

  async function start() {
    const binary = pickBinary();
    if (!binary) {
      alert(`No path set for ${backend}. Configure it in Settings → CLIs.`);
      return;
    }
    const args = parseArgs(argsLine);
    try {
      const r = await window.api.runner.start({
        backend, binary, args, cwd: cwd || undefined
      });
      const sess: Session = {
        id: r.id, backend, binary, args, cwd: cwd || undefined,
        startedAt: Date.now(), exited: null, output: `[start] ${binary} ${args.join(' ')}\n`
      };
      setSessions(prev => [sess, ...prev]);
      setActiveId(r.id);
    } catch (e: any) {
      alert(`Failed to start: ${e.message}`);
    }
  }

  async function stop(id: string) {
    await window.api.runner.stop(id);
  }

  function close(id: string) {
    setSessions(prev => prev.filter(p => p.id !== id));
    if (activeId === id) setActiveId(null);
  }

  const active = sessions.find(x => x.id === activeId) ?? null;

  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="card col">
        <div className="row">
          <select value={backend} onChange={e => setBackend(e.target.value as Backend)}>
            <option value="openclaw">OpenClaw</option>
            <option value="claude">Claude Code</option>
          </select>
          <input
            placeholder="args (space-separated, quotes supported)"
            value={argsLine}
            onChange={e => setArgsLine(e.target.value)}
            style={{ flex: 1 }}
          />
          <input
            placeholder="cwd (optional)"
            value={cwd}
            onChange={e => setCwd(e.target.value)}
            style={{ width: 260 }}
          />
          <button onClick={async () => {
            const p = await window.api.app.pickPath({ properties: ['openDirectory'] });
            if (p) setCwd(p);
          }}>Pick cwd</button>
          <button className="primary" onClick={start}>Start</button>
        </div>
        <div className="label">
          Using binary: <code>{pickBinary() || '(unset — open Settings)'}</code>
        </div>
      </div>

      <div className="card col" style={{ flex: 1, overflow: 'hidden' }}>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {sessions.length === 0 && <div className="label">No sessions yet.</div>}
          {sessions.map(sess => (
            <button
              key={sess.id}
              className={sess.id === activeId ? 'tab-btn active' : 'tab-btn'}
              onClick={() => setActiveId(sess.id)}
              style={{ padding: '4px 10px' }}
              title={`${sess.binary} ${sess.args.join(' ')}`}
            >
              <span className={`badge ${sess.exited == null ? 'ok' : sess.exited === 0 ? 'ok' : 'bad'}`}>
                {sess.exited == null ? 'running' : `exit ${sess.exited}`}
              </span>
              {' '}
              {sess.backend} · {sess.id.slice(0, 6)}
            </button>
          ))}
        </div>

        {active && (
          <>
            <div className="row">
              <span className="label">{active.binary} {active.args.join(' ')}</span>
              <div style={{ flex: 1 }} />
              {active.exited == null && <button onClick={() => stop(active.id)}>Stop</button>}
              <button onClick={() => close(active.id)}>Close</button>
            </div>
            <pre style={{
              flex: 1, overflow: 'auto', background: 'var(--panel-2)',
              borderRadius: 6, padding: 10, margin: 0,
              fontFamily: 'Cascadia Code, Consolas, monospace', fontSize: 12,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word'
            }}>
              {active.output}
              <div ref={bottomRef} />
            </pre>
          </>
        )}
      </div>
    </div>
  );
}

export function parseArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else {
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === ' ' || c === '\t') {
        if (cur) { out.push(cur); cur = ''; }
        continue;
      }
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}
