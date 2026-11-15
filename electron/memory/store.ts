// Conversation memory: full chat threads plus a searchable index over them.
//
// Lives in the userData DB (clawdeck.db). Three layers:
//   threads / thread_messages   the durable transcript (source of truth)
//   memory_chunks + memory_fts  message text cut into passages, FTS5 keyword index
//   memory_vecs                 one normalized float32 embedding per passage
//
// Search is hybrid: FTS5 bm25 ranks and vector cosine ranks are fused with
// reciprocal rank fusion, so recall still works (keyword only) when no embedding
// model is pulled. Vectors are stored unit-length, so cosine is a plain dot
// product, and the scan pages through the table to keep memory bounded.
//
// Everything is typed against Queryable so the same SQL runs under better-sqlite3
// (Electron) and node:sqlite (vitest).

import { type Queryable, rowId } from '../atlas/driver';

export type ThreadKind = 'chat' | 'console';

export interface ThreadRow {
  id: string;
  kind: ThreadKind;
  title: string;
  created: number;
  updated: number;
  agent: number;
  backend: string | null;
  model: string | null;
  messageCount?: number;
  preview?: string;
  /** Present on search results: the passage that matched. */
  snippet?: string;
}

export interface MessageRow {
  id: number;
  threadId: string;
  seq: number;
  ts: number;
  role: 'user' | 'assistant';
  content: string;
  thinking: string;
  images: string[];
  meta: Record<string, any>;
}

export interface NewMessage {
  role: 'user' | 'assistant';
  content: string;
  thinking?: string;
  images?: string[];
  meta?: Record<string, any>;
  ts?: number;
}

export interface SearchHit {
  threadId: string;
  threadTitle: string;
  threadKind: ThreadKind;
  messageId: number;
  seq: number;
  role: string;
  ts: number;
  text: string;
  /** Fused rank score (higher is better). Only comparable within one search. */
  score: number;
  /** Cosine similarity to the query when vectors took part, else null. */
  sim: number | null;
  /** True when the passage also matched the keyword index. */
  lexical: boolean;
}

export interface MemorySchema { fts: boolean }

const CHUNK_TARGET = 1200;
const CHUNK_OVERLAP = 150;
/** Cap what a single message contributes to the index (a pasted log should not dominate it). */
const MAX_INDEXED_CHARS = 60_000;

export function migrateMemory(db: Queryable): MemorySchema {
  db.exec(`
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'chat',
      title TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL,
      updated INTEGER NOT NULL,
      agent INTEGER NOT NULL DEFAULT 0,
      backend TEXT,
      model TEXT,
      legacy_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated DESC);
    CREATE TABLE IF NOT EXISTS thread_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      thinking TEXT NOT NULL DEFAULT '',
      images TEXT NOT NULL DEFAULT '[]',
      meta TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id, seq);
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      thread_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_message ON memory_chunks(message_id);
    CREATE INDEX IF NOT EXISTS idx_memory_chunks_thread ON memory_chunks(thread_id);
    CREATE TABLE IF NOT EXISTS memory_vecs (
      chunk_id INTEGER PRIMARY KEY,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL,
      vec BLOB NOT NULL
    );
  `);
  let fts = true;
  try {
    db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(text, tokenize='porter unicode61')`);
  } catch { fts = false; } // SQLite built without FTS5: keyword search falls back to LIKE
  return { fts };
}

function hasFts(db: Queryable): boolean {
  try { return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE name='memory_fts'`).get(); } catch { return false; }
}

const txDepth = new WeakMap<object, number>();

