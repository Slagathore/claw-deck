import { ipcMain, dialog } from 'electron';
import { auditDirectory, AuditReport } from '../lib/scanner';

function emptyReport(error: string): AuditReport {
  return {
    ok: false, error, scannedAt: Date.now(), root: '',
    fileCount: 0, bytesScanned: 0, durationMs: 0, findings: [],
    summary: { info: 0, low: 0, medium: 0, high: 0, critical: 0 }
  };
}

export function registerAuditHandlers() {
  ipcMain.handle('audit:scan', async (_e, opts: { path: string }): Promise<AuditReport> => {
    if (!opts?.path) return emptyReport('no path supplied');
    return auditDirectory(opts.path);
  });

  ipcMain.handle('audit:pickAndScan', async (): Promise<AuditReport> => {
    const r = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Pick an extension folder to audit'
    });
    if (r.canceled || r.filePaths.length === 0) return emptyReport('cancelled');
    return auditDirectory(r.filePaths[0]);
  });
}
