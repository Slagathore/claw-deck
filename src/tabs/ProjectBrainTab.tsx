import React, { useEffect, useRef, useState, useCallback } from 'react';
import cytoscape from 'cytoscape';
import { atlas, AtlasStatus, STATUS_COLOR, STATUS_BADGE } from '../lib/atlasClient';

const ALL_STATUSES: AtlasStatus[] = ['active', 'orphaned', 'deprecated', 'superseded'];

type Card = import('../../electron/atlas/types').SymbolCard;

export default function ProjectBrainTab() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [counts, setCounts] = useState<{ total: number; byStatus: Record<string, number>; files: number; edges: number } | null>(null);
  const [filters, setFilters] = useState<Set<AtlasStatus>>(new Set(ALL_STATUSES));
  const [card, setCard] = useState<Card | null>(null);
  const [locateQ, setLocateQ] = useState('');
  const [locateHits, setLocateHits] = useState<{ location: string; name: string; kind: string; status: string }[]>([]);

  const cyHost = useRef<HTMLDivElement>(null);
  const cy = useRef<cytoscape.Core | null>(null);
  // keep the latest workspace in a ref so the cytoscape tap handler (bound once)
  // never reads a stale (null) value from its mount-time closure.
  const workspaceRef = useRef<string | null>(null);
  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);

  // --- cytoscape lifecycle --------------------------------------------------
  useEffect(() => {
    if (!cyHost.current) return;
    const inst = cytoscape({
      container: cyHost.current,
      elements: [],
      style: [
        { selector: 'node', style: { 'background-color': 'data(color)', label: 'data(label)', color: '#e6e9ef', 'font-size': 9, 'text-valign': 'bottom', 'text-margin-y': 3, width: 'data(size)', height: 'data(size)' } },
        { selector: 'edge', style: { width: 1, 'line-color': '#2a3142', 'target-arrow-color': '#2a3142', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier', 'arrow-scale': 0.7 } },
        { selector: 'node:selected', style: { 'border-width': 2, 'border-color': '#7c9cff' } },
      ],
      layout: { name: 'grid' },
      wheelSensitivity: 0.2,
    });
    inst.on('tap', 'node', (evt) => {
      const d = evt.target.data();
      if (d.ref) loadCard(d.ref);
    });
    cy.current = inst;
    return () => { inst.destroy(); cy.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadCard = useCallback(async (ref: string) => {
    const ws = workspaceRef.current;
    if (!ws) return;
    const r = await atlas.card(ws, ref);
    if (r.ok) setCard(r.card ?? null);
  }, []);

  const refreshGraph = useCallback(async (ws: string, active: Set<AtlasStatus>) => {
    const r = await atlas.graph(ws, [...active]);
    const inst = cy.current;
    if (!inst || !r.ok || !r.graph) return;
    const maxRef = Math.max(1, ...r.graph.nodes.map((n) => n.refCount));
    inst.elements().remove();
    inst.add([
      ...r.graph.nodes.map((n) => ({ data: { id: n.id, label: n.label, color: STATUS_COLOR[n.status as AtlasStatus] ?? '#8a93a6', size: 14 + Math.round(26 * (n.refCount / maxRef)), ref: `${n.file}:${n.line}` } })),
      ...r.graph.edges.map((e) => ({ data: { id: `${e.source}-${e.target}-${e.kind}`, source: e.source, target: e.target } })),
    ]);
    inst.layout({ name: 'cose', animate: false, nodeRepulsion: () => 8000, idealEdgeLength: () => 60 } as any).run();
  }, []);

  const refreshStatus = useCallback(async (ws: string) => {
    const r = await atlas.status(ws);
    if (r.ok && r.counts) setCounts(r.counts);
  }, []);

  // --- persistence: restore the last-opened workspace on mount --------------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const s = await window.api.settings.get();
      const ws: string | undefined = s?.projectBrainWorkspace;
      if (!ws || cancelled) return;
      const o = await atlas.open(ws);          // reopens the persisted <ws>/.fusion/atlas.db
      if (!o.ok || cancelled) return;
      setWorkspace(ws);
      setMsg(`Restored ${ws} — press ↻ Re-index to refresh from disk`);
      await refreshStatus(ws);
      await refreshGraph(ws, new Set(ALL_STATUSES));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- actions --------------------------------------------------------------
  async function openFolder() {
    const ws = await window.api.app.pickPath({ properties: ['openDirectory'] });
    if (!ws) return;
    setBusy('Opening…'); setMsg('');
    const o = await atlas.open(ws);
    if (!o.ok) { setBusy(''); setMsg(`Open failed: ${o.error}`); return; }
    setWorkspace(ws);
    window.api.settings.set({ projectBrainWorkspace: ws }); // remember across restarts
    setBusy('Indexing…');
    const ix = await atlas.index(ws);
    setBusy('');
    if (!ix.ok) { setMsg(`Index failed: ${ix.error}`); return; }
    setMsg(`Indexed ${ix.counts?.symbols ?? 0} symbols in ${ix.counts?.files ?? 0} files · code-brain MCP: ${o.mcpServer}`);
    await refreshStatus(ws);
    await refreshGraph(ws, filters);
  }

  async function reindex() {
    if (!workspace) return;
    setBusy('Re-indexing…');
    await atlas.index(workspace);
    setBusy('');
    await refreshStatus(workspace);
    await refreshGraph(workspace, filters);
  }

  async function enrich(kind: 'embed' | 'summarize') {
    if (!workspace) return;
    setBusy(kind === 'embed' ? 'Embedding…' : 'Summarizing…');
    const r = await atlas.enrich(workspace, kind);
    setBusy('');
    if (!r.ok) { setMsg(r.reason ?? `${kind} unavailable`); return; }
    setMsg(kind === 'embed' ? `Embedded ${r.embedded ?? 0} (remaining ${r.remaining ?? 0}, superseded +${r.superseded ?? 0})` : `Summarized ${r.summarized ?? 0} (remaining ${r.remaining ?? 0})`);
    await refreshStatus(workspace);
    await refreshGraph(workspace, filters);
  }

  async function runLocate() {
    if (!workspace || !locateQ.trim()) return;
    const r = await atlas.query(workspace, 'locate', locateQ.trim());
    if (r.ok) setLocateHits(r.result ?? []);
  }

  function toggle(s: AtlasStatus) {
    const next = new Set(filters);
    next.has(s) ? next.delete(s) : next.add(s);
    setFilters(next);
    if (workspace) refreshGraph(workspace, next);
  }

  // live re-index events from the watcher
  useEffect(() => {
    const off = atlas.onEvent((e) => {
      if (!workspace || e.workspace !== workspace) return;
      if (e.kind === 'reindexed' || e.kind === 'indexed' || e.kind === 'enriched') {
        refreshStatus(workspace); refreshGraph(workspace, filters);
      }
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace, filters]);

  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <button onClick={openFolder}>📂 Open folder</button>
        <button onClick={reindex} disabled={!workspace}>↻ Re-index</button>
        <button onClick={() => enrich('embed')} disabled={!workspace} title="nomic-embed-text via Ollama (background)">⚡ Embed</button>
        <button onClick={() => enrich('summarize')} disabled={!workspace} title="cheap chat model writes per-symbol cards">📝 Summarize</button>
        {workspace && <span style={{ color: 'var(--muted)', fontSize: 12 }}>{workspace}</span>}
        {busy && <span className="badge warn">{busy}</span>}
      </div>

      {counts && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <span style={{ color: 'var(--muted)', fontSize: 12 }}>{counts.total} symbols · {counts.files} files · {counts.edges} edges</span>
          {ALL_STATUSES.map((s) => (
            <button key={s} onClick={() => toggle(s)} title="toggle filter"
              style={{ opacity: filters.has(s) ? 1 : 0.4, borderColor: STATUS_COLOR[s], color: STATUS_COLOR[s] }}>
              {s} {counts.byStatus[s] ?? 0}
            </button>
          ))}
        </div>
      )}

      {msg && <div className="card" style={{ padding: 8, fontSize: 12, color: 'var(--muted)' }}>{msg}</div>}

      <div className="row" style={{ flex: 1, alignItems: 'stretch', minHeight: 0 }}>
        <div ref={cyHost} className="card" style={{ flex: 1, padding: 0, minHeight: 320 }} />

        <div className="col" style={{ width: 360, minHeight: 0, overflow: 'auto' }}>
          <div className="card">
            <div className="row">
              <input placeholder="locate: e.g. screenshot region cropping" value={locateQ}
                onChange={(e) => setLocateQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runLocate()} style={{ flex: 1 }} />
              <button onClick={runLocate} disabled={!workspace}>Find</button>
            </div>
            {locateHits.length > 0 && (
              <div className="col" style={{ gap: 4, marginTop: 8 }}>
                {locateHits.slice(0, 8).map((h) => (
                  <div key={h.location} className="row" style={{ cursor: 'pointer', justifyContent: 'space-between' }} onClick={() => loadCard(h.location)}>
                    <span style={{ color: 'var(--accent)' }}>{h.name}</span>
                    <span style={{ color: 'var(--muted)', fontSize: 11 }}>{h.kind}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {card ? <CardView card={card} onNavigate={loadCard} /> : (
            <div className="card" style={{ color: 'var(--muted)', fontSize: 12 }}>
              {workspace ? 'Click a node or a locate result to inspect a symbol.' : 'Open a folder to build its Atlas (symbols, edges, status tags).'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CardView({ card, onNavigate }: { card: Card; onNavigate: (ref: string) => void }) {
  const badge = STATUS_BADGE[card.status as AtlasStatus] ?? '';
  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong style={{ color: 'var(--accent)' }}>{card.qualifiedName}</strong>
        <span className={`badge ${badge}`} style={!badge ? { color: 'var(--muted)' } : undefined}>{card.status}</span>
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 11 }}>{card.kind} · {card.location} · {card.refCount} refs</div>
      {card.signature && <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 11 }}>{card.signature}</pre>}
      {card.summary && <div style={{ fontSize: 12 }}>{card.summary}</div>}
      {card.doc && !card.summary && <div style={{ fontSize: 12, color: 'var(--muted)' }}>{card.doc}</div>}
      {card.supersededBy && <div style={{ fontSize: 12, color: 'var(--bad)' }}>superseded by {card.supersededBy}</div>}
      <Neighbours title="Callers" items={card.callers} onNavigate={onNavigate} />
      <Neighbours title="Callees" items={card.callees} onNavigate={onNavigate} />
    </div>
  );
}

function Neighbours({ title, items, onNavigate }: { title: string; items: { name: string; location: string }[]; onNavigate: (ref: string) => void }) {
  if (!items.length) return null;
  return (
    <div className="col" style={{ gap: 2 }}>
      <div style={{ fontSize: 11, color: 'var(--muted)' }}>{title} ({items.length})</div>
      {items.slice(0, 12).map((it) => (
        <span key={it.location} style={{ fontSize: 12, cursor: 'pointer' }} onClick={() => onNavigate(it.location)}>↳ {it.name}</span>
      ))}
    </div>
  );
}