/** Reentrant transaction: nested calls join the outer one. */
function tx<T>(db: Queryable, fn: () => T): T {
  const depth = txDepth.get(db) ?? 0;
  if (depth > 0) return fn();
  db.exec('BEGIN');
  txDepth.set(db, 1);
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { try { db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw e; }
  finally { txDepth.set(db, 0); }
}

// ---- pure helpers ----------------------------------------------------------

export function newThreadId(): string {
  return `t_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function titleFrom(text: string): string {
  const line = (text || '').replace(/\s+/g, ' ').trim();
  if (!line) return 'Untitled chat';
  return line.length > 64 ? line.slice(0, 61).trimEnd() + '…' : line;
}

/** Cut text into passages of roughly CHUNK_TARGET chars, preferring paragraph and
 *  sentence boundaries, with a small overlap so a fact split across a boundary is
 *  still retrievable from either side. */
export function chunkText(text: string, target = CHUNK_TARGET, overlap = CHUNK_OVERLAP): string[] {
  const src = (text || '').slice(0, MAX_INDEXED_CHARS).trim();
  if (!src) return [];
  if (src.length <= target) return [src];
  const out: string[] = [];
  let start = 0;
  while (start < src.length) {
    let end = Math.min(src.length, start + target);
    if (end < src.length) {
      const window = src.slice(start, end);
      const floor = Math.floor(target * 0.5);
      const para = window.lastIndexOf('\n\n');
      const line = window.lastIndexOf('\n');
      const sent = Math.max(window.lastIndexOf('. '), window.lastIndexOf('? '), window.lastIndexOf('! '));
      const space = window.lastIndexOf(' ');
      const cut = para >= floor ? para : line >= floor ? line : sent >= floor ? sent + 1 : space >= floor ? space : -1;
      if (cut > 0) end = start + cut;
    }
    const piece = src.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= src.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out;
}

const STOP = new Set(['the', 'and', 'for', 'that', 'this', 'with', 'you', 'was', 'are', 'but', 'not', 'what', 'did', 'have', 'has', 'had', 'how', 'why', 'when', 'where', 'who', 'can', 'could', 'would', 'should', 'about', 'from', 'into', 'our', 'your', 'their', 'there', 'then', 'than', 'them', 'they', 'were', 'will', 'just', 'does', 'any', 'all', 'its', 'tell', 'remember', 'said', 'say', 'please', 'which']);

/** Meaningful search terms from free text (lowercased, de-duplicated, stop words dropped). */
export function searchTerms(text: string, max = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of (text || '').toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 3 || STOP.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= max) break;
  }
  return out;
}

/** Build a safe FTS5 MATCH expression. Every term is quoted, so user text can
 *  never be parsed as FTS syntax. `all` requires every term (AND) instead of any (OR). */
export function ftsQuery(text: string, all = false): string | null {
  const terms = searchTerms(text, all ? 6 : 12);
  if (!terms.length) return null;
  return terms.map(t => `"${t.replace(/"/g, '""')}"`).join(all ? ' AND ' : ' OR ');
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n);
  if (!n) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

const toBlob = (v: Float32Array): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
function fromBlob(b: Uint8Array): Float32Array {
  // SQLite hands back a view into a pooled buffer that is not always 4-byte aligned.
  if (b.byteOffset % 4 === 0) return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4));
  const copy = b.slice();
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

const parseJson = <T>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

// ---- threads ---------------------------------------------------------------

const THREAD_COLS = `t.id, t.kind, t.title, t.created, t.updated, t.agent, t.backend, t.model`;

function toThread(r: any): ThreadRow {
  return {
    id: r.id, kind: r.kind, title: r.title, created: r.created, updated: r.updated,
    agent: r.agent, backend: r.backend ?? null, model: r.model ?? null,
    ...(r.message_count != null ? { messageCount: Number(r.message_count) } : {}),
    ...(r.preview != null ? { preview: String(r.preview) } : {}),
  };
}

function toMessage(r: any): MessageRow {
  return {
    id: Number(r.id), threadId: r.thread_id, seq: r.seq, ts: r.ts, role: r.role,
    content: r.content ?? '', thinking: r.thinking ?? '',
    images: parseJson<string[]>(r.images, []), meta: parseJson<Record<string, any>>(r.meta, {}),
  };
}

