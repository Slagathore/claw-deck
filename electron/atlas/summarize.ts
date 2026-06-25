// Per-symbol card summaries (Ollama-credit sink) — a cheap CHAT model writes a
// one-line "what this is / why it exists" into atlas_symbols.summary. Background
// + resumable (only summarizes rows with summary IS NULL). Gated: fails fast and
// never crashes when the model/Ollama is unavailable.

import { Queryable } from './driver';

export interface SummarizeOpts { baseUrl?: string; model?: string; max?: number; concurrency?: number }
export interface SummarizeResult { ok: boolean; summarized: number; remaining: number; reason?: string }

/** Bounded-concurrency worker pool — overlaps the (slow) model calls; DB writes stay
 *  serialized on the single JS thread. The big win for summarizing 10k symbols. */
async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const idx = i++; await worker(items[idx]); } }));
}

const SYSTEM = 'You write one terse sentence (max 20 words) describing what a code symbol does and why it exists. No preamble, no markdown, just the sentence.';

async function chatOne(baseUrl: string, model: string, user: string): Promise<string | null> {
  try {
    const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: false, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }] }),
    });
    if (!r.ok) return null;
    const j: any = await r.json();
    const text: string | undefined = j.message?.content ?? j.choices?.[0]?.message?.content;
    return text ? text.replace(/\s+/g, ' ').trim().slice(0, 240) : null;
  } catch { return null; }
}

export async function summarizePending(db: Queryable, opts: SummarizeOpts = {}): Promise<SummarizeResult> {
  const baseUrl = opts.baseUrl ?? 'http://localhost:11434';
  const model = opts.model ?? 'llama3.2';
  const max = opts.max ?? 500;
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  const rows = db.prepare(`SELECT s.id, s.kind, s.qualified_name AS qn, s.signature AS sig, s.doc, f.path AS file
    FROM atlas_symbols s JOIN atlas_files f ON f.id = s.file_id
    WHERE s.summary IS NULL AND s.kind != 'module' LIMIT ?`).all(max) as any[];
  if (!rows.length) return { ok: true, summarized: 0, remaining: 0 };

  if (!(await chatOne(baseUrl, model, 'reply with the single word: ok'))) {
    return { ok: false, summarized: 0, remaining: rows.length, reason: `summaries unavailable — is "${model}" available at ${baseUrl}?` };
  }

  const upd = db.prepare(`UPDATE atlas_symbols SET summary = ? WHERE id = ?`);
  let summarized = 0;
  await pool(rows, concurrency, async (r) => {
    const prompt = `File: ${r.file}\n${r.kind} ${r.qn}\nSignature: ${r.sig ?? ''}\nDoc: ${r.doc ?? '(none)'}`;
    const s = await chatOne(baseUrl, model, prompt);
    if (s) { upd.run(s, r.id); summarized++; }
  });
  const remaining = (db.prepare(`SELECT COUNT(*) n FROM atlas_symbols WHERE summary IS NULL AND kind!='module'`).get() as { n: number }).n;
  return { ok: true, summarized, remaining };
}
