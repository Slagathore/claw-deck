import React from 'react';
import { CouncilEvt } from '../store/council';

const LANE_COLORS = ['#7c9cff', '#4ade80', '#fbbf24', '#f87171', '#a78bfa', '#22d3ee'];

/** Live debate stream: phase headers, per-agent lanes, verdicts, convergence, result. */
export default function DebateTheater({ events, running }: { events: CouncilEvt[]; running?: boolean }) {
  if (!events.length) return <div className="card" style={{ color: 'var(--muted)', fontSize: 12 }}>No session yet — configure on the left and press Start.</div>;

  const laneColor = (() => {
    const m = new Map<string, string>(); let i = 0;
    return (id?: string) => id ? (m.get(id) ?? (m.set(id, LANE_COLORS[i++ % LANE_COLORS.length]).get(id)!)) : 'var(--muted)';
  })();

  return (
    <div className="card col" style={{ gap: 6, overflow: 'auto', minHeight: 0 }}>
      <div className="row"><strong>Debate theater</strong>{running && <span className="badge warn">running…</span>}</div>
      {events.map((e, i) => {
        switch (e.type) {
          case 'loop:iteration': return <div key={i} style={{ borderTop: '2px solid var(--accent)', paddingTop: 8, marginTop: 8 }}><strong style={{ color: 'var(--accent)' }}>⟳ Iteration {e.round ?? (e as any).iter}</strong></div>;
          case 'loop:checkpoint': return <div key={i} style={{ fontSize: 11, color: 'var(--muted)' }}>checkpoint {(e as any).signature?.slice?.(0, 10)}</div>;
          case 'loop:goal-check': return <div key={i}><span className={`badge ${e.status === 'met' ? 'ok' : 'warn'}`}>goal {e.status}</span></div>;
          case 'loop:halt': return <div key={i}><span className={`badge ${e.status === 'met' ? 'ok' : e.status === 'oscillation' || e.status === 'cost' || e.status === 'cap' ? 'warn' : 'bad'}`}>loop halted: {e.status}</span></div>;
          case 'loop:done': return <div key={i}><span className={`badge ${e.ok ? 'ok' : 'warn'}`}>loop finished: {e.status}</span></div>;
          case 'phase': return <div key={i} style={{ borderTop: '1px solid var(--border)', paddingTop: 6, marginTop: 4 }}><strong style={{ color: 'var(--accent)' }}>▸ {e.phase}</strong> <span style={{ color: 'var(--muted)', fontSize: 11 }}>{e.kind}</span></div>;
          case 'debate-round': return <div key={i} style={{ fontSize: 11, color: 'var(--muted)' }}>round {e.round}</div>;
          case 'agent': return <div key={i} style={{ fontSize: 12 }}><span style={{ color: laneColor(e.agentId), fontWeight: 600 }}>{e.agentId}</span>: <span style={{ whiteSpace: 'pre-wrap' }}>{(e.content ?? '').slice(0, 600)}</span></div>;
          case 'verdict': return <div key={i}><span className={`badge ${e.verdict === 'approve' ? 'ok' : e.verdict === 'minor' ? 'warn' : 'bad'}`}>{e.verdict}</span> <span style={{ fontSize: 11, color: 'var(--muted)' }}>{e.agentId}</span></div>;
          case 'converged': return <div key={i}><span className="badge ok">converged</span></div>;
          case 'bounce': return <div key={i}><span className="badge bad">bounced — {e.verdict}</span></div>;
          case 'propose': case 'validate': case 'execute': return <div key={i}><span className={`badge ${e.ok ? 'ok' : 'bad'}`}>{e.type} {e.ok ? 'ok' : 'failed'}</span></div>;
          case 'finished': return <div key={i}><span className={`badge ${e.ok ? 'ok' : e.status === 'bounced' ? 'warn' : 'bad'}`}>finished: {e.status}{e.ok ? ' · approved & merged' : ''}</span></div>;
          case 'error': return <div key={i} style={{ color: 'var(--bad)', fontSize: 12 }}>error: {e.content}</div>;
          default: return null;
        }
      })}
    </div>
  );
}