export function createThread(db: Queryable, opts: { id?: string; kind?: ThreadKind; title?: string; agent?: boolean; backend?: string | null; model?: string | null; ts?: number; legacyId?: number } = {}): ThreadRow {
  const id = opts.id ?? newThreadId();
  const ts = opts.ts ?? Date.now();
  db.prepare(`INSERT INTO threads(id,kind,title,created,updated,agent,backend,model,legacy_id) VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(id, opts.kind ?? 'chat', opts.title ?? '', ts, ts, opts.agent ? 1 : 0, opts.backend ?? null, opts.model ?? null, opts.legacyId ?? null);
  return { id, kind: opts.kind ?? 'chat', title: opts.title ?? '', created: ts, updated: ts, agent: opts.agent ? 1 : 0, backend: opts.backend ?? null, model: opts.model ?? null };
}

export function updateThread(db: Queryable, id: string, patch: { title?: string; agent?: boolean; backend?: string | null; model?: string | null }): void {
  const sets: string[] = [];
  const args: any[] = [];
  if (patch.title !== undefined) { sets.push('title = ?'); args.push(patch.title); }
  if (patch.agent !== undefined) { sets.push('agent = ?'); args.push(patch.agent ? 1 : 0); }
  if (patch.backend !== undefined) { sets.push('backend = ?'); args.push(patch.backend); }
  if (patch.model !== undefined) { sets.push('model = ?'); args.push(patch.model); }
  if (!sets.length) return;
  db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
}

/** Text that goes into the search index for a message, or '' to skip it. */
function indexableText(m: { role: string; content: string; meta?: Record<string, any> }): string {
  // Agent mode feeds step results back as synthetic user turns; they are noise for recall.
  if (m.role === 'user' && m.content.startsWith('[plan-results]')) return '';
  // A failed turn ("Error: Ollama HTTP 500 ...") is kept in the transcript but is not a memory.
  if (m.meta?.error) return '';
  return m.content;
}

function indexMessage(db: Queryable, messageId: number, threadId: string, text: string, fts: boolean): void {
  const chunks = chunkText(text);
  if (!chunks.length) return;
  const ins = db.prepare(`INSERT INTO memory_chunks(message_id,thread_id,idx,text) VALUES(?,?,?,?)`);
  const insFts = fts ? db.prepare(`INSERT INTO memory_fts(rowid,text) VALUES(?,?)`) : null;
  chunks.forEach((c, i) => {
    const id = rowId(ins.run(messageId, threadId, i, c));
    insFts?.run(id, c);
  });
}

function dropIndexWhere(db: Queryable, where: string, args: any[], fts: boolean): void {
  if (fts) db.prepare(`DELETE FROM memory_fts WHERE rowid IN (SELECT id FROM memory_chunks WHERE ${where})`).run(...args);
  db.prepare(`DELETE FROM memory_vecs WHERE chunk_id IN (SELECT id FROM memory_chunks WHERE ${where})`).run(...args);
  db.prepare(`DELETE FROM memory_chunks WHERE ${where}`).run(...args);
}

export function appendMessage(db: Queryable, threadId: string, msg: NewMessage): { id: number; seq: number } {
  const fts = hasFts(db);
  return tx(db, () => {
    const thread = db.prepare(`SELECT title FROM threads WHERE id = ?`).get(threadId) as { title: string } | undefined;
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const ts = msg.ts ?? Date.now();
    const seq = Number((db.prepare(`SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM thread_messages WHERE thread_id = ?`).get(threadId) as { n: number }).n);
    const id = rowId(db.prepare(`INSERT INTO thread_messages(thread_id,seq,ts,role,content,thinking,images,meta) VALUES(?,?,?,?,?,?,?,?)`)
      .run(threadId, seq, ts, msg.role, msg.content ?? '', msg.thinking ?? '', JSON.stringify(msg.images ?? []), JSON.stringify(msg.meta ?? {})));
    indexMessage(db, id, threadId, indexableText({ role: msg.role, content: msg.content ?? '', meta: msg.meta }), fts);
    if (!thread.title && msg.role === 'user' && msg.content.trim()) {
      db.prepare(`UPDATE threads SET title = ?, updated = ? WHERE id = ?`).run(titleFrom(msg.content), ts, threadId);
    } else {
      db.prepare(`UPDATE threads SET updated = ? WHERE id = ?`).run(ts, threadId);
    }
    return { id, seq };
  });
}

export function updateMessageMeta(db: Queryable, messageId: number, meta: Record<string, any>): void {
  db.prepare(`UPDATE thread_messages SET meta = ? WHERE id = ?`).run(JSON.stringify(meta ?? {}), messageId);
}

/** Drop every message at or after `fromSeq` (used when a turn is retried or re-planned). */
export function truncateThread(db: Queryable, threadId: string, fromSeq: number): void {
  const fts = hasFts(db);
  tx(db, () => {
    dropIndexWhere(db, `message_id IN (SELECT id FROM thread_messages WHERE thread_id = ? AND seq >= ?)`, [threadId, fromSeq], fts);
    db.prepare(`DELETE FROM thread_messages WHERE thread_id = ? AND seq >= ?`).run(threadId, fromSeq);
  });
}

export function deleteThread(db: Queryable, threadId: string): void {
  const fts = hasFts(db);
  tx(db, () => {
    dropIndexWhere(db, `thread_id = ?`, [threadId], fts);
    db.prepare(`DELETE FROM thread_messages WHERE thread_id = ?`).run(threadId);
    db.prepare(`DELETE FROM threads WHERE id = ?`).run(threadId);
  });
}

export function clearThreads(db: Queryable): void {
  const fts = hasFts(db);
  tx(db, () => {
    if (fts) db.exec(`DELETE FROM memory_fts`);
    db.exec(`DELETE FROM memory_vecs; DELETE FROM memory_chunks; DELETE FROM thread_messages; DELETE FROM threads;`);
  });
}

export function listThreads(db: Queryable, opts: { kind?: ThreadKind; limit?: number; offset?: number } = {}): ThreadRow[] {
  const where = opts.kind ? `WHERE t.kind = ?` : '';
  const args: any[] = opts.kind ? [opts.kind] : [];
  const rows = db.prepare(`
    SELECT ${THREAD_COLS},
      (SELECT COUNT(*) FROM thread_messages m WHERE m.thread_id = t.id) AS message_count,
      (SELECT substr(m.content, 1, 200) FROM thread_messages m WHERE m.thread_id = t.id ORDER BY m.seq DESC LIMIT 1) AS preview
    FROM threads t ${where} ORDER BY t.updated DESC LIMIT ? OFFSET ?`).all(...args, opts.limit ?? 200, opts.offset ?? 0);
  return rows.map(toThread);
}

export function countThreads(db: Queryable, kind?: ThreadKind): number {
  const r = kind
    ? db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE kind = ?`).get(kind)
    : db.prepare(`SELECT COUNT(*) AS n FROM threads`).get();
  return Number((r as { n: number }).n);
}

