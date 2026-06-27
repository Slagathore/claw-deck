// Minimal stdio MCP client (the mirror of codeBrainServer.ts). Spawns an MCP
// server, does the JSON-RPC handshake, and exposes tools/list + tools/call so a
// cloud model can actually USE tools. Used only for the read-only scoped toolset
// (Atlas code-brain + Context7) given to panelists — never the write-capable
// servers. No SDK dependency; newline-delimited JSON-RPC 2.0.

import { spawn, type ChildProcess } from 'child_process';
import { trace } from '../ipc/trace';

export interface McpServerSpec { name: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string }
export interface ToolDef { type: 'function'; function: { name: string; description?: string; parameters: any } }
export interface ToolSet { tools: ToolDef[]; call: (name: string, args: any) => Promise<string>; dispose: () => void }

class McpConn {
  private proc: ChildProcess;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>();
  private ready: Promise<void>;

  constructor(command: string, args: string[], env?: Record<string, string>, cwd?: string) {
    const useShell = process.platform === 'win32' && !/[\\/]/.test(command);
    const spawnArgs = useShell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
    this.proc = spawn(command, spawnArgs, { cwd, env: { ...process.env, ...(env ?? {}) }, shell: useShell });
    this.proc.stdout?.setEncoding('utf8');
    this.proc.stdout?.on('data', (d: string) => this.onData(d));
    this.proc.stderr?.on('data', () => { /* ignore server logs */ });
    this.proc.on('error', () => this.failAll('mcp spawn error'));
    this.proc.on('exit', () => this.failAll('mcp server exited'));
    this.ready = this.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'claw-deck', version: '0.1.0' } }, 20000)
      .then(() => { this.notify('notifications/initialized', {}); });
  }

  private failAll(why: string) { for (const p of this.pending.values()) p.reject(new Error(why)); this.pending.clear(); }
  private onData(chunk: string) {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!; this.pending.delete(msg.id);
          msg.error ? p.reject(new Error(msg.error.message ?? 'mcp error')) : p.resolve(msg.result);
        }
      } catch { /* skip non-JSON */ }
    }
  }
  private send(o: unknown) { try { this.proc.stdin?.write(JSON.stringify(o) + '\n'); } catch { /* dead */ } }
  private notify(method: string, params: unknown) { this.send({ jsonrpc: '2.0', method, params }); }
  request(method: string, params: unknown, timeoutMs = 30000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`mcp ${method} timeout`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }
  async listTools(): Promise<{ name: string; description?: string; inputSchema?: any }[]> { await this.ready; return (await this.request('tools/list', {})).tools ?? []; }
  async callTool(name: string, args: any): Promise<string> {
    await this.ready;
    const r = await this.request('tools/call', { name, arguments: args }, 60000);
    const parts = r?.content ?? [];
    return Array.isArray(parts) ? parts.map((p: any) => (p?.type === 'text' ? p.text : JSON.stringify(p))).join('\n') : JSON.stringify(r);
  }
  dispose() { try { this.proc.kill(); } catch { /* already dead */ } }
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 60);

/** Spawn each server, list its tools (namespaced server__tool), and return a
 *  combined toolset with a router. Servers that fail to start are skipped. */
export async function buildToolSet(servers: McpServerSpec[], signal?: AbortSignal): Promise<ToolSet> {
  const conns: McpConn[] = [];
  const route = new Map<string, { conn: McpConn; tool: string }>();
  const tools: ToolDef[] = [];
  for (const s of servers) {
    try {
      const conn = new McpConn(s.command, s.args ?? [], s.env, s.cwd);
      conns.push(conn);
      const list = await conn.listTools();
      for (const t of list) {
        const fq = `${sanitize(s.name)}__${sanitize(t.name)}`;
        route.set(fq, { conn, tool: t.name });
        tools.push({ type: 'function', function: { name: fq, description: t.description ?? '', parameters: t.inputSchema ?? { type: 'object', properties: {} } } });
      }
      trace('council:tools:server', { server: s.name, tools: list.length });
    } catch (e: any) { trace('council:tools:error', { server: s.name, error: String(e?.message ?? e) }); }
  }
  const dispose = () => { for (const c of conns) c.dispose(); };
  if (signal) { if (signal.aborted) dispose(); else signal.addEventListener('abort', dispose, { once: true }); }
  return {
    tools,
    call: async (name, args) => { const r = route.get(name); if (!r) return `error: unknown tool ${name}`; try { return await r.conn.callTool(r.tool, args); } catch (e: any) { return `error calling ${name}: ${e?.message ?? e}`; } },
    dispose,
  };
}
