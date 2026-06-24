// Atlas read queries — driver-agnostic (Queryable) so they run under better-sqlite3
// (Electron IPC), node:sqlite (the code-brain MCP server), and vitest.
// These back both the code-brain MCP tools (§4.4) and the Project Brain UI.

import { Queryable } from './driver';
import { SymbolCard, SymbolStatus } from './types';

const SYM_SELECT = `
SELECT s.id, s.key, s.name, s.qualified_name AS qualifiedName, s.kind, s.signature,
       s.summary, s.doc, s.status, s.ref_count AS refCount, s.start_line AS startLine,
       s.superseded_by AS supersededBy, f.path AS file, f.git_last_date AS gitLastDate
FROM atlas_symbols s JOIN atlas_files f ON f.id = s.file_id`;

export interface SymRow {
  id: number; key: string; name: string; qualifiedName: string; kind: string;
  signature: string | null; summary: string | null; doc: string | null;
  status: SymbolStatus; refCount: number; startLine: number;
  supersededBy: number | null; file: string; gitLastDate: number | null;
}

const loc = (file: string, line: number) => `${file}:${line}`;

/** Resolve a free-form reference (key | qualified_name | name | file:line) to rows. */
export function resolveSymbols(db: Queryable, ref: string): SymRow[] {
  const exact = db.prepare(`${SYM_SELECT} WHERE s.key = ? OR s.qualified_name = ?`).all(ref, ref) as SymRow[];
  if (exact.length) return exact;
  if (ref.includes(':')) {
    const [file, lineStr] = ref.split(':');
    const line = Number(lineStr);
    if (file && Number.isFinite(line)) {
      const byLoc = db.prepare(`${SYM_SELECT} WHERE f.path = ? AND ? BETWEEN s.start_line AND s.end_line ORDER BY (s.end_line - s.start_line) ASC`).all(file, line) as SymRow[];
      if (byLoc.length) return byLoc;
    }
  }
  return db.prepare(`${SYM_SELECT} WHERE s.name = ? ORDER BY s.ref_count DESC`).all(ref) as SymRow[];
}

const first = (rows: SymRow[]) => (rows.length ? rows[0] : null);

