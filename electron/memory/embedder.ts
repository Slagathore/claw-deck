// Background embedder for conversation memory. Passages are written to the DB
// synchronously (so keyword search works at once) and embedded here afterwards,
// in batches, off the hot path. It is resumable: it only ever asks "which passages
// have no vector for the current model", so an interrupted run, a newly pulled
// embedding model, or a change of model all converge the same way.
//
// Embeddings go to the local Ollama instance only. If the model is missing or
// Ollama is down the embedder backs off and search stays keyword only.

import { getDb } from '../ipc/db';
import { getSetting } from '../ipc/settings';
import { embedBatch } from '../atlas/embed';
import { pendingChunks, putVec } from './store';
import { type Queryable } from '../atlas/driver';

const BATCH = 32;
const RETRY_MS = 5 * 60_000;
const QUERY_TIMEOUT_MS = 6000;

const state = { running: false, again: false, available: null as boolean | null, lastError: '', retryAt: 0 };
let timer: NodeJS.Timeout | undefined;

const db = () => getDb() as unknown as Queryable;
export const embedModel = (): string => getSetting<string>('embedModel', 'nomic-embed-text') || 'nomic-embed-text';
const baseUrl = (): string => getSetting<string>('ollamaUrl', 'http://localhost:11434') || 'http://localhost:11434';

// nomic-embed models are trained with task prefixes; using them measurably improves retrieval.
const prefixed = (model: string, kind: 'document' | 'query', text: string) =>
  /nomic-embed/i.test(model) ? `search_${kind}: ${text}` : text;

export function embedderStatus() {
  return { available: state.available, lastError: state.lastError, running: state.running, model: embedModel() };
}

/** Schedule an embedding pass. `force` ignores the failure backoff (the user asked for it). */
export function kickEmbedder(delayMs = 1200, force = false): void {
  if (force) state.retryAt = 0;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void run(); }, delayMs);
}

async function run(): Promise<void> {
  if (state.running) { state.again = true; return; }
  if (Date.now() < state.retryAt) return;
  state.running = true;
  try {
    const model = embedModel();
    for (;;) {
      const rows = pendingChunks(db(), model, BATCH);
      if (!rows.length) break;
      const vecs = await embedBatch(baseUrl(), model, rows.map(r => prefixed(model, 'document', r.text)));
      if (vecs.every(v => !v)) {
        state.available = false;
        state.lastError = `Embedding model "${model}" did not respond. Pull it in Ollama to turn on semantic recall.`;
        state.retryAt = Date.now() + RETRY_MS;
        return;
      }
      state.available = true;
      state.lastError = '';
      let wrote = 0;
      rows.forEach((r, i) => { const v = vecs[i]; if (v) { putVec(db(), r.id, model, v); wrote++; } });
      if (!wrote) break; // nothing landed; do not spin on the same batch
    }
  } catch (e: any) {
    state.lastError = String(e?.message ?? e);
    state.retryAt = Date.now() + RETRY_MS;
  } finally {
    state.running = false;
    if (state.again) { state.again = false; kickEmbedder(200); }
  }
}

const queryCache = new Map<string, Float32Array>();

/** Embed a search query, or null when embeddings are unavailable (callers fall back to keywords). */
export async function embedQuery(text: string): Promise<{ vec: Float32Array; model: string } | null> {
  const model = embedModel();
  const q = (text || '').trim().slice(0, 2000);
  if (!q) return null;
  if (state.available === false && Date.now() < state.retryAt) return null;
  const key = `${model}\n${q}`;
  const hit = queryCache.get(key);
  if (hit) return { vec: hit, model };
  const timeout = new Promise<null>(res => setTimeout(() => res(null), QUERY_TIMEOUT_MS));
  const vecs = await Promise.race([embedBatch(baseUrl(), model, [prefixed(model, 'query', q)]), timeout]);
  const v = vecs?.[0] ?? null;
  if (!v) return null;
  state.available = true;
  if (queryCache.size >= 64) queryCache.delete(queryCache.keys().next().value as string);
  queryCache.set(key, v);
  return { vec: v, model };
}
