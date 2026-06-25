// Atlas IPC — one DB + one watcher + one code-brain MCP server per workspace.
// Channels (BOOTSTRAP §1 Phase-1 file list): atlas:open / index / status /
// query / graph / card / enrich / close. New `atlas` namespace = a superset of
// window.api; no existing contract is touched.

import { ipcMain, BrowserWindow } from 'electron';
import * as path from 'path';
import * as crypto from 'crypto';
import { getDb } from './db';
import { getSetting } from './settings';
import { openAtlas, closeAtlas, getOpenAtlas, asQueryable, atlasDbPath, sqliteVecAvailable } from '../atlas/db';
import { scanWorkspace, writeIndex } from '../atlas/index';
import { watchWorkspace, Watcher } from '../atlas/watch';
import { embedPending, applySupersededFromEmbeddings } from '../atlas/embed';
import { summarizePending } from '../atlas/summarize';
import * as q from '../atlas/query';
import { SymbolStatus } from '../atlas/types';

const watchers = new Map<string, Watcher>();
const keyOf = (ws: string) => path.resolve(ws);

// --- settings helpers (getSetting is shared so DEFAULTS apply) --------------
function setSetting(key: string, value: unknown): void {
  getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value));
}

interface McpServer { name: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled?: boolean }

/** Ensure this workspace has a code-brain MCP server entry pointing at its Atlas DB. */
function ensureCodeBrainServer(workspace: string): string {
  const short = crypto.createHash('sha1').update(keyOf(workspace)).digest('hex').slice(0, 8);
  const name = `code-brain:${path.basename(workspace)}:${short}`;
  const servers = getSetting<McpServer[]>('mcpServers', []);
  if (servers.some((s) => s.name === name)) return name;
  // compiled standalone server: dist-electron/atlas/codeBrainServer.js
  const serverJs = path.join(__dirname, '..', 'atlas', 'codeBrainServer.js');
  servers.push({ name, command: 'node', args: [serverJs, '--db', atlasDbPath(workspace)], cwd: workspace, enabled: true, env: {} });
  setSetting('mcpServers', servers);
  return name;
}

function doIndex(workspace: string) {
  const db = asQueryable(openAtlas(workspace));
  const { parse, fileMeta, entryFiles } = scanWorkspace(workspace);
  return writeIndex(db, { parse, fileMeta, entryFiles }, Date.now());
}

// Background enrichment (embeddings → superseded clustering → summaries) kicked
// off after every index. Guarded (one pass per workspace at a time), gated (each
// pass fails soft when Ollama/the model is unavailable), non-blocking.
const enriching = new Set<string>();
async function runEnrichment(workspace: string, emit: (p: unknown) => void): Promise<void> {
  const k = keyOf(workspace);
  if (enriching.has(k)) return;
  enriching.add(k);
  try {
    const h = getOpenAtlas(workspace);
    if (!h) return;
    const db = asQueryable(h);
    const baseUrl = getSetting<string>('ollamaUrl', 'http://localhost:11434');
    const embedModel = getSetting<string>('embedModel', 'nomic-embed-text');
    const chatModel = getSetting<string>('chatModel', 'llama3.2');
    const e = await embedPending(db, { baseUrl, model: embedModel });
    let superseded = 0;
    if (e.ok && e.embedded > 0) superseded = applySupersededFromEmbeddings(db);
    emit({ kind: 'enriched', workspace, pass: 'embed', ...e, superseded });
    const s = await summarizePending(db, { baseUrl, model: chatModel });
    emit({ kind: 'enriched', workspace, pass: 'summarize', ...s });
  } catch { /* gated — enrichment never breaks indexing */ } finally { enriching.delete(k); }
}

