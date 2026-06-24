// `code-brain` — a stdio MCP server exposing one workspace's Atlas as tools
// (BOOTSTRAP §4.4). Standalone Node process (NOT the Electron main process):
// uses node:sqlite read-only so there's no better-sqlite3/Electron-ABI conflict,
// and a hand-rolled JSON-RPC 2.0 stdio loop so we add NO @modelcontextprotocol/sdk
// dependency. Spawned per workspace with `--db <workspace>/.fusion/atlas.db`,
// registered as a settings.mcpServers entry so claw-deck + actor CLIs both reach it.
//
// Deviations from BOOTSTRAP (documented): lives at electron/atlas/codeBrainServer.ts
// (compiles via the existing electron tsconfig → dist-electron/atlas/codeBrainServer.js)
// rather than mcp/code-brain/server.ts, so it needs no extra build target.

import { DatabaseSync } from 'node:sqlite';
import { Queryable } from './driver';
import * as q from './query';

function argDb(): string {
  const i = process.argv.indexOf('--db');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  throw new Error('code-brain: missing --db <path>');
}

let db: Queryable | null = null;
function openDb(path: string): Queryable {
  try { return new DatabaseSync(path, { readOnly: true }) as unknown as Queryable; }
  catch { return new DatabaseSync(path) as unknown as Queryable; }
}

const TOOLS = [
  { name: 'locate', description: 'Find the most relevant symbols for a natural-language description. Returns file:line locations.', schema: { description: { type: 'string' } }, req: ['description'] },
  { name: 'find_symbol', description: 'Find symbols by exact or prefix name. Returns file:line locations.', schema: { name: { type: 'string' } }, req: ['name'] },
  { name: 'who_calls', description: 'List callers/referencers of a symbol (name, qualified name, key, or file:line).', schema: { symbol: { type: 'string' } }, req: ['symbol'] },
  { name: 'calls_what', description: 'List symbols a given symbol calls/references.', schema: { symbol: { type: 'string' } }, req: ['symbol'] },
  { name: 'get_card', description: 'Full card for a symbol: signature, summary, location, status, ref_count, git date, callers, callees.', schema: { symbol: { type: 'string' } }, req: ['symbol'] },
  { name: 'find_similar', description: 'Symbols similar to the given one (embedding cosine when available, else name look-alikes).', schema: { symbol: { type: 'string' } }, req: ['symbol'] },
  { name: 'is_current', description: 'Whether a symbol is current: status (active/orphaned/deprecated/superseded) + what supersedes it.', schema: { symbol: { type: 'string' } }, req: ['symbol'] },
];

function call(name: string, args: Record<string, any>): unknown {
  if (!db) throw new Error('atlas DB not open');
  switch (name) {
    case 'locate': return q.locate(db, String(args.description ?? ''));
    case 'find_symbol': return q.findSymbol(db, String(args.name ?? ''));
    case 'who_calls': return q.whoCalls(db, String(args.symbol ?? ''));
    case 'calls_what': return q.callsWhat(db, String(args.symbol ?? ''));
    case 'get_card': return q.getCard(db, String(args.symbol ?? ''));
    case 'find_similar': return q.findSimilar(db, String(args.symbol ?? ''));
    case 'is_current': return q.isCurrent(db, String(args.symbol ?? ''));
    default: throw new Error(`unknown tool: ${name}`);
  }
}

function send(msg: unknown): void { process.stdout.write(JSON.stringify(msg) + '\n'); }

function handle(msg: any): void {
  const { id, method, params } = msg ?? {};
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id, result });
  const fail = (code: number, message: string) => send({ jsonrpc: '2.0', id, error: { code, message } });

  if (method === 'initialize') {
    return reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'code-brain', version: '0.1.0' } });
  }
  if (method === 'notifications/initialized' || method === 'initialized') return; // notification, no reply
  if (method === 'ping') return reply({});
  if (method === 'tools/list') {
    return reply({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.schema, required: t.req } })) });
  }
  if (method === 'tools/call') {
    const toolName = params?.name;
    try {
      const out = call(toolName, params?.arguments ?? {});
      return reply({ content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] });
    } catch (e: any) {
      return reply({ content: [{ type: 'text', text: `error: ${e?.message ?? e}` }], isError: true });
    }
  }
  if (id !== undefined) fail(-32601, `method not found: ${method}`);
}

function main(): void {
  db = openDb(argDb());
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch { /* ignore malformed line */ }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

main();
