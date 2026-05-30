import * as http from 'http';
import * as crypto from 'crypto';
import { spawn } from 'child_process';
import { app } from 'electron';

/**
 * Probe protocol:
 *   - Parent starts an HTTP server on 127.0.0.1:RAND with a random token.
 *   - Parent spawns a fresh electron instance (the patched build) with
 *     CLAW_PROBE_PORT, CLAW_PROBE_TOKEN, CLAW_PROBE_ID env vars set.
 *   - Child (in probe mode — see main.ts) runs its boot + self-checks and
 *     POSTs each check result to /report on the parent server. After all
 *     checks the child POSTs /done and exits 0. If anything throws it
 *     POSTs /fail and exits 1.
 *   - Parent times out the whole exchange after `timeoutMs`.
 */
export type ProbeCheck = 'boot' | 'db' | 'tray' | 'ollama' | 'render' | 'scan';

export interface ProbeResult {
  ok: boolean;
  reason?: string;
  checks: Partial<Record<ProbeCheck, { ok: boolean; detail?: string }>>;
  durationMs: number;
}

export interface ProbeOpts {
  /** Path to the electron executable to launch (parent's process.execPath is fine in dev). */
  electronExe: string;
  /** Arg to pass — usually the path to the *patched* main.js or the project root. */
  appArg: string;
  /** Working directory (the patched source root). */
  cwd: string;
  timeoutMs?: number;
  checks: ProbeCheck[];
}

export async function runProbe(opts: ProbeOpts): Promise<ProbeResult> {
  const started = Date.now();
  const token = crypto.randomBytes(16).toString('hex');
  const id = crypto.randomBytes(8).toString('hex');
  const checks: ProbeResult['checks'] = {};
  let done = false;
  let failReason: string | undefined;

  const server = http.createServer((req, res) => {
    if (req.headers['x-probe-token'] !== token) {
      res.statusCode = 403; res.end(); return;
    }
    let body = '';
    req.on('data', c => { body += c.toString(); });
    req.on('end', () => {
      try {
        const j = body ? JSON.parse(body) : {};
        if (req.url === '/report' && j.check) {
          checks[j.check as ProbeCheck] = { ok: !!j.ok, detail: j.detail };
        } else if (req.url === '/done') {
          done = true;
        } else if (req.url === '/fail') {
          done = true; failReason = j.reason || 'unknown';
        }
        res.statusCode = 200; res.end('ok');
      } catch (e: any) {
        res.statusCode = 400; res.end(e.message);
      }
    });
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as any).port as number;

  const child = spawn(opts.electronExe, [opts.appArg], {
    cwd: opts.cwd,
    env: {
      ...process.env,
      CLAW_PROBE_PORT: String(port),
      CLAW_PROBE_TOKEN: token,
      CLAW_PROBE_ID: id,
      CLAW_PROBE_CHECKS: opts.checks.join(',')
    },
    stdio: 'ignore',
    detached: false
  });

  const timeoutMs = opts.timeoutMs ?? 60000;
  const result: ProbeResult = await new Promise(resolve => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({
        ok: false,
        reason: failReason || 'probe timeout',
        checks,
        durationMs: Date.now() - started
      });
    }, timeoutMs);

    child.on('exit', () => {
      clearTimeout(timer);
      // Wait briefly for any in-flight /done request to land.
      setTimeout(() => {
        const allPassed = opts.checks.every(c => checks[c]?.ok);
        resolve({
          ok: done && allPassed && !failReason,
          reason: failReason || (allPassed ? undefined : 'one or more checks failed'),
          checks,
          durationMs: Date.now() - started
        });
      }, 250);
    });

    child.on('error', e => {
      clearTimeout(timer);
      resolve({
        ok: false,
        reason: `spawn failed: ${e.message}`,
        checks,
        durationMs: Date.now() - started
      });
    });
  });

  try { server.close(); } catch {}
  return result;
}

/**
 * Called by main.ts when CLAW_PROBE_ID is set in env.
 * Runs the requested check sequence, posts results, then app.quit()s.
 */
export async function executeProbeMode(checks: {
  boot?: () => Promise<{ ok: boolean; detail?: string }>;
  db?: () => Promise<{ ok: boolean; detail?: string }>;
  tray?: () => Promise<{ ok: boolean; detail?: string }>;
  ollama?: () => Promise<{ ok: boolean; detail?: string }>;
  render?: () => Promise<{ ok: boolean; detail?: string }>;
  scan?: () => Promise<{ ok: boolean; detail?: string }>;
}): Promise<void> {
  const port = parseInt(process.env.CLAW_PROBE_PORT || '0', 10);
  const token = process.env.CLAW_PROBE_TOKEN || '';
  const requested = (process.env.CLAW_PROBE_CHECKS || '').split(',').filter(Boolean) as ProbeCheck[];

  async function post(pathname: string, body: any) {
    return new Promise<void>(resolve => {
      const data = Buffer.from(JSON.stringify(body));
      const req = http.request({
        host: '127.0.0.1', port, path: pathname, method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': data.length,
          'x-probe-token': token
        }
      }, res => { res.resume(); res.on('end', () => resolve()); });
      req.on('error', () => resolve());
      req.write(data); req.end();
    });
  }

  try {
    for (const c of requested) {
      const fn = (checks as any)[c];
      if (!fn) continue;
      try {
        const r = await fn();
        await post('/report', { check: c, ok: r.ok, detail: r.detail });
        if (!r.ok) {
          await post('/fail', { reason: `${c} failed: ${r.detail || ''}` });
          break;
        }
      } catch (e: any) {
        await post('/report', { check: c, ok: false, detail: e.message });
        await post('/fail', { reason: `${c} threw: ${e.message}` });
        break;
      }
    }
    await post('/done', {});
  } finally {
    setTimeout(() => app.exit(0), 100);
  }
}