export function getThread(db: Queryable, id: string): { thread: ThreadRow; messages: MessageRow[] } | null {
  const t = db.prepare(`SELECT ${THREAD_COLS} FROM threads t WHERE t.id = ?`).get(id);
  if (!t) return null;
  const rows = db.prepare(`SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY seq`).all(id);
  return { thread: toThread(t), messages: rows.map(toMessage) };
}

/** Copy a thread up to and including `uptoSeq` into a new thread the user can take in another direction. */
export function branchThread(db: Queryable, id: string, uptoSeq?: number): ThreadRow | null {
  const src = getThread(db, id);
  if (!src) return null;
  const keep = src.messages.filter(m => uptoSeq == null || m.seq <= uptoSeq);
  return tx(db, () => {
    const t = createThread(db, { kind: src.thread.kind, title: `${src.thread.title || 'Untitled chat'} (branch)`, agent: !!src.thread.agent, backend: src.thread.backend, model: src.thread.model });
    for (const m of keep) appendMessage(db, t.id, { role: m.role, content: m.content, thinking: m.thinking, images: m.images, meta: m.meta, ts: m.ts });
    return t;
  });
}

/** One-time carry-over of the old per-turn `history` table: each row becomes a
 *  two-message thread. Tracked by legacy_id, so it is safe to call on every boot. */
export function importLegacyHistory(db: Queryable): number {
  let rows: any[];
  try {
    const done = Number((db.prepare(`SELECT COALESCE(MAX(legacy_id), 0) AS n FROM threads`).get() as { n: number }).n);
    rows = db.prepare(`SELECT * FROM history WHERE id > ? ORDER BY id`).all(done);
  } catch { return 0; } // no legacy table
  if (!rows.length) return 0;
  tx(db, () => {
    for (const r of rows) {
      const backend = String(r.backend ?? 'chat');
      const isConsole = backend.startsWith('console');
      const t = createThread(db, { kind: isConsole ? 'console' : 'chat', title: titleFrom(r.prompt ?? ''), agent: backend === 'agent', backend, model: r.model ?? null, ts: r.ts, legacyId: Number(r.id) });
      appendMessage(db, t.id, { role: 'user', content: r.prompt ?? '', ts: r.ts });
      appendMessage(db, t.id, { role: 'assistant', content: r.response ?? '', thinking: r.thinking ?? '', ts: r.ts, meta: backend === 'agent' ? { agent: true } : {} });
    }
  });
  return rows.length;
}

