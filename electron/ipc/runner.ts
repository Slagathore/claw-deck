import { ipcMain, type BrowserWindow } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import { getActiveMcpEnv } from './mcp';
import { resolveCliBinary } from './cliResolve';
import { trace } from './trace';

/**
 * Subprocess runner. Two modes:
 *   - pipe : child_process with piped stdio (AI CLIs, one-shot tools).
 *   - pty  : node-pty pseudo-terminal (real shells — line editing, isatty,
 *            colors). Falls back to pipe automatically if node-pty can't load
 *            (e.g. ABI mismatch in a packaged build), so the app never breaks.
 */

interface PipeSession { kind: 'pipe'; proc: ChildProcess; backend: string; }
interface PtySession { kind: 'pty'; term: any; backend: string; }
type Session = PipeSession | PtySession;

const sessions = new Map<string, Session>();

/**
 * Captured one-shot run (Phase 2 actor helper): spawn a backend, inject the
 * active MCP env + Windows bare-name shell resolution (same as runner:start),
 * collect stdout/stderr, resolve on exit. Used by the executor to drive
 * apply-mode actors and detect quota/auth failures (see executor/fallback.ts).
 */
/** Kill a child and (on Windows) its whole process tree — CLIs spawn children. */
function killProcTree(proc: ChildProcess): void {
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore', shell: false });
    } else {
      proc.kill('SIGKILL');
    }
  } catch { /* already dead */ }
}

/** Kill every live runner session so PTYs / child processes aren't orphaned on quit. */
export function stopAllRunners(): void {
  for (const [id, s] of sessions) {
    try { s.kind === 'pty' ? s.term.kill() : killProcTree(s.proc); } catch { /* already dead */ }
    sessions.delete(id);
  }
}

export function runCaptured(opts: {
  binary: string; args?: string[]; cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number;
  signal?: AbortSignal; onData?: (chunk: string) => void; unsetEnv?: string[];
}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { ...process.env, ...getActiveMcpEnv(), ...(opts.env ?? {}) };
    for (const k of opts.unsetEnv ?? []) delete env[k];   // e.g. drop ANTHROPIC_API_KEY → claude uses the login subscription
    const binary = resolveCliBinary(opts.binary);
    const bareName = !/[\\/]/.test(binary);
    const useShell = process.platform === 'win32' && bareName;
    const started = Date.now();
    trace('runner:start', { requested: opts.binary, resolved: binary, args: opts.args ?? [], cwd: opts.cwd, inputBytes: opts.input?.length ?? 0, timeoutMs: opts.timeoutMs });
    const proc = spawn(binary, opts.args ?? [], { cwd: opts.cwd, env, shell: useShell });
    let out = '', err = '', done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => { killProcTree(proc); err += '\n[aborted]'; finish(null); };
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      trace('runner:finish', { requested: opts.binary, resolved: binary, code, ms: Date.now() - started, stdoutBytes: out.length, stderrBytes: err.length, stdoutTail: out.slice(-800), stderrTail: err.slice(-1200) });
      resolve({ code, stdout: out, stderr: err });
    };
    if (opts.timeoutMs) timer = setTimeout(() => { killProcTree(proc); err += '\n[killed: timeout]'; finish(null); }, opts.timeoutMs);
    if (opts.signal) { if (opts.signal.aborted) onAbort(); else opts.signal.addEventListener('abort', onAbort); }
    proc.stdout?.on('data', (d) => { const s = d.toString(); out += s; opts.onData?.(s); });
    proc.stderr?.on('data', (d) => { err += d.toString(); });
    proc.on('error', (e) => { err += String(e); trace('runner:error', { requested: opts.binary, resolved: binary, error: e.message }); finish(null); });
    proc.on('exit', (code) => finish(code));
    if (opts.input != null) { try { proc.stdin?.write(opts.input); proc.stdin?.end(); } catch { /* no stdin */ } }
  });
}

let ptyMod: any = null;
let ptyTried = false;
function loadPty(): any {
  if (ptyTried) return ptyMod;
  ptyTried = true;
  try { ptyMod = require('node-pty'); } catch { ptyMod = null; }
  return ptyMod;
}

