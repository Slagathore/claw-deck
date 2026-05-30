import { spawn } from 'child_process';
import * as fs from 'fs';

export interface ScanResult { ok: boolean; engine: string; detail: string; }

export interface YaraOptions {
  /** Path to a yara rules file (.yar / .yara) */
  rulesPath?: string;
  /** Path to the yara binary; defaults to "yara" on PATH */
  binary?: string;
  /** Hard timeout in ms; default 30s */
  timeoutMs?: number;
}

/**
 * Run a YARA scan over `file` using `rulesPath`. Soft-fails (ok=true,
 * "not installed" / "no rules") so a missing yara binary or unconfigured
 * rules never breaks the upgrade pipeline. Any rule match is a hard fail.
 */
export async function yaraScan(file: string, opts: YaraOptions = {}): Promise<ScanResult> {
  if (!opts.rulesPath) {
    return { ok: true, engine: 'yara', detail: 'skipped: no rules path configured' };
  }
  if (!fs.existsSync(opts.rulesPath)) {
    return { ok: true, engine: 'yara', detail: `skipped: rules file not found at ${opts.rulesPath}` };
  }
  const binary = opts.binary || 'yara';
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return new Promise<ScanResult>(resolve => {
    let settled = false;
    const finish = (r: ScanResult) => { if (!settled) { settled = true; resolve(r); } };

    let p;
    try {
      p = spawn(binary, ['-r', opts.rulesPath!, file], { shell: false });
    } catch (e: any) {
      return finish({ ok: true, engine: 'yara', detail: `skipped: spawn failed (${e?.message ?? 'unknown'})` });
    }

    let out = '';
    let err = '';
    p.stdout?.on('data', d => (out += d.toString()));
    p.stderr?.on('data', d => (err += d.toString()));
    p.on('error', e => {
      // ENOENT etc. — yara not installed; soft-fail
      finish({ ok: true, engine: 'yara', detail: `skipped: ${e.message}` });
    });

    const t = setTimeout(() => {
      try { p.kill(); } catch { /* ignore */ }
      finish({ ok: false, engine: 'yara', detail: `timeout after ${timeoutMs}ms` });
    }, timeoutMs);

    p.on('exit', code => {
      clearTimeout(t);
      // yara exits 0 with output lines when matches are found, 0 with no output when none.
      // Non-zero on rule compile errors -> soft fail (do not block install on a broken rule file).
      if (code !== 0) {
        return finish({ ok: true, engine: 'yara', detail: `skipped: yara exited ${code} ${err.slice(0, 200)}` });
      }
      const matches = parseYaraStdout(out, file);
      if (matches.length === 0) {
        return finish({ ok: true, engine: 'yara', detail: 'no rules matched' });
      }
      return finish({ ok: false, engine: 'yara', detail: `matched rules: ${matches.join(', ')}` });
    });
  });
}

/**
 * Parse the default `yara` CLI output format: lines are `<RuleName> <path>`.
 * Returns the list of rule names that matched the given file.
 */
export function parseYaraStdout(stdout: string, file: string): string[] {
  const matches: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    // Expected: "RuleName <whitespace> path"
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const ruleName = parts[0];
    const matchedPath = parts.slice(1).join(' ');
    // Be forgiving about path normalization
    if (matchedPath === file || matchedPath.endsWith(file) || file.endsWith(matchedPath)) {
      matches.push(ruleName);
    } else {
      // when the path comparison is fuzzy, still surface the rule
      matches.push(ruleName);
    }
  }
  return Array.from(new Set(matches));
}
