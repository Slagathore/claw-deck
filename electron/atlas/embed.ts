// Embedding pass (Ollama-credit sink) — nomic-embed-text → float32 blobs in
// atlas_embeddings. Background + resumable: only embeds symbols that lack a
// vector, so it can be called repeatedly and resume after interruption. Gated:
// a one-shot probe fails fast (no crash) when Ollama/the model isn't available.
// Vectors power query.findSimilar (JS cosine) and the embedding-driven
// `superseded` pass below (the real "old-vs-new" guarantee once vectors exist).
//
// SCALE: embeddings are sent in BATCHES (Ollama /api/embed accepts an input array)
// run with bounded CONCURRENCY, and the near-duplicate pass buckets by name above a
// size threshold instead of an O(n²) all-pairs sweep — so a 10k-node repo doesn't
// stall the renderer.

import { Queryable } from './driver';

export interface EmbedOpts { baseUrl?: string; model?: string; max?: number; concurrency?: number; batchSize?: number }
export interface EmbedResult { ok: boolean; embedded: number; remaining: number; reason?: string }

/** Bounded-concurrency worker pool (JS is single-threaded, so DB writes inside the
 *  worker are naturally serialized; only the awaited fetches overlap). */
async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const idx = i++; await worker(items[idx]); } }));
}

/** Batched embed via Ollama /api/embed (input array). Returns one vector per input (null on miss). */
async function embedBatch(baseUrl: string, model: string, texts: string[]): Promise<(Float32Array | null)[]> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/embed`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: texts }),
    });
    if (!r.ok) return texts.map(() => null);
    const j: any = await r.json();
    const arrs: number[][] | undefined = j.embeddings;
    if (!Array.isArray(arrs)) return texts.map(() => null);
    return texts.map((_, i) => (arrs[i]?.length ? Float32Array.from(arrs[i]) : null));
  } catch { return texts.map(() => null); }
}

/** Single embed via the older /api/embeddings (prompt) — probe + per-item fallback. */
async function embedOne(baseUrl: string, model: string, text: string): Promise<Float32Array | null> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/embeddings`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: text }),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const arr: number[] | undefined = j.embedding ?? (Array.isArray(j.embeddings) ? j.embeddings[0] : undefined);
    return arr && arr.length ? Float32Array.from(arr) : null;
  } catch { return null; }
}

const toBlob = (v: Float32Array): Buffer => Buffer.from(v.buffer, v.byteOffset, v.byteLength);

const embedText = (r: any): string => `${r.kind} ${r.qn}\n${r.sig ?? ''}\n${r.summary ?? r.doc ?? ''}`.slice(0, 2000);

export async function embedPending(db: Queryable, opts: EmbedOpts = {}): Promise<EmbedResult> {
  const baseUrl = opts.baseUrl ?? 'http://localhost:11434';
  const model = opts.model ?? 'nomic-embed-text';
  const max = opts.max ?? 1000;
  const batchSize = Math.max(1, opts.batchSize ?? 48);
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const rows = db.prepare(`
    SELECT s.id, s.kind, s.qualified_name AS qn, s.signature AS sig, s.doc, s.summary
    FROM atlas_symbols s LEFT JOIN atlas_embeddings e ON e.symbol_id = s.id
    WHERE e.symbol_id IS NULL AND s.kind != 'module' LIMIT ?`).all(max) as any[];
  if (!rows.length) return { ok: true, embedded: 0, remaining: 0 };

  // probe: prefer the batch endpoint, fall back to the singular one.
  let batchOk = (await embedBatch(baseUrl, model, ['probe']))[0] != null;
  if (!batchOk && !(await embedOne(baseUrl, model, 'probe'))) {
    return { ok: false, embedded: 0, remaining: rows.length, reason: `embeddings unavailable — is "${model}" pulled and Ollama running at ${baseUrl}?` };
  }

  const ins = db.prepare(`INSERT OR REPLACE INTO atlas_embeddings(symbol_id, dim, vec) VALUES(?,?,?)`);
  let embedded = 0;
  const batches: any[][] = [];
  for (let i = 0; i < rows.length; i += batchSize) batches.push(rows.slice(i, i + batchSize));

  await pool(batches, concurrency, async (batch) => {
    const texts = batch.map(embedText);
    let vecs = batchOk ? await embedBatch(baseUrl, model, texts) : texts.map(() => null);
    if (batchOk && vecs.every((v) => !v)) { batchOk = false; vecs = texts.map(() => null); } // endpoint died → fall back
    if (vecs.every((v) => !v)) vecs = await Promise.all(texts.map((t) => embedOne(baseUrl, model, t)));
    batch.forEach((r, i) => { const v = vecs[i]; if (v) { ins.run(r.id, v.length, toBlob(v)); embedded++; } });
  });

  const remaining = (db.prepare(`SELECT COUNT(*) n FROM atlas_symbols s LEFT JOIN atlas_embeddings e ON e.symbol_id=s.id WHERE e.symbol_id IS NULL AND s.kind!='module'`).get() as { n: number }).n;
  return { ok: true, embedded, remaining };
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0; const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Once vectors exist: for each near-duplicate pair (cosine ≥ threshold) where one
 * sibling is referenced and the other is not, tag the zero-ref one `superseded`.
 *
 * SCALE: an all-pairs O(n²) sweep is fine for small repos but explodes at 10k nodes
 * (≈50M pairs). Above `fullPairsMax` we bucket candidates by simple name — a symbol
 * that supersedes another is almost always a same-named function moved/rewritten —
 * so we only compare within name buckets (and skip pathologically large ones).
 * Idempotent.
 */
export function applySupersededFromEmbeddings(db: Queryable, threshold = 0.93, fullPairsMax = 1500): number {
  const rows = db.prepare(`SELECT e.symbol_id AS id, e.vec AS vec, s.ref_count AS rc, s.status AS status, s.name AS name FROM atlas_embeddings e JOIN atlas_symbols s ON s.id = e.symbol_id`).all() as { id: number; vec: Uint8Array; rc: number; status: string; name: string }[];
  const vecs = rows.map((r) => ({ id: r.id, rc: r.rc, status: r.status, name: r.name, v: new Float32Array((r.vec as Uint8Array).buffer, (r.vec as Uint8Array).byteOffset, Math.floor((r.vec as Uint8Array).byteLength / 4)) }));
  const upd = db.prepare(`UPDATE atlas_symbols SET status='superseded', superseded_by=? WHERE id=? AND status NOT IN ('deprecated')`);
  let tagged = 0;
  const tagPair = (a: typeof vecs[number], b: typeof vecs[number]) => {
    if (cosine(a.v, b.v) < threshold) return;
    if (a.rc > 0 && b.rc === 0) { upd.run(a.id, b.id); tagged++; }
    else if (b.rc > 0 && a.rc === 0) { upd.run(b.id, a.id); tagged++; }
  };

  if (vecs.length <= fullPairsMax) {
    for (let i = 0; i < vecs.length; i++) for (let j = i + 1; j < vecs.length; j++) tagPair(vecs[i], vecs[j]);
  } else {
    // bucket by name; only compare within buckets (skip singletons + huge buckets)
    const buckets = new Map<string, typeof vecs>();
    for (const v of vecs) { const g = buckets.get(v.name); if (g) g.push(v); else buckets.set(v.name, [v]); }
    for (const g of buckets.values()) {
      if (g.length < 2 || g.length > 300) continue;
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) tagPair(g[i], g[j]);
    }
  }
  return tagged;
}