export function registerRunnerHandlers(getWindow: () => BrowserWindow | null) {
  function emit(id: string, kind: string, data: any) {
    const w = getWindow();
    if (w) w.webContents.send('runner:event', { id, kind, data, ts: Date.now() });
  }

  ipcMain.handle('runner:start', (_e, opts: {
    backend: 'openclaw' | 'claude' | 'codex' | 'shell';
    binary: string; args?: string[]; cwd?: string; env?: Record<string, string>;
    pty?: boolean; cols?: number; rows?: number;
  }) => {
    const id = randomUUID();
    const env = { ...process.env, ...getActiveMcpEnv(), ...(opts.env ?? {}) };

    // PTY path (opt-in; graceful fallback to pipe if node-pty is unavailable).
    if (opts.pty) {
      const pty = loadPty();
      if (pty) {
        try {
          const binary = resolveCliBinary(opts.binary);
          const term = pty.spawn(binary, opts.args ?? [], {
            name: 'xterm-256color',
            cols: opts.cols ?? 120,
            rows: opts.rows ?? 30,
            cwd: opts.cwd,
            env
          });
          sessions.set(id, { kind: 'pty', term, backend: opts.backend });
          term.onData((d: string) => emit(id, 'stdout', d));
          term.onExit((e: { exitCode: number }) => { emit(id, 'exit', e.exitCode); sessions.delete(id); });
          return { id, pty: true };
        } catch (err: any) {
          emit(id, 'error', `pty spawn failed, falling back to pipe: ${err.message}`);
          // fall through to pipe
        }
      }
    }

    // Pipe path. On Windows, bare command names (e.g. `clawhub`, `npm`, `winget`)
    // are usually `.cmd`/`.exe` resolved via PATHEXT — which spawn() only does
    // with a shell. Use a shell for bare names so npm-installed CLIs resolve.
    const binary = resolveCliBinary(opts.binary);
    const bareName = !/[\\/]/.test(binary);
    const useShell = process.platform === 'win32' && bareName;
    const proc = spawn(binary, opts.args ?? [], { cwd: opts.cwd, env, shell: useShell });
    sessions.set(id, { kind: 'pipe', proc, backend: opts.backend });
    proc.stdout?.on('data', d => emit(id, 'stdout', d.toString()));
    proc.stderr?.on('data', d => emit(id, 'stderr', d.toString()));
    // A genuine spawn failure (e.g. ENOENT on a full-path binary) fires 'error'
    // and may never fire 'exit' — delete here too so the dead entry can't linger.
    proc.on('error', err => { emit(id, 'error', err.message); sessions.delete(id); });
    proc.on('exit', code => { emit(id, 'exit', code); sessions.delete(id); });
    return { id, pty: false };
  });

  ipcMain.handle('runner:stop', (_e, id: string) => {
    const s = sessions.get(id);
    if (!s) return false;
    try { s.kind === 'pty' ? s.term.kill() : s.proc.kill(); } catch { /* already dead */ }
    return true;
  });

  ipcMain.handle('runner:input', (_e, id: string, data: string, raw?: boolean) => {
    const s = sessions.get(id);
    if (!s) return false;
    if (s.kind === 'pty') {
      // raw = keystrokes straight from xterm (already carry \r); otherwise a
      // line typed in the fallback input bar, so terminate it with a CR.
      s.term.write(raw ? data : (data.endsWith('\r') || data.endsWith('\n') ? data : data + '\r'));
      return true;
    }
    if (!s.proc.stdin || s.proc.stdin.destroyed) return false;
    s.proc.stdin.write(data.endsWith('\n') ? data : data + '\n');
    return true;
  });

  ipcMain.handle('runner:resize', (_e, id: string, cols: number, rows: number) => {
    const s = sessions.get(id);
    if (s?.kind === 'pty') {
      try { s.term.resize(Math.max(2, cols | 0), Math.max(1, rows | 0)); return true; } catch { return false; }
    }
    return false;
  });
}
