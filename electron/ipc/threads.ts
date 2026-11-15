import { ipcMain } from 'electron';
import { getDb } from './db';
import { type Queryable } from '../atlas/driver';
import {
  type NewMessage, type SearchHit, type ThreadKind,
  appendMessage, branchThread, clearThreads, countThreads, createThread, deleteThread, getThread,
  importLegacyHistory, indexStats, listThreads, migrateMemory, searchMemory, searchThreads,
  titleFrom, truncateThread, updateMessageMeta, updateThread,
} from '../memory/store';
import { embedModel, embedQuery, embedderStatus, kickEmbedder } from '../memory/embedder';

const db = () => getDb() as unknown as Queryable;

/** Create the memory tables, carry over the old per-turn history, and start embedding. */
export function initMemory(): void {
  migrateMemory(db());
  try { importLegacyHistory(db()); } catch { /* a failed carry-over must not block startup */ }
  kickEmbedder(4000);
}

async function search(opts: { query: string; k?: number; excludeThreadId?: string | null; kind?: ThreadKind; strict?: boolean }): Promise<SearchHit[]> {
  const q = (opts.query || '').trim();
  if (!q) return [];
  const emb = await embedQuery(q).catch(() => null);
  return searchMemory(db(), { ...opts, query: q, queryVec: emb?.vec, model: emb?.model });
}

const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);

// ---- tools the chat model can call to look things up in past conversations ----

export const MEMORY_TOOLS = [
  { type: 'function', function: {
    name: 'search_history',
    description: 'Search every past conversation and console session saved in Claw Deck (keyword plus semantic). Use it whenever the user refers to something said, decided, or run earlier that is not in the current chat.',
    parameters: { type: 'object', properties: {
      query: { type: 'string', description: 'What to look for, in plain words.' },
      limit: { type: 'integer', description: 'How many excerpts to return (default 6, max 15).' },
    }, required: ['query'] },
  } },
  { type: 'function', function: {
    name: 'read_thread',
    description: 'Read the messages of one saved conversation by its thread id (from search_history or list_threads).',
    parameters: { type: 'object', properties: {
      thread_id: { type: 'string' },
      around_seq: { type: 'integer', description: 'Optional message number to centre on, for long threads.' },
    }, required: ['thread_id'] },
  } },
  { type: 'function', function: {
    name: 'list_threads',
    description: 'List the most recent saved conversations (title, date, thread id).',
    parameters: { type: 'object', properties: { limit: { type: 'integer', description: 'Default 15, max 50.' } }, required: [] },
  } },
] as const;

export async function callMemoryTool(name: string, args: any, ctx: { excludeThreadId?: string | null } = {}): Promise<string> {
  try {
    if (name === 'search_history') {
      const k = Math.max(1, Math.min(15, Number(args?.limit) || 6));
      const hits = await search({ query: String(args?.query ?? ''), k, excludeThreadId: ctx.excludeThreadId });
      if (!hits.length) return 'No matching history found.';
      return hits.map((h, i) => `[${i + 1}] ${day(h.ts)} · "${h.threadTitle}" (thread ${h.threadId}, message ${h.seq}, ${h.role})\n${h.text}`).join('\n\n');
    }
    if (name === 'read_thread') {
      const t = getThread(db(), String(args?.thread_id ?? ''));
      if (!t) return 'No thread with that id.';
      let msgs = t.messages;
      const around = Number(args?.around_seq);
      if (Number.isFinite(around) && msgs.length > 12) msgs = msgs.filter(m => Math.abs(m.seq - around) <= 6);
      const body = msgs.map(m => `#${m.seq} ${m.role}: ${m.content}`).join('\n\n');
      return `"${t.thread.title}" (${day(t.thread.created)}, ${t.messages.length} messages)\n\n${body}`.slice(0, 7000);
    }
    if (name === 'list_threads') {
      const limit = Math.max(1, Math.min(50, Number(args?.limit) || 15));
      const rows = listThreads(db(), { limit });
      if (!rows.length) return 'No saved conversations yet.';
      return rows.map(r => `${day(r.updated)} · "${r.title || 'Untitled chat'}" (thread ${r.id}, ${r.kind}, ${r.messageCount ?? 0} messages)`).join('\n');
    }
    return `Unknown tool "${name}".`;
  } catch (e: any) {
    return `Tool error: ${e?.message ?? e}`;
  }
}

export function registerThreadHandlers() {
  ipcMain.handle('threads:list', async (_e, q?: { search?: string; kind?: ThreadKind; limit?: number }) => {
    const s = (q?.search || '').trim();
    if (!s) return listThreads(db(), { kind: q?.kind, limit: q?.limit });
    const emb = await embedQuery(s).catch(() => null);
    return searchThreads(db(), { query: s, queryVec: emb?.vec, model: emb?.model, kind: q?.kind, limit: q?.limit });
  });

  ipcMain.handle('threads:count', (_e, kind?: ThreadKind) => countThreads(db(), kind));

  ipcMain.handle('threads:get', (_e, id: string) => getThread(db(), id));

  ipcMain.handle('threads:create', (_e, opts: { kind?: ThreadKind; title?: string; agent?: boolean; backend?: string; model?: string }) =>
    createThread(db(), opts ?? {}));

  ipcMain.handle('threads:append', (_e, threadId: string, msg: NewMessage) => {
    const r = appendMessage(db(), threadId, msg);
    kickEmbedder();
    return r;
  });

  ipcMain.handle('threads:setMeta', (_e, messageId: number, meta: Record<string, any>) => {
    updateMessageMeta(db(), messageId, meta);
    return true;
  });

  ipcMain.handle('threads:truncate', (_e, threadId: string, fromSeq: number) => {
    truncateThread(db(), threadId, fromSeq);
    return true;
  });

  ipcMain.handle('threads:update', (_e, id: string, patch: { title?: string; agent?: boolean; backend?: string; model?: string }) => {
    updateThread(db(), id, patch ?? {});
    return true;
  });

  ipcMain.handle('threads:branch', (_e, id: string, uptoSeq?: number) => {
    const t = branchThread(db(), id, uptoSeq);
    kickEmbedder();
    return t;
  });

  ipcMain.handle('threads:delete', (_e, id: string) => { deleteThread(db(), id); return true; });

  ipcMain.handle('threads:clear', () => { clearThreads(db()); return true; });

  ipcMain.handle('threads:search', (_e, opts: { query: string; k?: number; excludeThreadId?: string | null; kind?: ThreadKind; strict?: boolean }) =>
    search(opts ?? { query: '' }));

  ipcMain.handle('threads:indexStatus', () => ({ ...indexStats(db(), embedModel()), ...embedderStatus() }));

  ipcMain.handle('threads:reindex', () => { kickEmbedder(0, true); return true; });

  // One-shot record (a finished console session): stored as its own two-message thread.
  ipcMain.handle('history:add', (_e, entry: any) => {
    const backend = String(entry?.backend ?? 'chat');
    const t = createThread(db(), {
      kind: backend.startsWith('console') ? 'console' : 'chat',
      title: titleFrom(entry?.prompt ?? ''), backend, model: entry?.model ?? null,
    });
    appendMessage(db(), t.id, { role: 'user', content: entry?.prompt ?? '', meta: entry?.meta ?? {} });
    appendMessage(db(), t.id, { role: 'assistant', content: entry?.response ?? '', thinking: entry?.thinking ?? '' });
    kickEmbedder();
    return t.id;
  });
}