// ---- vectors ---------------------------------------------------------------

export function pendingChunks(db: Queryable, model: string, limit = 32): { id: number; text: string }[] {
  return db.prepare(`
    SELECT c.id, c.text FROM memory_chunks c LEFT JOIN memory_vecs v ON v.chunk_id = c.id
    WHERE v.chunk_id IS NULL OR v.model != ? ORDER BY c.id DESC LIMIT ?`).all(model, limit)
    .map((r: any) => ({ id: Number(r.id), text: String(r.text) }));
}

export function putVec(db: Queryable, chunkId: number, model: string, vec: Float32Array): void {
  const v = normalize(vec);
  db.prepare(`INSERT INTO memory_vecs(chunk_id,model,dim,vec) VALUES(?,?,?,?)
    ON CONFLICT(chunk_id) DO UPDATE SET model = excluded.model, dim = excluded.dim, vec = excluded.vec`).run(chunkId, model, v.length, toBlob(v));
}

export function indexStats(db: Queryable, model: string): { chunks: number; embedded: number; threads: number; messages: number } {
  const n = (sql: string, ...a: any[]) => Number((db.prepare(sql).get(...a) as { n: number }).n);
  return {
    chunks: n(`SELECT COUNT(*) AS n FROM memory_chunks`),
    embedded: n(`SELECT COUNT(*) AS n FROM memory_vecs WHERE model = ?`, model),
    threads: n(`SELECT COUNT(*) AS n FROM threads`),
    messages: n(`SELECT COUNT(*) AS n FROM thread_messages`),
  };
}

const VEC_PAGE = 2000;

/** Top-k passages by cosine against a unit-length query vector. Pages through the
 *  table so memory stays flat no matter how much history there is. */
export function searchVectors(db: Queryable, model: string, query: Float32Array, k: number): { chunkId: number; sim: number }[] {
  const q = normalize(query);
  const stmt = db.prepare(`SELECT chunk_id, vec FROM memory_vecs WHERE model = ? AND dim = ? AND chunk_id > ? ORDER BY chunk_id LIMIT ${VEC_PAGE}`);
  const top: { chunkId: number; sim: number }[] = [];
  let floor = -Infinity;
  let cursor = 0;
  for (;;) {
    const rows = stmt.all(model, q.length, cursor) as { chunk_id: number; vec: Uint8Array }[];
    if (!rows.length) break;
    for (const r of rows) {
      const v = fromBlob(r.vec);
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i] * v[i];
      if (dot > floor) {
        top.push({ chunkId: Number(r.chunk_id), sim: dot });
        // Prune now and then; the floor only rises once we hold a full top-k.
        if (top.length >= k * 4) { top.sort((a, b) => b.sim - a.sim); top.length = k; floor = top[k - 1].sim; }
      }
    }
    cursor = Number(rows[rows.length - 1].chunk_id);
    if (rows.length < VEC_PAGE) break;
  }
  top.sort((a, b) => b.sim - a.sim);
  return top.slice(0, k);
}

export function searchKeywords(db: Queryable, text: string, k: number, all = false): number[] {
  if (hasFts(db)) {
    const q = ftsQuery(text, all);
    if (!q) return [];
    try {
      return db.prepare(`SELECT rowid AS id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?`).all(q, k).map((r: any) => Number(r.id));
    } catch { return []; }
  }
  const terms = searchTerms(text, 6);
  if (!terms.length) return [];
  const like = terms.map(() => `text LIKE ?`).join(all ? ' AND ' : ' OR ');
  return db.prepare(`SELECT id FROM memory_chunks WHERE ${like} ORDER BY id DESC LIMIT ?`).all(...terms.map(t => `%${t}%`), k).map((r: any) => Number(r.id));
}

