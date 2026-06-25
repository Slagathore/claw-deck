import { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, Tray, Menu, nativeImage } from 'electron';
import * as path from 'path';
import { initDb } from './ipc/db';
import { registerRunnerHandlers } from './ipc/runner';
import { registerOllamaHandlers } from './ipc/ollama';
import { registerUpgradeHandlers } from './ipc/upgrades';
import { registerSecurityHandlers } from './ipc/security';
import { registerScreenshotHandlers } from './ipc/screenshot';
import { registerSettingsHandlers } from './ipc/settings';
import { registerHistoryHandlers } from './ipc/history';
import { registerPromptHandlers } from './ipc/prompts';
import { registerMcpHandlers, stopAllMcp } from './ipc/mcp';
import { registerTerminalHandlers } from './ipc/terminal';
import { registerAuditHandlers } from './ipc/audit';
import { registerExtensionHandlers } from './ipc/extensions';
import { registerSkillHandlers } from './ipc/skills';
import { registerAtlasHandlers, closeAllAtlasWatchers } from './ipc/atlas';
import { registerExecutorHandlers } from './ipc/executor';
import { registerCouncilHandlers } from './ipc/council';
import { registerBridgeHandlers } from './ipc/bridge';
import { closeAllAtlas } from './atlas/db';
import { registerSelfUpgradeHandlers } from './selfUpgrade/registry';
import { executeProbeMode } from './selfUpgrade/probe';

// Dev only when explicitly launched via `npm run dev` (which sets CLAW_DEV).
// `npm start` builds to dist/ and runs no Vite server, so it must load the file.
const isDev = !app.isPackaged && process.env.CLAW_DEV === '1';
// Vite dev server URL — overridable so you can point at a different port.
const devServerUrl = process.env.CLAW_DEV_SERVER_URL || 'http://localhost:5173';
const isProbeMode = !!process.env.CLAW_PROBE_ID;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
/** When true, close ⇒ hide-to-tray. Toggled via `app:setCloseToTray` IPC. */
let closeToTray = true;
/** Set when the user explicitly quits via tray menu / Cmd+Q. */
let quitting = false;

