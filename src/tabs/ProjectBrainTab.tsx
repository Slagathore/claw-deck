import React, { useEffect, useRef, useState, useCallback } from 'react';
import cytoscape from 'cytoscape';
import { atlas, AtlasStatus, STATUS_COLOR, STATUS_BADGE } from '../lib/atlasClient';

const ALL_STATUSES: AtlasStatus[] = ['active', 'orphaned', 'deprecated', 'superseded'];

type Card = import('../../electron/atlas/types').SymbolCard;
type Metric = 'status' | 'churn' | 'owner';

/** cool blue (low) → hot red (high) for the churn heatmap. */
function heatColor(t: number): string {
  const c = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(74 + (248 - 74) * c)},${Math.round(144 + (113 - 144) * c)},${Math.round(226 + (113 - 226) * c)})`;
}
/** stable categorical color per author. */
function ownerColor(name?: string): string {
  if (!name) return '#8a93a6';
  let h = 0; for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h},60%,60%)`;
}

export default function ProjectBrainTab() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [counts, setCounts] = useState<{ total: number; byStatus: Record<string, number>; files: number; edges: number } | null>(null);
  const [filters, setFilters] = useState<Set<AtlasStatus>>(new Set(ALL_STATUSES));
  const [card, setCard] = useState<Card | null>(null);
  const [locateQ, setLocateQ] = useState('');
  const [locateHits, setLocateHits] = useState<{ location: string; name: string; kind: string; status: string }[]>([]);
  const [graphSearch, setGraphSearch] = useState('');
  const [fileFilter, setFileFilter] = useState('');
  const [graphLimit, setGraphLimit] = useState(600);
  const [layoutName, setLayoutName] = useState<'cose' | 'grid' | 'circle'>('cose');
  const [mcpStatus, setMcpStatus] = useState<{ status: string; lastError?: string } | null>(null);
  const [openedServer, setOpenedServer] = useState<string>('');
  const [metric, setMetric] = useState<Metric>('status');
  const metricsRef = useRef<{ churn: Record<string, number>; owner: Record<string, string> } | null>(null);
  const recolorRef = useRef<(m: Metric) => void>(() => { /* set in render */ });

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

  const refreshGraph = useCallback(async (ws: string, active: Set<AtlasStatus>, search = graphSearch, file = fileFilter, limit = graphLimit, layout = layoutName) => {
    const r = await atlas.graph(ws, [...active], file.trim() || undefined, search.trim() || undefined, limit);
    const inst = cy.current;
    if (!inst || !r.ok || !r.graph) return;
    const maxRef = Math.max(1, ...r.graph.nodes.map((n) => n.refCount));
    inst.elements().remove();
    inst.add([
      ...r.graph.nodes.map((n) => { const sc = STATUS_COLOR[n.status as AtlasStatus] ?? '#8a93a6'; return { data: { id: n.id, label: n.label, color: sc, statusColor: sc, status: n.status, file: n.file, size: 14 + Math.round(26 * (n.refCount / maxRef)), ref: `${n.file}:${n.line}` } }; }),
      ...r.graph.edges.map((e) => ({ data: { id: `${e.source}-${e.target}-${e.kind}`, source: e.source, target: e.target } })),
    ]);
    const layoutOpts = layout === 'cose'
      ? { name: 'cose', animate: false, nodeRepulsion: () => 8000, idealEdgeLength: () => 60 }
      : { name: layout, animate: false };
    inst.layout(layoutOpts as any).run();
    recolorRef.current(metric);   // re-apply the active heatmap metric after a graph refresh
  }, [fileFilter, graphLimit, graphSearch, layoutName, metric]);

  // Heatmap recolor — status (default), git churn (commit count), or owner (top author).
  recolorRef.current = (m: Metric) => {
    const inst = cy.current;
    if (!inst) return;
    if (m === 'status') { inst.nodes().forEach((n: any) => n.data('color', n.data('statusColor'))); return; }
    const mx = metricsRef.current;
    if (!mx) return;
    if (m === 'churn') {
      const max = Math.max(1, ...inst.nodes().map((n: any) => mx.churn[n.data('file')] ?? 0));
      inst.nodes().forEach((n: any) => n.data('color', heatColor((mx.churn[n.data('file')] ?? 0) / max)));
    } else {
      inst.nodes().forEach((n: any) => n.data('color', ownerColor(mx.owner[n.data('file')])));
    }
  };
  async function changeMetric(m: Metric) {
    setMetric(m);
    if (m !== 'status' && !metricsRef.current && workspace) {
      setBusy('Loading git metrics…');
      const r = await atlas.metrics(workspace);
      setBusy('');
      if (r.ok) metricsRef.current = { churn: r.churn, owner: r.owner };
    }
    recolorRef.current(m);
  }

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
      setOpenedServer(o.mcpServer ?? '');
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
    setOpenedServer(o.mcpServer ?? '');
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

  function openLocation(location: string) {
    if (!workspace) return;
    const [file] = location.split(':');
    if (!file) return;
    window.api.app.openPath(`${workspace}\\${file.replace(/\//g, '\\')}`).catch(() => { /* best-effort */ });
  }

  useEffect(() => {
    if (!workspace || !openedServer) return;
    let cancelled = false;
    const poll = async () => {
      const list = await window.api.mcp.list().catch(() => []);
      if (cancelled) return;
      const st = list.find((m: any) => m.name === openedServer);
      setMcpStatus(st ? { status: st.status, lastError: st.lastError } : null);
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => { cancelled = true; clearInterval(t); };
  }, [workspace, openedServer]);

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

      {workspace && (
        <div className="row" style={{ flexWrap: 'wrap' }}>
          <input placeholder="graph search: symbol, file, summary" value={graphSearch} onChange={e => setGraphSearch(e.target.value)} style={{ minWidth: 220 }} />
          <input placeholder="file filter: src/App.tsx" value={fileFilter} onChange={e => setFileFilter(e.target.value)} style={{ minWidth: 180 }} />
          <label className="label">limit <input type="number" min={50} max={3000} step={50} value={graphLimit} onChange={e => setGraphLimit(Math.max(50, Math.min(3000, Number(e.target.value) || 600)))} style={{ width: 80 }} /></label>
          <select value={layoutName} onChange={e => setLayoutName(e.target.value as any)}>
            <option value="cose">cluster</option>
            <option value="grid">grid</option>
            <option value="circle">circle</option>
          </select>
          <label className="label" title="Color nodes by: status (active/orphaned…), git churn (commit count → blue→red heat), or top author">heatmap
            <select value={metric} onChange={e => changeMetric(e.target.value as Metric)} style={{ marginLeft: 4 }}>
              <option value="status">status</option>
              <option value="churn">git churn</option>
              <option value="owner">owner</option>
            </select>
          </label>
          <button onClick={() => refreshGraph(workspace, filters)}>Apply graph filters</button>
        </div>
      )}

      {msg && <div className="card" style={{ padding: 8, fontSize: 12, color: 'var(--muted)' }}>{msg}</div>}
      {workspace && mcpStatus && mcpStatus.status !== 'running' && (
        <div className="banner warn">code-brain MCP is {mcpStatus.status}{mcpStatus.lastError ? `: ${mcpStatus.lastError.slice(0, 240)}` : ''}</div>
      )}

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
                    <button onClick={(e) => { e.stopPropagation(); openLocation(h.location); }} style={{ padding: '2px 6px', fontSize: 11 }}>Open</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {card ? <CardView card={card} onNavigate={loadCard} onOpen={openLocation} /> : (
            <div className="card" style={{ color: 'var(--muted)', fontSize: 12 }}>
              {workspace ? 'Click a node or a locate result to inspect a symbol.' : 'Open a folder to build its Atlas (symbols, edges, status tags).'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function CardView({ card, onNavigate, onOpen }: { card: Card; onNavigate: (ref: string) => void; onOpen: (ref: string) => void }) {
  const badge = STATUS_BADGE[card.status as AtlasStatus] ?? '';
  return (
    <div className="card col" style={{ gap: 8 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <strong style={{ color: 'var(--accent)' }}>{card.qualifiedName}</strong>
        <span className={`badge ${badge}`} style={!badge ? { color: 'var(--muted)' } : undefined}>{card.status}</span>
      </div>
      <div style={{ color: 'var(--muted)', fontSize: 11 }}>{card.kind} · {card.location} · {card.refCount} refs</div>
      {card.statusReason && <div className="banner info" style={{ fontSize: 12 }}>Why: {card.statusReason} Confidence: {card.confidence ?? 'unknown'}.</div>}
      <div className="row">
        <button onClick={() => onOpen(card.location)} style={{ padding: '3px 8px', fontSize: 11 }}>Open file</button>
      </div>
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