/** Keyword-scored locate over name/qualified_name/file/doc/summary (no embeddings needed). */
export function locate(db: Queryable, description: string, limit = 10): { location: string; name: string; kind: string; status: string; score: number }[] {
  const terms = description.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  if (!terms.length) return [];
  const rows = db.prepare(`${SYM_SELECT} WHERE s.kind != 'module'`).all() as SymRow[];
  const scored = rows.map((r) => {
    const hay = `${r.name} ${r.qualifiedName} ${r.file} ${r.doc ?? ''} ${r.summary ?? ''}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (r.name.toLowerCase() === t) score += 5;
      else if (r.name.toLowerCase().includes(t)) score += 3;
      if (r.file.toLowerCase().includes(t)) score += 2;
      if (hay.includes(t)) score += 1;
    }
    if (r.status === 'orphaned' || r.status === 'superseded') score -= 1;
    return { location: loc(r.file, r.startLine), name: r.qualifiedName, kind: r.kind, status: r.status, score };
  }).filter((r) => r.score > 0);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

export function findSymbol(db: Queryable, name: string): { location: string; name: string; kind: string; status: string }[] {
  const rows = db.prepare(`${SYM_SELECT} WHERE s.name = ? OR s.name LIKE ? ORDER BY (s.name = ?) DESC, s.ref_count DESC LIMIT 50`)
    .all(name, `${name}%`, name) as SymRow[];
  return rows.map((r) => ({ location: loc(r.file, r.startLine), name: r.qualifiedName, kind: r.kind, status: r.status }));
}

function neighbours(db: Queryable, id: number, dir: 'in' | 'out'): { name: string; location: string }[] {
  const sql = dir === 'in'
    ? `SELECT s.qualified_name AS name, f.path AS file, s.start_line AS line FROM atlas_edges e JOIN atlas_symbols s ON s.id = e.src JOIN atlas_files f ON f.id = s.file_id WHERE e.dst = ? AND e.kind IN ('calls','references')`
    : `SELECT s.qualified_name AS name, f.path AS file, s.start_line AS line FROM atlas_edges e JOIN atlas_symbols s ON s.id = e.dst JOIN atlas_files f ON f.id = s.file_id WHERE e.src = ? AND e.kind IN ('calls','references')`;
  const rows = db.prepare(sql).all(id) as { name: string; file: string; line: number }[];
  return rows.map((r) => ({ name: r.name, location: loc(r.file, r.line) }));
}

export function whoCalls(db: Queryable, ref: string): { name: string; location: string }[] {
  const s = first(resolveSymbols(db, ref));
  return s ? neighbours(db, s.id, 'in') : [];
}

export function callsWhat(db: Queryable, ref: string): { name: string; location: string }[] {
  const s = first(resolveSymbols(db, ref));
  return s ? neighbours(db, s.id, 'out') : [];
}

export function getCard(db: Queryable, ref: string): SymbolCard | null {
  const s = first(resolveSymbols(db, ref));
  if (!s) return null;
  let supersededByLoc: string | null = null;
  if (s.supersededBy) {
    const sup = db.prepare(`${SYM_SELECT} WHERE s.id = ?`).all(s.supersededBy) as SymRow[];
    if (sup.length) supersededByLoc = loc(sup[0].file, sup[0].startLine);
  }
  return {
    id: s.id, name: s.name, qualifiedName: s.qualifiedName, kind: s.kind as SymbolCard['kind'],
    signature: s.signature ?? undefined, summary: s.summary, doc: s.doc,
    location: loc(s.file, s.startLine), status: s.status, supersededBy: supersededByLoc,
    refCount: s.refCount, gitLastDate: s.gitLastDate,
    callers: neighbours(db, s.id, 'in'), callees: neighbours(db, s.id, 'out'),
  };
}

export function isCurrent(db: Queryable, ref: string): { status: SymbolStatus; supersededBy: string | null } | null {
  const s = first(resolveSymbols(db, ref));
  if (!s) return null;
  let supersededByLoc: string | null = null;
  if (s.supersededBy) {
    const sup = db.prepare(`${SYM_SELECT} WHERE s.id = ?`).all(s.supersededBy) as SymRow[];
    if (sup.length) supersededByLoc = loc(sup[0].file, sup[0].startLine);
  }
  return { status: s.status, supersededBy: supersededByLoc };
}

function decodeVec(blob: unknown): Float32Array | null {
  if (!blob) return null;
  const u8 = blob instanceof Uint8Array ? blob : (Buffer.isBuffer(blob) ? blob : null);
  if (!u8) return null;
  return new Float32Array(u8.buffer, u8.byteOffset, Math.floor(u8.byteLength / 4));
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Embedding cosine when vectors exist; otherwise same-name look-alikes in other files. */
export function findSimilar(db: Queryable, ref: string, limit = 8): { location: string; name: string; status: string; score: number }[] {
  const s = first(resolveSymbols(db, ref));
  if (!s) return [];
  const myVecRow = db.prepare(`SELECT vec FROM atlas_embeddings WHERE symbol_id = ?`).get(s.id) as { vec: unknown } | undefined;
  const myVec = decodeVec(myVecRow?.vec);
  if (myVec) {
    const rows = db.prepare(`SELECT e.symbol_id AS id, e.vec AS vec, sy.qualified_name AS name, sy.status AS status, sy.start_line AS line, f.path AS file
      FROM atlas_embeddings e JOIN atlas_symbols sy ON sy.id = e.symbol_id JOIN atlas_files f ON f.id = sy.file_id WHERE e.symbol_id != ?`).all(s.id) as any[];
    return rows.map((r) => ({ location: loc(r.file, r.line), name: r.name, status: r.status, score: cosine(myVec, decodeVec(r.vec)!) }))
      .sort((a, b) => b.score - a.score).slice(0, limit);
  }
  const rows = db.prepare(`${SYM_SELECT} WHERE s.name = ? AND s.id != ?`).all(s.name, s.id) as SymRow[];
  return rows.map((r) => ({ location: loc(r.file, r.startLine), name: r.qualifiedName, status: r.status, score: 1 })).slice(0, limit);
}

export function statusCounts(db: Queryable): { total: number; byStatus: Record<string, number>; files: number; edges: number } {
  const rows = db.prepare(`SELECT status, COUNT(*) AS n FROM atlas_symbols WHERE kind != 'module' GROUP BY status`).all() as { status: string; n: number }[];
  const byStatus: Record<string, number> = { active: 0, orphaned: 0, deprecated: 0, superseded: 0 };
  let total = 0;
  for (const r of rows) { byStatus[r.status] = r.n; total += r.n; }
  const files = (db.prepare(`SELECT COUNT(*) AS n FROM atlas_files`).get() as { n: number }).n;
  const edges = (db.prepare(`SELECT COUNT(*) AS n FROM atlas_edges`).get() as { n: number }).n;
  return { total, byStatus, files, edges };
}

export interface GraphNode { id: string; label: string; kind: string; status: string; file: string; line: number; refCount: number; }
export interface GraphEdge { source: string; target: string; kind: string; }

/** Graph for cytoscape, optionally filtered to a set of statuses and/or a file. */
export function graph(db: Queryable, opts: { statuses?: SymbolStatus[]; file?: string; limit?: number } = {}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const limit = opts.limit ?? 1500;
  const where: string[] = [`s.kind != 'module'`];
  const params: any[] = [];
  if (opts.statuses && opts.statuses.length) { where.push(`s.status IN (${opts.statuses.map(() => '?').join(',')})`); params.push(...opts.statuses); }
  if (opts.file) { where.push(`f.path = ?`); params.push(opts.file); }
  const rows = db.prepare(`${SYM_SELECT} WHERE ${where.join(' AND ')} ORDER BY s.ref_count DESC LIMIT ?`).all(...params, limit) as SymRow[];
  const nodes: GraphNode[] = rows.map((r) => ({ id: String(r.id), label: r.name, kind: r.kind, status: r.status, file: r.file, line: r.startLine, refCount: r.refCount }));
  const ids = new Set(nodes.map((n) => n.id));
  const edgeRows = db.prepare(`SELECT src, dst, kind FROM atlas_edges`).all() as { src: number; dst: number; kind: string }[];
  const edges: GraphEdge[] = edgeRows
    .filter((e) => ids.has(String(e.src)) && ids.has(String(e.dst)))
    .map((e) => ({ source: String(e.src), target: String(e.dst), kind: e.kind }));
  return { nodes, edges };
}
