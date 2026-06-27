import { spawn, type SpawnOptions } from 'child_process';

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Run a command without a shell; capture all output. */
export function run(cmd: string, args: string[], opts: SpawnOptions & { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise(resolve => {
    const started = Date.now();
    const child = spawn(cmd, args, { ...opts, shell: false });
    let out = '';
    let err = '';
    let killed = false;
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch {} }, opts.timeoutMs);
    }
    child.stdout?.on('data', d => { out += d.toString(); });
    child.stderr?.on('data', d => { err += d.toString(); });
    child.on('error', e => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, code: null, stdout: out, stderr: err + String(e), durationMs: Date.now() - started });
    });
    child.on('close', code => {
      if (timer) clearTimeout(timer);
      resolve({
        ok: code === 0 && !killed,
        code,
        stdout: out,
        stderr: err + (killed ? '\n[killed: timeout]' : ''),
        durationMs: Date.now() - started
      });
    });
  });
}

export async function which(cmd: string): Promise<boolean> {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = await run(probe, [cmd], { timeoutMs: 5000 });
  return r.ok;
}
