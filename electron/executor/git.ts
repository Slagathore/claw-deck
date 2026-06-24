// Thin git wrapper reusing selfUpgrade/exec.run (no shell, captured output).
import { run, RunResult } from '../selfUpgrade/exec';

export function git(repoOrWt: string, args: string[], timeoutMs = 120000): Promise<RunResult> {
  return run('git', ['-C', repoOrWt, ...args], { timeoutMs });
}
