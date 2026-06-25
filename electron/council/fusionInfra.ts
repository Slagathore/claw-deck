// Fusion-methods §1.2 (no-abort / fix-or-fallback) + §1.3 (artifact handoff integrity).
//
// Shared infra every method wraps its phases in. The GLOBAL RULE is: nothing
// terminates a run on error. Every failure path is fix-or-fallback; the only
// terminal state is "completed with a final artifact + report," possibly degraded
// and clearly labeled.
//
// The pure functions here (hash / integrity / echo / runPhase / boundedRepair) are
// dependency-injected and fully unit-testable. The fs-backed artifact store at the
// bottom is the §1.3 "pass by reference, not inline string" plumbing.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';

// ----------------------------- §1.3 integrity primitives -----------------------------

/** First 12 hex chars of the sha256 — the short fingerprint used in echo headers. */
export function sha12(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
}

/**
 * Assert a downstream artifact wasn't truncated in transit. The bounce cause was an
 * artifact inline-truncated to ~15%; here `received` must be ≥ `source * minRatio`.
 */
export function integrityOk(received: string, source: string, minRatio = 0.98): { ok: boolean; ratio: number; reason?: string } {
  if (!source) return { ok: true, ratio: 1 };
  const ratio = received.length / source.length;
  if (ratio < minRatio) return { ok: false, ratio, reason: `received ${received.length} chars vs source ${source.length} (${Math.round(ratio * 100)}%) — truncated handoff` };
  return { ok: true, ratio };
}

/** The echo header a reviewer/judge must emit first: `REVIEWING: <sha12> | <first80>…<last80>`. */
export function reviewingHeader(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  const first = t.slice(0, 80);
  const last = t.length > 160 ? t.slice(-80) : '';
  return `REVIEWING: ${sha12(text)} | ${first}${last ? `…${last}` : ''}`;
}

/** Does a reviewer's reply open with an echo header whose sha12 matches `source`? */
export function echoMatches(reply: string, source: string): boolean {
  const m = reply.match(/REVIEWING:\s*([0-9a-f]{12})\b/i);
  return !!m && m[1].toLowerCase() === sha12(source);
}

// ----------------------------- §1.2 no-abort phase wrapper -----------------------------

export interface PhaseOutcome<T> { value: T; degraded: boolean; warnings: string[] }

/**
 * Run a phase so it ALWAYS returns a value. On throw: retry `retries` times; if it
 * still fails, resolve `fallback` (a value or a thunk) and mark the outcome degraded.
 * Never throws. The fallback thunk failing also degrades (caller's fallback must be safe).
 */
export async function runPhase<T>(
  name: string,
  fn: () => Promise<T>,
  opts: { fallback: T | (() => T | Promise<T>); retries?: number; onWarn?: (msg: string) => void },
): Promise<PhaseOutcome<T>> {
  const retries = opts.retries ?? 1;
  const warnings: string[] = [];
  const warn = (m: string) => { warnings.push(m); try { opts.onWarn?.(m); } catch { /* ignore */ } };
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return { value: await fn(), degraded: false, warnings };
    } catch (e: any) {
      warn(`phase '${name}' attempt ${attempt + 1}/${retries + 1} failed: ${String(e?.message ?? e)}`);
    }
  }
  // all attempts failed → fall back, stay alive
  try {
    const fb = typeof opts.fallback === 'function' ? await (opts.fallback as () => T | Promise<T>)() : opts.fallback;
    warn(`phase '${name}' fell back to last-good value (DEGRADED)`);
    return { value: fb, degraded: true, warnings };
  } catch (e: any) {
    warn(`phase '${name}' fallback ALSO failed: ${String(e?.message ?? e)}`);
    return { value: undefined as unknown as T, degraded: true, warnings };
  }
}

// ----------------------------- §1.2/§1.4 bounded repair loop -----------------------------

export interface RecheckResult<F> { passed: boolean; findings: F[]; report: string }

/**
 * Route gate/lint/QA findings into a bounded auto-repair loop (default 2 rounds).
 * `repair` produces a new artifact from the findings report; `recheck` re-gates it.
 * Returns the best artifact reached — if still failing after `maxRounds`, callers
 * attach `residual` to the report and SHIP (never abort). Never throws.
 */
export async function boundedRepair<F>(
  artifact: string,
  initial: RecheckResult<F>,
  repair: (artifact: string, report: string) => Promise<string>,
  recheck: (artifact: string) => RecheckResult<F> | Promise<RecheckResult<F>>,
  opts: { maxRounds?: number } = {},
): Promise<{ artifact: string; passed: boolean; rounds: number; residual: F[] }> {
  const maxRounds = opts.maxRounds ?? 2;
  if (initial.passed) return { artifact, passed: true, rounds: 0, residual: [] };
  let current = artifact;
  let report = initial.report;
  let residual = initial.findings;
  for (let round = 1; round <= maxRounds; round++) {
    try {
      const repaired = await repair(current, report);
      if (repaired && repaired.length) current = repaired;
      const r = await recheck(current);
      if (r.passed) return { artifact: current, passed: true, rounds: round, residual: [] };
      report = r.report;
      residual = r.findings;
    } catch {
      // repair/recheck failed → stop looping, ship the best artifact so far
      return { artifact: current, passed: false, rounds: round, residual };
    }
  }
  return { artifact: current, passed: false, rounds: maxRounds, residual };
}

// ----------------------------- §1.3 pass-by-reference artifact store -----------------------------

export interface ArtifactRef { path: string; sha12: string; bytes: number; summary: string }

/**
 * Per-run artifact store under `.fusion/run-<id>/`. Phases write their full output to
 * a file and pass the REFERENCE (path + sha + short summary) downstream — never the
 * inline-truncated string. `read` re-reads the full text and asserts the sha matches.
 */
export function artifactStore(runDir: string) {
  return {
    dir: runDir,
    async write(phase: string, agent: string, text: string): Promise<ArtifactRef> {
      await fs.mkdir(runDir, { recursive: true });
      const safe = `${phase}-${agent}`.replace(/[^\w.-]+/g, '_').slice(0, 80);
      const p = path.join(runDir, `${safe}.md`);
      await fs.writeFile(p, text, 'utf8');
      return { path: p, sha12: sha12(text), bytes: Buffer.byteLength(text, 'utf8'), summary: text.replace(/\s+/g, ' ').trim().slice(0, 200) };
    },
    async read(ref: ArtifactRef): Promise<{ text: string; ok: boolean }> {
      const text = await fs.readFile(ref.path, 'utf8');
      return { text, ok: sha12(text) === ref.sha12 };
    },
  };
}
