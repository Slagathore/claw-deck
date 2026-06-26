// Validation (BOOTSTRAP §3 Phase 2): run the worktree through the PER-STACK compile/
// test gate (electron/executor/stack.ts) before any merge. This replaces the old
// node-only sandbox (clone → npm ci → npm test) with stack-aware detection so a
// from-scratch game in any stack (HTML/JS, Godot, Python, Rust, Go, Node) is gated
// by a real build/test — and a missing toolchain degrades to "skipped", never a
// false failure. selfUpgrade still uses runInSandbox directly for its own gate.
import { Worktree } from './worktree';
import { runStackGate } from './stack';
import { getSetting } from '../ipc/settings';

export interface ValidationResult {
  ok: boolean;
  mode: 'stack';
  stack: string;
  ran: boolean;
  reason?: string;
  output?: string;
  testOutput?: string;   // back-compat alias of output (older consumers)
  durationMs: number;
}

export async function validateWorktree(wt: Worktree, timeoutMs?: number): Promise<ValidationResult> {
  const started = Date.now();
  const godot = getSetting<string>('godotPath', 'godot') || 'godot';
  const g = await runStackGate(wt.dir, { timeoutMs, godot });
  const output = g.output;
  return {
    ok: g.ok, mode: 'stack', stack: g.stack, ran: g.ran,
    reason: g.ok ? undefined : `${g.stage ?? 'gate'} failed`,
    output, testOutput: output, durationMs: Date.now() - started,
  };
}