export interface SearchOpts {
  query: string;
  /** Embedding of the query, when an embedding model is available. */
  queryVec?: Float32Array | null;
  model?: string;
  k?: number;
  excludeThreadId?: string | null;
  kind?: ThreadKind;
  /** Only keep confident matches (used for automatic recall, where a weak hit is worse than none). */
  strict?: boolean;
  minSim?: number;
}

const RRF_K = 60;

export function searchMemory(db: Queryable, opts: SearchOpts): SearchHit[] {
  const k = opts.k ?? 8;
  const pool = Math.max(k * 5, 30);
  const useVec = !!(opts.queryVec && opts.model);
  const vecHits = useVec ? searchVectors(db, opts.model!, opts.queryVec!, pool) : [];
  // Strict mode without vectors has no similarity to gate on, so demand every term instead.
  const kwIds = searchKeywords(db, opts.query, pool, !!opts.strict && !vecHits.length);

  const scored = new Map<number, { score: number; sim: number | null; lexical: boolean }>();
  vecHits.forEach((h, i) => scored.set(h.chunkId, { score: 1 / (RRF_K + i + 1), sim: h.sim, lexical: false }));
  kwIds.forEach((id, i) => {
    const e = scored.get(id) ?? { score: 0, sim: null, lexical: false };
    e.score += 1 / (RRF_K + i + 1);
    e.lexical = true;
    scored.set(id, e);
  });
  if (!scored.size) return [];

  const ids = [...scored.keys()];
  const rows = db.prepare(`
    SELECT c.id AS chunk_id, c.text, c.message_id, m.seq, m.role, m.ts, t.id AS thread_id, t.title, t.kind
    FROM memory_chunks c JOIN thread_messages m ON m.id = c.message_id JOIN threads t ON t.id = c.thread_id
    WHERE c.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as any[];

  const minSim = opts.minSim ?? 0.55;
  const best = new Map<number, SearchHit>(); // one hit per message: its best passage
  for (const r of rows) {
    if (opts.excludeThreadId && r.thread_id === opts.excludeThreadId) continue;
    if (opts.kind && r.kind !== opts.kind) continue;
    const s = scored.get(Number(r.chunk_id))!;
    if (opts.strict && vecHits.length && !(s.sim != null && s.sim >= minSim)) continue;
    const hit: SearchHit = {
      threadId: r.thread_id, threadTitle: r.title || 'Untitled chat', threadKind: r.kind,
      messageId: Number(r.message_id), seq: r.seq, role: r.role, ts: r.ts, text: r.text,
      score: s.score, sim: s.sim, lexical: s.lexical,
    };
    const prev = best.get(hit.messageId);
    if (!prev || hit.score > prev.score) best.set(hit.messageId, hit);
  }
  return [...best.values()].sort((a, b) => b.score - a.score).slice(0, k);
}

/** Threads matching a search, best first, each carrying the passage that matched. */
export function searchThreads(db: Queryable, opts: SearchOpts & { limit?: number }): ThreadRow[] {
  const hits = searchMemory(db, { ...opts, k: 60 });
  const order: string[] = [];
  const snippet = new Map<string, string>();
  for (const h of hits) {
    if (!snippet.has(h.threadId)) { order.push(h.threadId); snippet.set(h.threadId, h.text); }
  }
  // Title matches count too (a thread can be found by its name alone).
  const terms = searchTerms(opts.query, 4);
  if (terms.length) {
    const like = terms.map(() => `title LIKE ?`).join(' AND ');
    const titled = db.prepare(`SELECT id FROM threads WHERE ${like} ORDER BY updated DESC LIMIT 20`).all(...terms.map(t => `%${t}%`)) as { id: string }[];
    for (const t of titled) if (!snippet.has(t.id)) { order.push(t.id); snippet.set(t.id, ''); }
  }
  const out: ThreadRow[] = [];
  const one = db.prepare(`
    SELECT ${THREAD_COLS},
      (SELECT COUNT(*) FROM thread_messages m WHERE m.thread_id = t.id) AS message_count
    FROM threads t WHERE t.id = ?`);
  for (const id of order.slice(0, opts.limit ?? 50)) {
    const r = one.get(id);
    if (!r) continue;
    if (opts.kind && r.kind !== opts.kind) continue;
    out.push({ ...toThread(r), snippet: snippet.get(id) || undefined });
  }
  return out;
}
