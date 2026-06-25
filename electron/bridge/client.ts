// claw-bridge client (BOOTSTRAP §3 Phase 6). Talks to the optional claw-bridge
// VS Code extension over localhost. EVERY call degrades gracefully: if the
// bridge isn't running, status reports disconnected and the signal accessors
// return empty — claw-deck then runs on filesystem+git alone. No hard dependency.

export interface BridgeStatus { connected: boolean; version?: string; folders?: string[] }
export interface BridgeDiagnostic { file: string; line: number; severity: string; message: string; source?: string }
export interface BridgeLmModel { id: string; vendor?: string; family?: string; name?: string; maxInputTokens?: number }

const baseUrl = (port: number) => `http://127.0.0.1:${port}`;

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
