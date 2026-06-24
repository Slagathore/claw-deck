// Embedding pass (Ollama-credit sink) — nomic-embed-text → float32 blobs in
// atlas_embeddings. Background + resumable: only embeds symbols that lack a
// vector, so it can be called repeatedly and resume after interruption. Gated:
// a one-shot probe fails fast (no crash) when Ollama/the model isn't available.
// Vectors power query.findSimilar (JS cosine) and the embedding-driven
// `superseded` pass below (the real "old-vs-new" guarantee once vectors exist).

import { Queryable } from './driver';

export interface EmbedOpts { baseUrl?: string; model?: string; max?: number }
export interface EmbedResult { ok: boolean; embedded: number; remaining: number; reason?: string }

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

export async function embedPending(db: Queryable, opts: EmbedOpts = {}): Promise<EmbedResult> {
  const baseUrl = opts.baseUrl ?? 'http://localhost:11434';
  const model = opts.model ?? 'nomic-embed-text';
  const max = opts.max ?? 200;
  const rows = db.prepare(`
    SELECT s.id, s.kind, s.qualified_name AS qn, s.signature AS sig, s.doc, s.summary
    FROM atlas_symbols s LEFT JOIN atlas_embeddings e ON e.symbol_id = s.id
    WHERE e.symbol_id IS NULL AND s.kind != 'module' LIMIT ?`).all(max) as any[];
  if (!rows.length) return { ok: true, embedded: 0, remaining: 0 };

  if (!(await embedOne(baseUrl, model, 'probe'))) {
    return { ok: false, embedded: 0, remaining: rows.length, reason: `embeddings unavailable — is "${model}" pulled and Ollama running at ${baseUrl}?` };
  }

  const ins = db.prepare(`INSERT OR REPLACE INTO atlas_embeddings(symbol_id, dim, vec) VALUES(?,?,?)`);
  let embedded = 0;
  for (const r of rows) {
    const text = `${r.kind} ${r.qn}\n${r.sig ?? ''}\n${r.summary ?? r.doc ?? ''}`.slice(0, 2000);
    const vec = await embedOne(baseUrl, model, text);
    if (!vec) continue;
    ins.run(r.id, vec.length, toBlob(vec));
    embedded++;
  }
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
 * Closes the embedding-cluster half of the staleness guarantee (the structural
 * pass only seeds it via injected pairs). Idempotent.
 */
export function applySupersededFromEmbeddings(db: Queryable, threshold = 0.93): number {
  const rows = db.prepare(`SELECT e.symbol_id AS id, e.vec AS vec, s.ref_count AS rc, s.status AS status FROM atlas_embeddings e JOIN atlas_symbols s ON s.id = e.symbol_id`).all() as { id: number; vec: Uint8Array | Buffer; rc: number; status: string }[];
  const vecs = rows.map((r) => ({ id: r.id, rc: r.rc, status: r.status, v: new Float32Array((r.vec as Uint8Array).buffer, (r.vec as Uint8Array).byteOffset, Math.floor((r.vec as Uint8Array).byteLength / 4)) }));
  const upd = db.prepare(`UPDATE atlas_symbols SET status='superseded', superseded_by=? WHERE id=? AND status NOT IN ('deprecated')`);
  let tagged = 0;
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      if (cosine(vecs[i].v, vecs[j].v) < threshold) continue;
      const a = vecs[i], b = vecs[j];
      if (a.rc > 0 && b.rc === 0) { upd.run(a.id, b.id); tagged++; }
      else if (b.rc > 0 && a.rc === 0) { upd.run(b.id, a.id); tagged++; }
    }
  }
  return tagged;
}
