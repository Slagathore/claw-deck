// Validation (BOOTSTRAP §3 Phase 2): run the worktree through the existing
// edit-safety sandbox (clone → npm ci → npm test) before any merge. Reuses
// selfUpgrade/sandbox.runInSandbox verbatim — do not reimplement.
import { runInSandbox, SandboxResult } from '../selfUpgrade/sandbox';
import { Worktree } from './worktree';

export function validateWorktree(wt: Worktree, timeoutMs?: number): Promise<SandboxResult> {
  return runInSandbox({ sourceRoot: wt.dir, timeoutMs });
}
