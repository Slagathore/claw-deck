// claw-bridge IPC (Phase 6). Thin pass-through to the localhost bridge client;
// every handler returns a safe empty/disconnected value when VS Code/the bridge
// isn't present, so the renderer can show live diagnostics + vscode.lm models
// when available and simply hide them when not.

import { ipcMain } from 'electron';
import { getSetting } from './settings';
import { bridgeStatus, bridgeDiagnostics, bridgeSelection, bridgeLmModels, bridgeLmInvoke, bridgeMcp, resolveBridgePort } from '../bridge/client';

export function registerBridgeHandlers() {
  const configured = () => getSetting<number>('clawBridgePort', 39217);
  // Resolve (and briefly cache) the bridge whose open folders match the active workspace,
  // so the council talks to the RIGHT VS Code window among several open ones.
  const cache = new Map<string, { port: number; matched: boolean; at: number }>();
  const portFor = async (workspace?: string) => {
    const key = workspace ?? '';
    const c = cache.get(key);
    if (c && Date.now() - c.at < 8000) return c;
    const r = await resolveBridgePort(workspace, configured());
    if (r) { const v = { port: r.port, matched: r.matched, at: Date.now() }; cache.set(key, v); return v; }
    cache.delete(key); return null;
  };

  ipcMain.handle('bridge:status', async (_e, opts?: { workspace?: string }) => {
    const r = await portFor(opts?.workspace);
    if (!r) return { connected: false, matched: false };
    const s = await bridgeStatus(r.port);
    return { ...s, matched: r.matched };          // matched=false → a different project's VS Code window
  });
  // Project-specific signals are withheld unless the reachable bridge is THIS project's window.
  ipcMain.handle('bridge:diagnostics', async (_e, opts?: { workspace?: string; file?: string }) => { const r = await portFor(opts?.workspace); return r && r.matched ? bridgeDiagnostics(r.port, opts?.file) : []; });
  ipcMain.handle('bridge:selection', async (_e, opts?: { workspace?: string }) => { const r = await portFor(opts?.workspace); return r && r.matched ? bridgeSelection(r.port) : null; });
  ipcMain.handle('bridge:mcp', async (_e, opts?: { workspace?: string }) => { const r = await portFor(opts?.workspace); return r && r.matched ? bridgeMcp(r.port) : []; });
  // LM models are account-level, not project-specific → fine from any reachable bridge.
  ipcMain.handle('bridge:lmModels', async (_e, opts?: { workspace?: string }) => { const r = await portFor(opts?.workspace); return r ? bridgeLmModels(r.port) : []; });
  ipcMain.handle('bridge:invoke', async (_e, opts: { model: string; messages: { role: string; content: string }[]; workspace?: string }) => { const r = await portFor(opts?.workspace); return r ? bridgeLmInvoke(r.port, opts.model, opts.messages) : null; });
}
