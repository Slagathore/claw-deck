// Autonomous goal loop (BOOTSTRAP §3 Phase 5). Pure state machine over injected
// deps so it's fully unit-testable (no git/transport). Each iteration:
//   run protocol → checkpoint (commit) → goal-check → derive next sub-task.
// Rails: max-iterations, cost ceiling, oscillation detector (same change
// proposed↔reverted twice → stop), optional human checkpoint every N.

import { RunResult } from './run';

export interface GoalCheck { met: boolean; reason: string; nextSubtask?: string }

export interface AutoloopEvent { type: string; iter?: number; reason?: string; signature?: string; status?: string; task?: string }

export interface AutoloopDeps {
  goal: string;
  runIteration: (task: string, iter: number) => Promise<RunResult>;
  checkGoal: (goal: string, iter: number, last: RunResult) => Promise<GoalCheck>;
  /** Commit a per-iteration checkpoint; return a signature of the resulting state (for oscillation detection). */
  checkpoint: (iter: number, last: RunResult) => Promise<{ signature: string }>;
  maxIterations: number;
  costCeiling?: number;
  costSoFar?: () => number;
  humanCheckpointEvery?: number;
  onHumanCheckpoint?: (iter: number) => Promise<boolean>;
  emit?: (ev: AutoloopEvent) => void;
  signal?: { aborted: boolean };
}

export interface AutoloopResult {
  status: 'met' | 'cap' | 'oscillation' | 'cost' | 'halted' | 'aborted';
  iterations: number;
  signatures: string[];
  lastReason: string;
}

/** A,B,A,B alternation in the last four signatures = a change proposed↔reverted twice. */
export function oscillates(sigs: string[]): boolean {
  const n = sigs.length;
  if (n < 4) return false;
  const [a, b, c, d] = sigs.slice(n - 4);
  return a === c && b === d && a !== b;
}

export async function runAutoloop(deps: AutoloopDeps): Promise<AutoloopResult> {
  const emit = (ev: AutoloopEvent) => { try { deps.emit?.(ev); } catch { /* ignore */ } };
  const signatures: string[] = [];
  let task = deps.goal;
  let lastReason = '';

  for (let iter = 1; iter <= deps.maxIterations; iter++) {
    if (deps.signal?.aborted) return { status: 'aborted', iterations: iter - 1, signatures, lastReason };
    emit({ type: 'iteration', iter, task });

    const result = await deps.runIteration(task, iter);
    const { signature } = await deps.checkpoint(iter, result);
    signatures.push(signature);
    emit({ type: 'checkpoint', iter, signature });

    if (oscillates(signatures)) {
      emit({ type: 'halt', iter, status: 'oscillation', reason: 'same change proposed↔reverted twice' });
      return { status: 'oscillation', iterations: iter, signatures, lastReason };
    }

    const check = await deps.checkGoal(deps.goal, iter, result);
    lastReason = check.reason;
    emit({ type: 'goal-check', iter, reason: check.reason, status: check.met ? 'met' : 'not-met' });
    if (check.met) { emit({ type: 'halt', iter, status: 'met' }); return { status: 'met', iterations: iter, signatures, lastReason }; }

    if (deps.costCeiling != null && deps.costSoFar && deps.costSoFar() >= deps.costCeiling) {
      emit({ type: 'halt', iter, status: 'cost' });
      return { status: 'cost', iterations: iter, signatures, lastReason };
    }

    if (deps.humanCheckpointEvery && deps.onHumanCheckpoint && iter % deps.humanCheckpointEvery === 0) {
      const cont = await deps.onHumanCheckpoint(iter);
      if (!cont) { emit({ type: 'halt', iter, status: 'halted' }); return { status: 'halted', iterations: iter, signatures, lastReason }; }
    }

    task = check.nextSubtask?.trim() || `${deps.goal}\n\nThe previous attempt did NOT satisfy the goal: ${check.reason}\nProduce a different, concrete next step.`;
  }

  emit({ type: 'halt', iter: deps.maxIterations, status: 'cap' });
  return { status: 'cap', iterations: deps.maxIterations, signatures, lastReason };
}
