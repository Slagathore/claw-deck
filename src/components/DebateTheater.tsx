import React, { useEffect, useRef, useState } from 'react';
import { CouncilEvt, LiveLane } from '../store/council';

const LANE_COLORS = ['#7c9cff', '#4ade80', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee'];
const WRAP: React.CSSProperties = { whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowWrap: 'anywhere' };

/** Wrap occurrences of `query` in `text` with <mark>, assigning each a running global
 *  index (so the find bar can scroll to / number them). The current match is amber. */
function highlightInto(text: string, query: string, nextIndex: () => number, current: number, refs: (HTMLElement | undefined)[]): React.ReactNode {
  const lc = text.toLowerCase();
  const q = query.toLowerCase();
  const out: React.ReactNode[] = [];
  let i = 0; let k = 0;
  for (;;) {
    const f = lc.indexOf(q, i);
    if (f < 0) { out.push(text.slice(i)); break; }
    if (f > i) out.push(text.slice(i, f));
    const idx = nextIndex();
    out.push(<mark key={k++} ref={(el) => { refs[idx] = el ?? undefined; }} style={{ background: idx === current ? '#f59e0b' : '#fde68a', color: '#000', borderRadius: 2 }}>{text.slice(f, f + query.length)}</mark>);
    i = f + query.length;
  }
  return out;
}

/** Live debate stream: phase headers, per-agent lanes, streaming text, verdicts, result.
 *  Ctrl/Cmd+F opens an in-transcript find bar with match highlighting + ↑/↓ navigation. */
export default function DebateTheater({ events, live, running, nameOf = (id) => id ?? '' }: { events: CouncilEvt[]; live?: Record<string, LiveLane>; running?: boolean; nameOf?: (id?: string) => string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const matchRefs = useRef<(HTMLElement | undefined)[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [current, setCurrent] = useState(0);
  const [matchCount, setMatchCount] = useState(0);
  const liveLanes = Object.entries(live ?? {});

  // Ctrl/Cmd+F opens the find bar (only while this theater is mounted → the Council tab).
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
        ev.preventDefault();
        setFindOpen(true);
        setTimeout(() => inputRef.current?.focus(), 0);
      } else if (ev.key === 'Escape' && findOpen) {
        setFindOpen(false); setQuery('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [findOpen]);

  // Auto-scroll ONLY this container (never the window) and only when already near the
  // bottom, so we don't yank the page or interrupt reading. Suspended while finding.
  useEffect(() => {
    const el = containerRef.current;
    if (!el || findOpen) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 140) el.scrollTop = el.scrollHeight;
  }, [events.length, findOpen, liveLanes.map(([, l]) => l.text.length).join(',')]);

  // After render, learn how many matches the highlighter produced; reset cursor on new query.
  useEffect(() => { setMatchCount(matchRefs.current.length); }, [query, events.length]);
  useEffect(() => { setCurrent(0); }, [query]);
  useEffect(() => { const el = matchRefs.current[current]; if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [current, matchCount]);
  const go = (delta: number) => setCurrent((c) => (matchCount ? (c + delta + matchCount) % matchCount : 0));

  if (!events.length && !liveLanes.length) return <div className="card" style={{ color: 'var(--muted)', fontSize: 12 }}>No session yet — configure on the left and press Start. <span style={{ opacity: 0.6 }}>(Ctrl+F to search once it's running.)</span></div>;

  const laneColor = (() => {
    const m = new Map<string, string>(); let i = 0;
    return (id?: string) => id ? (m.get(id) ?? (m.set(id, LANE_COLORS[i++ % LANE_COLORS.length]).get(id)!)) : 'var(--muted)';
  })();

  // Highlighter wired across this render. matchIdx counts marks; refs collects their DOM nodes.
  let matchIdx = 0;
  matchRefs.current = [];
  const hl = (text?: string): React.ReactNode => {
    const t = text ?? '';
    if (!findOpen || !query.trim()) return t;
    return highlightInto(t, query, () => matchIdx++, current, matchRefs.current);
  };

  return (
    <div ref={containerRef} className="card col" style={{ gap: 6, overflowY: 'auto', overflowX: 'hidden', minHeight: 0, position: 'relative' }}>
      {findOpen && (
        <div className="row" style={{ position: 'sticky', top: 0, zIndex: 3, background: 'var(--panel, #1b1d24)', padding: 4, gap: 6, borderBottom: '1px solid var(--border)', alignItems: 'center' }}>
          <input ref={inputRef} placeholder="Find in transcript…" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); } else if (e.key === 'Escape') { setFindOpen(false); setQuery(''); } }}
            style={{ flex: 1, fontSize: 12 }} />
          <span className="label" style={{ minWidth: 48, textAlign: 'right' }}>{matchCount ? current + 1 : 0}/{matchCount}</span>
          <button onClick={() => go(-1)} disabled={!matchCount} title="previous (Shift+Enter)">↑</button>
          <button onClick={() => go(1)} disabled={!matchCount} title="next (Enter)">↓</button>
          <button onClick={() => { setFindOpen(false); setQuery(''); }} title="close (Esc)">✕</button>
        </div>
      )}
      <div className="row"><strong>Debate theater</strong>{running && <span className="badge warn">running…</span>}</div>
      {events.map((e, i) => {
        switch (e.type) {
          case 'loop:iteration': return <div key={i} style={{ borderTop: '2px solid var(--accent)', paddingTop: 8, marginTop: 8 }}><strong style={{ color: 'var(--accent)' }}>⟳ Iteration {e.round ?? (e as any).iter}</strong></div>;
          case 'loop:checkpoint': return <div key={i} style={{ fontSize: 11, color: 'var(--muted)' }}>checkpoint {(e as any).signature?.slice?.(0, 10)}</div>;
          case 'loop:goal-check': return <div key={i}><span className={`badge ${e.status === 'met' ? 'ok' : 'warn'}`}>goal {e.status}</span></div>;
          case 'loop:halt': return <div key={i}><span className={`badge ${e.status === 'met' ? 'ok' : e.status === 'oscillation' || e.status === 'cost' || e.status === 'cap' ? 'warn' : 'bad'}`}>loop halted: {e.status}</span></div>;
          case 'loop:done': return <div key={i}><span className={`badge ${e.ok ? 'ok' : 'warn'}`}>loop finished: {e.status}</span></div>;
          case 'questions': return <div key={i}><span className="badge warn">🧭 awaiting your answers — {(e.questions ?? []).length} question(s)</span></div>;
          case 'tools': return <div key={i} style={{ fontSize: 11, color: 'var(--muted)' }}>🔧 panelist tools: {hl(e.content)}</div>;
          case 'lint': return <div key={i} className={`banner ${e.ok ? '' : 'warn'}`} style={{ fontSize: 11, ...WRAP }}><strong>🧪 pre-gate lint</strong> <span className={`badge ${e.ok ? 'ok' : 'bad'}`}>{e.ok ? 'clean' : 'findings'}</span>{!e.ok && <pre style={{ margin: '4px 0 0', fontSize: 11, ...WRAP }}>{hl(e.content)}</pre>}</div>;
          case 'warn': return <div key={i} style={{ fontSize: 11, color: e.ok === false ? 'var(--bad)' : 'var(--warn)', ...WRAP }}>⚠ {hl(e.content)}</div>;
          case 'phase': return <div key={i} style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 4 }}><strong style={{ color: 'var(--accent)' }}>▸ {hl(e.phase)}</strong> <span style={{ color: 'var(--muted)', fontSize: 11 }}>{e.kind}</span></div>;
          case 'debate-round': return <div key={i} style={{ fontSize: 11, color: 'var(--muted)' }}>round {e.round}</div>;
          case 'agent': return <div key={i} style={{ fontSize: 12 }}><span style={{ color: laneColor(e.agentId), fontWeight: 600 }}>{nameOf(e.agentId)}</span>: <span style={WRAP}>{hl(e.content)}</span></div>;
          case 'agent-error': return <div key={i} className="banner warn" style={{ fontSize: 12, ...WRAP }}><strong>{nameOf(e.agentId)}</strong> failed: {hl((e.content ?? '').slice(0, 1200))}</div>;
          case 'verdict': return <div key={i}><span className={`badge ${e.verdict === 'approve' ? 'ok' : e.verdict === 'minor' ? 'warn' : 'bad'}`}>{e.verdict}</span> <span style={{ fontSize: 11, color: 'var(--muted)' }}>{nameOf(e.agentId)}</span></div>;
          case 'converged': return <div key={i}><span className="badge ok">converged</span></div>;
          case 'bounce': return <div key={i}><span className="badge bad">bounced — {e.verdict}</span></div>;
          case 'propose': case 'validate': case 'execute': return <div key={i}><span className={`badge ${e.ok ? 'ok' : 'bad'}`}>{e.type} {e.ok ? 'ok' : 'failed'}</span></div>;
          case 'finished': return <div key={i}><span className={`badge ${e.ok ? 'ok' : e.status === 'bounced' ? 'warn' : 'bad'}`}>finished: {e.status}{e.ok ? ' · approved & merged' : ''}</span></div>;
          case 'error': return <div key={i} style={{ color: 'var(--bad)', fontSize: 12, ...WRAP }}>error: {hl(e.content)}</div>;
          default: return null;
        }
      })}

      {/* in-flight lanes: streaming text, or "thinking…" for non-streaming agents */}
      {liveLanes.map(([agentId, lane]) => (
        <div key={`live-${agentId}`} style={{ fontSize: 12 }}>
          <span style={{ color: laneColor(agentId), fontWeight: 600 }}>{nameOf(agentId)}</span>
          <span className="badge warn" style={{ fontSize: 9, marginLeft: 4 }}>{lane.text ? 'streaming' : 'thinking'}</span>:{' '}
          {lane.text
            ? <span style={WRAP}>{lane.text.length > 12000 ? '…' + lane.text.slice(-12000) : lane.text}<span style={{ opacity: 0.5 }}>▋</span></span>
            : <span style={{ color: 'var(--muted)' }}><PulseDots /></span>}
        </div>
      ))}
    </div>
  );
}

/** A tiny animated "working" indicator (no CSS keyframes needed). */
export function PulseDots() {
  const [n, setN] = useState(0);
  useEffect(() => { const t = setInterval(() => setN((x) => (x + 1) % 4), 350); return () => clearInterval(t); }, []);
  return <span>working{'.'.repeat(n)}{' '.repeat(3 - n)}</span>;
}
