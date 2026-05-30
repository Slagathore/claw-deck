import { ipcMain, BrowserWindow } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { getActiveMcpEnv } from './mcp';

interface Session { proc: ChildProcess; backend: string; }
const sessions = new Map<string, Session>();

export function registerRunnerHandlers(getWindow: () => BrowserWindow | null) {
  function emit(id: string, kind: string, data: any) {
    const w = getWindow();
    if (w) w.webContents.send('runner:event', { id, kind, data, ts: Date.now() });
  }

  ipcMain.handle('runner:start', (_e, opts: { backend: 'openclaw' | 'claude' | 'shell'; binary: string; args?: string[]; cwd?: string; env?: Record<string, string> }) => {
    const id = randomUUID();
    const proc = spawn(opts.binary, opts.args ?? [], {
      cwd: opts.cwd,
      env: { ...process.env, ...getActiveMcpEnv(), ...(opts.env ?? {}) },
      shell: false
    });
    sessions.set(id, { proc, backend: opts.backend });

    proc.stdout?.on('data', d => emit(id, 'stdout', d.toString()));
    proc.stderr?.on('data', d => emit(id, 'stderr', d.toString()));
    proc.on('error', err => emit(id, 'error', err.message));
    proc.on('exit', code => {
      emit(id, 'exit', code);
      sessions.delete(id);
    });
    return { id };
  });

  ipcMain.handle('runner:stop', (_e, id: string) => {
    const s = sessions.get(id);
    if (!s) return false;
    s.proc.kill();
    return true;
  });

  ipcMain.handle('runner:input', (_e, id: string, data: string) => {
    const s = sessions.get(id);
    if (!s || !s.proc.stdin || s.proc.stdin.destroyed) return false;
    s.proc.stdin.write(data.endsWith('\n') ? data : data + '\n');
    return true;
  });
}
