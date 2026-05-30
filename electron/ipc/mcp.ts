import { ipcMain } from 'electron';
import { ChildProcess, spawn } from 'child_process';
import { getDb } from './db';

export interface McpServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** when false, ignored entirely */
  enabled?: boolean;
}

interface RunningMcp {
  config: McpServerConfig;
  proc: ChildProcess;
  startedAt: number;
  pid?: number;
  status: 'starting' | 'running' | 'exited' | 'error';
  exitCode?: number | null;
  lastError?: string;
}

const running = new Map<string, RunningMcp>();

function loadSettings(): any {
  const rows = getDb().prepare('SELECT key,value FROM settings').all() as { key: string; value: string }[];
  const out: any = {};
  for (const r of rows) try { out[r.key] = JSON.parse(r.value); } catch { out[r.key] = r.value; }
  return out;
}

function configsFromSettings(): McpServerConfig[] {
  const list = loadSettings().mcpServers;
  if (!Array.isArray(list)) return [];
  return list.filter((c: any) => c && typeof c.name === 'string' && typeof c.command === 'string');
}

export function getActiveMcpEnv(): { MCP_SERVERS_JSON: string } {
  // Pass enabled+running servers to CLI sessions so OpenClaw / Claude Code can pick them up.
  const snapshot = Array.from(running.values()).map(r => ({
    name: r.config.name,
    pid: r.pid,
    command: r.config.command,
    args: r.config.args ?? []
  }));
  return { MCP_SERVERS_JSON: JSON.stringify(snapshot) };
}

function startOne(cfg: McpServerConfig): RunningMcp {
  const existing = running.get(cfg.name);
  if (existing && existing.status === 'running') return existing;

  const proc = spawn(cfg.command, cfg.args ?? [], {
    cwd: cfg.cwd,
    env: { ...process.env, ...(cfg.env ?? {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });

  const entry: RunningMcp = {
    config: cfg,
    proc,
    startedAt: Date.now(),
    pid: proc.pid,
    status: 'starting'
  };
  running.set(cfg.name, entry);

  proc.once('spawn', () => { entry.status = 'running'; });
  proc.once('error', (err) => {
    entry.status = 'error';
    entry.lastError = err.message;
  });
  proc.once('exit', (code) => {
    entry.status = 'exited';
    entry.exitCode = code;
  });
  // Drain pipes to prevent backpressure stalls
  proc.stdout?.on('data', () => { /* consumed by external MCP clients via pid */ });
  proc.stderr?.on('data', (b) => { entry.lastError = b.toString().slice(0, 500); });

  return entry;
}

export function stopOne(name: string): boolean {
  const entry = running.get(name);
  if (!entry) return false;
  try { entry.proc.kill(); } catch { /* already dead */ }
  return true;
}

export function stopAllMcp(): void {
  for (const name of Array.from(running.keys())) stopOne(name);
}

export function registerMcpHandlers() {
  ipcMain.handle('mcp:list', () => {
    const configs = configsFromSettings();
    return configs.map(cfg => {
      const r = running.get(cfg.name);
      return {
        name: cfg.name,
        command: cfg.command,
        args: cfg.args ?? [],
        enabled: cfg.enabled !== false,
        status: r?.status ?? 'stopped',
        pid: r?.pid,
        startedAt: r?.startedAt,
        exitCode: r?.exitCode,
        lastError: r?.lastError
      };
    });
  });

  ipcMain.handle('mcp:start', (_e, name: string) => {
    const cfg = configsFromSettings().find(c => c.name === name);
    if (!cfg) return { ok: false, reason: 'unknown server' };
    if (cfg.enabled === false) return { ok: false, reason: 'disabled in settings' };
    try {
      const entry = startOne(cfg);
      return { ok: true, status: entry.status, pid: entry.pid };
    } catch (e: any) {
      return { ok: false, reason: e.message };
    }
  });

  ipcMain.handle('mcp:stop', (_e, name: string) => ({ ok: stopOne(name) }));

  ipcMain.handle('mcp:startAll', () => {
    const out: any[] = [];
    for (const cfg of configsFromSettings()) {
      if (cfg.enabled === false) continue;
      try {
        const e = startOne(cfg);
        out.push({ name: cfg.name, ok: true, status: e.status, pid: e.pid });
      } catch (err: any) {
        out.push({ name: cfg.name, ok: false, reason: err.message });
      }
    }
    return out;
  });

  ipcMain.handle('mcp:stopAll', () => {
    const names = Array.from(running.keys());
    for (const n of names) stopOne(n);
    return { stopped: names.length };
  });
}
