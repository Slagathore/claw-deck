import { spawn, type SpawnOptions } from 'child_process';

export interface RunResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** Run a command and capture all output. */
export function run(cmd: string, args: string[], opts: SpawnOptions & { timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise(resolve => {
    const started = Date.now();
    // On Windows, batch launchers (npm.cmd, npx.cmd, clawhub.cmd, …) cannot be
    // spawned directly — Node >=20.12 / 24 throws EINVAL (the CVE-2024-27980 fix).
    // Route those through a shell; real executables (git.exe, where.exe) stay
    // shell-free. Callers may still force `shell` explicitly via opts.
    // SECURITY: once shell:true is chosen, `args` is interpreted by cmd.exe,
    // not passed straight to the process — every element becomes a piece of a
    // shell command line. Every caller in this codebase passes fixed,
    // developer-written args (npm/git subcommands), never attacker- or
    // model-influenced strings. Keep it that way: do not wire scraped, remote,
    // or LLM-generated content into `args` for a `.cmd`/`.bat` call without
    // adding real quoting/validation first.
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
    const child = spawn(cmd, args, { ...opts, shell: opts.shell ?? needsShell });
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
