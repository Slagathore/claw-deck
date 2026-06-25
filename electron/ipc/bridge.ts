// claw-bridge IPC (Phase 6). Thin pass-through to the localhost bridge client;
// every handler returns a safe empty/disconnected value when VS Code/the bridge
// isn't present, so the renderer can show live diagnostics + vscode.lm models
// when available and simply hide them when not.

import { ipcMain } from 'electron';
import { getSetting } from './settings';
import { bridgeStatus, bridgeDiagnostics, bridgeSelection, bridgeLmModels, bridgeLmInvoke, bridgeMcp } from '../bridge/client';

const port = (): number => getSetting<number>('clawBridgePort', 39217);

export function registerBridgeHandlers() {
  ipcMain.handle('bridge:status', () => bridgeStatus(port()));
  ipcMain.handle('bridge:diagnostics', (_e, opts?: { file?: string }) => bridgeDiagnostics(port(), opts?.file));
  ipcMain.handle('bridge:selection', () => bridgeSelection(port()));
  ipcMain.handle('bridge:lmModels', () => bridgeLmModels(port()));
  ipcMain.handle('bridge:invoke', (_e, opts: { model: string; messages: { role: string; content: string }[] }) => bridgeLmInvoke(port(), opts.model, opts.messages));
  ipcMain.handle('bridge:mcp', () => bridgeMcp(port()));
}