export function registerAtlasHandlers(getWindow: () => BrowserWindow | null) {
  const emit = (payload: unknown) => { try { getWindow()?.webContents.send('atlas:event', payload); } catch { /* window gone */ } };

  ipcMain.handle('atlas:open', (_e, opts: { workspace: string }) => {
    try {
      const ws = opts.workspace;
      openAtlas(ws);
      const serverName = ensureCodeBrainServer(ws);
      if (!watchers.has(keyOf(ws))) {
        watchers.set(keyOf(ws), watchWorkspace(ws, () => {
          try { const counts = doIndex(ws); emit({ kind: 'reindexed', workspace: ws, counts }); void runEnrichment(ws, emit); } catch { /* ignore */ }
        }));
      }
      return { ok: true, dbPath: atlasDbPath(ws), mcpServer: serverName };
    } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  });

  ipcMain.handle('atlas:index', (_e, opts: { workspace: string }) => {
    try { const counts = doIndex(opts.workspace); emit({ kind: 'indexed', workspace: opts.workspace, counts }); void runEnrichment(opts.workspace, emit); return { ok: true, counts }; }
    catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
  });

  ipcMain.handle('atlas:status', (_e, opts: { workspace: string }) => {
    const h = getOpenAtlas(opts.workspace);
    if (!h) return { ok: false, error: 'workspace not open' };
    const db = asQueryable(h);
    const counts = q.statusCounts(db);
    const lastRun = db.prepare('SELECT started, finished, files_indexed AS files, symbols, mode FROM atlas_runs ORDER BY id DESC LIMIT 1').get() as any;
    return { ok: true, counts, lastRun: lastRun ?? null, vecAvailable: sqliteVecAvailable(opts.workspace) };
  });

  ipcMain.handle('atlas:query', (_e, opts: { workspace: string; tool: string; arg: string }) => {
    const h = getOpenAtlas(opts.workspace);
    if (!h) return { ok: false, error: 'workspace not open' };
    const db = asQueryable(h);
    const a = opts.arg;
    switch (opts.tool) {
      case 'locate': return { ok: true, result: q.locate(db, a) };
      case 'find_symbol': return { ok: true, result: q.findSymbol(db, a) };
      case 'who_calls': return { ok: true, result: q.whoCalls(db, a) };
      case 'calls_what': return { ok: true, result: q.callsWhat(db, a) };
      case 'get_card': return { ok: true, result: q.getCard(db, a) };
      case 'find_similar': return { ok: true, result: q.findSimilar(db, a) };
      case 'is_current': return { ok: true, result: q.isCurrent(db, a) };
      default: return { ok: false, error: `unknown tool: ${opts.tool}` };
    }
  });

  ipcMain.handle('atlas:graph', (_e, opts: { workspace: string; statuses?: SymbolStatus[]; file?: string }) => {
    const h = getOpenAtlas(opts.workspace);
    if (!h) return { ok: false, error: 'workspace not open' };
    return { ok: true, graph: q.graph(asQueryable(h), { statuses: opts.statuses, file: opts.file }) };
  });

  ipcMain.handle('atlas:card', (_e, opts: { workspace: string; ref: string }) => {
    const h = getOpenAtlas(opts.workspace);
    if (!h) return { ok: false, error: 'workspace not open' };
    return { ok: true, card: q.getCard(asQueryable(h), opts.ref) };
  });

  ipcMain.handle('atlas:enrich', async (_e, opts: { workspace: string; kind: 'embed' | 'summarize' }) => {
    const h = getOpenAtlas(opts.workspace);
    if (!h) return { ok: false, error: 'workspace not open' };
    const db = asQueryable(h);
    const baseUrl = getSetting<string>('ollamaUrl', 'http://localhost:11434');
    if (opts.kind === 'embed') {
      const r = await embedPending(db, { baseUrl });
      let superseded = 0;
      if (r.ok && r.embedded > 0) superseded = applySupersededFromEmbeddings(db);
      emit({ kind: 'enriched', workspace: opts.workspace, pass: 'embed', ...r, superseded });
      return { ...r, superseded };
    }
    const model = getSetting<string>('chatModel', 'llama3.2');
    const r = await summarizePending(db, { baseUrl, model });
    emit({ kind: 'enriched', workspace: opts.workspace, pass: 'summarize', ...r });
    return { ...r };
  });

  ipcMain.handle('atlas:close', (_e, opts: { workspace: string }) => {
    const w = watchers.get(keyOf(opts.workspace));
    if (w) { w.close(); watchers.delete(keyOf(opts.workspace)); }
    return { ok: closeAtlas(opts.workspace) };
  });
}

export function closeAllAtlasWatchers(): void {
  for (const w of watchers.values()) { try { w.close(); } catch { /* ignore */ } }
  watchers.clear();
}
