import { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog } from 'electron';
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

const isDev = !app.isPackaged;

let mainWindow: BrowserWindow | null = null;

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

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(async () => {
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

  ipcMain.handle('app:pickPath', async (_e, opts: { properties?: string[] }) => {
    const r = await dialog.showOpenDialog({
      properties: (opts?.properties as any) ?? ['openFile']
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('app:version', () => ({
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch
  }));

  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopAllMcp();
  if (process.platform !== 'darwin') app.quit();
});