function showWindow() {
  if (!mainWindow) { createWindow(); return; }
  if (mainWindow.isMinimized()) mainWindow.restore();
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

async function buildTray() {
  if (tray) return;
  let image: Electron.NativeImage;
  try {
    // Use the .exe's own icon when packaged so the tray matches the taskbar.
    image = await app.getFileIcon(process.execPath, { size: 'small' });
    if (image.isEmpty()) image = nativeImage.createEmpty();
  } catch {
    image = nativeImage.createEmpty();
  }
  try {
    tray = new Tray(image);
  } catch {
    // Some Windows builds reject empty images — skip tray entirely.
    tray = null;
    return;
  }
  tray.setToolTip('Claw Deck');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show Claw Deck', click: () => showWindow() },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  const indexFile = path.join(__dirname, '..', 'dist', 'index.html');
  if (isDev) {
    // `npm run dev` runs the Vite server; `npm start` builds to dist/ with no
    // server. Try the dev server and fall back to the built file when it isn't up.
    mainWindow.loadURL(devServerUrl)
      .then(() => mainWindow?.webContents.openDevTools({ mode: 'detach' }))
      .catch(() => mainWindow?.loadFile(indexFile));
  } else {
    mainWindow.loadFile(indexFile);
  }

  // Close → hide-to-tray (unless user explicitly quitting).
  mainWindow.on('close', (e) => {
    if (!quitting && closeToTray) {
      e.preventDefault();
      mainWindow?.hide();
      // First-time hint via balloon (Windows only).
      if (tray && process.platform === 'win32') {
        try {
          tray.displayBalloon({
            title: 'Claw Deck is still running',
            content: 'Right-click the tray icon to quit.',
            iconType: 'info'
          });
        } catch { /* not critical */ }
      }
    }
  });
}

app.whenReady().then(async () => {
  // ---- Probe mode: spawned by the self-upgrader to validate a patched tree.
  // Run the requested checks, post results, exit. Never opens a window.
  if (isProbeMode) {
    const requested = (process.env.CLAW_PROBE_CHECKS || '').split(',').filter(Boolean);
    const checks: Parameters<typeof executeProbeMode>[0] = {};
    checks.boot = async () => ({ ok: true, detail: `version=${app.getVersion()}` });
    if (requested.includes('db')) {
      checks.db = async () => {
        try { await initDb(); return { ok: true }; }
        catch (e: any) { return { ok: false, detail: e.message }; }
      };
    }
    if (requested.includes('tray')) {
      checks.tray = async () => {
        try {
          const img = await app.getFileIcon(process.execPath, { size: 'small' }).catch(() => nativeImage.createEmpty());
          const t = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
          t.destroy();
          return { ok: true };
        } catch (e: any) { return { ok: false, detail: e.message }; }
      };
    }
    if (requested.includes('ollama')) {
      checks.ollama = async () => {
        try {
          const r = await fetch('http://localhost:11434/api/tags');
          return { ok: r.ok, detail: `HTTP ${r.status}` };
        } catch (e: any) { return { ok: false, detail: e.message }; }
      };
    }
    if (requested.includes('render')) {
      checks.render = async () => new Promise(resolve => {
        try {
          const w = new BrowserWindow({ show: false, width: 400, height: 300, webPreferences: { offscreen: true } });
          let resolved = false;
          const finish = (ok: boolean, detail?: string) => {
            if (resolved) return;
            resolved = true;
            try { w.destroy(); } catch {}
            resolve({ ok, detail });
          };
          w.webContents.once('did-finish-load', () => finish(true, 'index loaded'));
          w.webContents.once('did-fail-load', (_e, _c, desc) => finish(false, desc));
          setTimeout(() => finish(false, 'render timeout'), 8000);
          const indexPath = path.join(__dirname, '..', 'dist', 'index.html');
          w.loadFile(indexPath).catch(e => finish(false, e.message));
        } catch (e: any) { resolve({ ok: false, detail: e.message }); }
      });
    }
    if (requested.includes('scan')) {
      checks.scan = async () => {
        try {
          const { auditDirectory } = await import('./lib/scanner');
          const r = await auditDirectory(path.resolve(__dirname, '..'));
          return { ok: r.summary.critical === 0, detail: `crit=${r.summary.critical} high=${r.summary.high}` };
        } catch (e: any) { return { ok: false, detail: e.message }; }
      };
    }
    await executeProbeMode(checks);
    return;
  }

  await initDb();
  registerSettingsHandlers();
  registerHistoryHandlers();
  registerRunnerHandlers(() => mainWindow);
  registerOllamaHandlers();
  registerUpgradeHandlers();
  registerSecurityHandlers();
  registerScreenshotHandlers(desktopCapturer, screen);
  registerPromptHandlers();
  registerMcpHandlers();
  registerTerminalHandlers();
  registerAuditHandlers();
  registerExtensionHandlers();
  registerSkillHandlers();
  registerAtlasHandlers(() => mainWindow);
  registerExecutorHandlers();
  registerCouncilHandlers(() => mainWindow);
  registerBridgeHandlers();
  registerSelfUpgradeHandlers();

  ipcMain.handle('app:pickPath', async (_e, opts: { properties?: string[] }) => {
    const r = await dialog.showOpenDialog({
      properties: (opts?.properties as any) ?? ['openFile']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('app:version', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    closeToTray
  }));

  ipcMain.handle('app:setCloseToTray', (_e, value: boolean) => {
    closeToTray = Boolean(value);
    return { ok: true, closeToTray };
  });

  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });

  ipcMain.handle('app:show', () => { showWindow(); return { ok: true }; });

  createWindow();
  await buildTray();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Single-instance lock: second launch focuses the existing window instead of opening a new copy.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  // With close-to-tray we generally never reach here. Only fires if tray creation failed.
  stopAllMcp();
  closeAllAtlasWatchers();
  closeAllAtlas();
  if (process.platform !== 'darwin') app.quit();
});
