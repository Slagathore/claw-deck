// claw-bridge client (BOOTSTRAP §3 Phase 6). Talks to the optional claw-bridge
// VS Code extension over localhost. EVERY call degrades gracefully: if the
// bridge isn't running, status reports disconnected and the signal accessors
// return empty — claw-deck then runs on filesystem+git alone. No hard dependency.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface BridgeStatus { connected: boolean; version?: string; folders?: string[] }
export interface BridgeDiagnostic { file: string; line: number; severity: string; message: string; source?: string }
export interface BridgeLmModel { id: string; vendor?: string; family?: string; name?: string; maxInputTokens?: number }

const baseUrl = (port: number) => `http://127.0.0.1:${port}`;
const REG_DIR = path.join(os.homedir(), '.claw-bridge');

/** Ports of bridges that registered in the last 5 min (each VS Code window writes one). */
function registeredPorts(): number[] {
  try {
    return fs.readdirSync(REG_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => { try { const j = JSON.parse(fs.readFileSync(path.join(REG_DIR, f), 'utf8')); return { port: Number(j.port), updated: Number(j.updated) || 0 }; } catch { return null; } })
      .filter((x): x is { port: number; updated: number } => !!x && !!x.port && Date.now() - x.updated < 5 * 60_000)
      .map((x) => x.port);
  } catch { return []; }
}

function pathMatch(folder: string, ws: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const a = norm(folder), b = norm(ws);
  return a === b || b.startsWith(a + '/') || a.startsWith(b + '/');
}

/**
 * Pick the bridge whose open folders include `workspace` (the council's active project).
 * `matched` is false when a bridge is reachable but it's a DIFFERENT project's window —
 * so the UI can say "open this project in VS Code" instead of surfacing the wrong diagnostics.
 * Returns null when no live bridge exists at all.
 */
export async function resolveBridgePort(workspace: string | undefined, configuredPort: number): Promise<{ port: number; matched: boolean; folders: string[] } | null> {
  const ports = [...new Set([configuredPort, ...registeredPorts()])];
  const alive: { port: number; folders: string[] }[] = [];
  for (const port of ports) {
    const s = await getJson<{ version: string; folders: string[] }>(`${baseUrl(port)}/status`, 800);
    if (s) alive.push({ port, folders: s.folders ?? [] });
  }
  if (!alive.length) return null;
  if (workspace) {
    const m = alive.find((a) => a.folders.some((f) => pathMatch(f, workspace)));
    if (m) return { port: m.port, matched: true, folders: m.folders };
  }
  const fb = alive.find((a) => a.port === configuredPort) ?? alive[0];
  return { port: fb.port, matched: !workspace, folders: fb.folders };   // no workspace asked → treat as matched
}

async function getJson<T>(url: string, timeoutMs = 2000): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? (await r.json()) as T : null;
  } catch { return null; }
}

async function postJson<T>(url: string, body: unknown, timeoutMs = 180000): Promise<T | null> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    return r.ok ? (await r.json()) as T : null;
  } catch { return null; }
}

export async function bridgeStatus(port: number): Promise<BridgeStatus> {
  const s = await getJson<{ version: string; folders: string[] }>(`${baseUrl(port)}/status`);
  return s ? { connected: true, version: s.version, folders: s.folders } : { connected: false };
}

export async function bridgeDiagnostics(port: number, file?: string): Promise<BridgeDiagnostic[]> {
  const q = file ? `?file=${encodeURIComponent(file)}` : '';
  return (await getJson<BridgeDiagnostic[]>(`${baseUrl(port)}/diagnostics${q}`)) ?? [];
}

export async function bridgeSelection(port: number): Promise<{ file: string; text: string; line: number } | null> {
  return getJson(`${baseUrl(port)}/selection`);
}

export async function bridgeLmModels(port: number): Promise<BridgeLmModel[]> {
  return (await getJson<BridgeLmModel[]>(`${baseUrl(port)}/lm/models`)) ?? [];
}

export async function bridgeLmInvoke(port: number, model: string, messages: { role: string; content: string }[]): Promise<string | null> {
  const r = await postJson<{ content: string }>(`${baseUrl(port)}/lm/invoke`, { model, messages });
  return r?.content ?? null;
}

export async function bridgeMcp(port: number): Promise<{ name: string; command: string; args?: string[] }[]> {
  return (await getJson<{ name: string; command: string; args?: string[] }[]>(`${baseUrl(port)}/mcp`)) ?? [];
}
