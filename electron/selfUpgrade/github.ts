import { run, which } from './exec';

export interface RepoStatus {
  hasGit: boolean;
  isRepo: boolean;
  hasOrigin: boolean;
  originUrl?: string;
  branch?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
}

export async function repoStatus(root: string): Promise<RepoStatus> {
  if (!(await which('git'))) return { hasGit: false, isRepo: false, hasOrigin: false };
  const rev = await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, timeoutMs: 5000 });
  if (!rev.ok) return { hasGit: true, isRepo: false, hasOrigin: false };
  const origin = await run('git', ['remote', 'get-url', 'origin'], { cwd: root, timeoutMs: 5000 });
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root, timeoutMs: 5000 });
  const status = await run('git', ['status', '--porcelain'], { cwd: root, timeoutMs: 10000 });
  return {
    hasGit: true,
    isRepo: true,
    hasOrigin: origin.ok,
    originUrl: origin.ok ? origin.stdout.trim() : undefined,
    branch: branch.ok ? branch.stdout.trim() : undefined,
    dirty: status.ok ? status.stdout.trim().length > 0 : undefined
  };
}

/**
 * Add an `origin` remote pointing at a GitHub repo (always defaults to private — see UI).
 * Does not create the GitHub repo itself — caller must ensure it exists.
 */
export async function setOrigin(root: string, url: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await which('git'))) return { ok: false, error: 'git not on PATH' };
  const r = await run('git', ['remote', 'add', 'origin', url], { cwd: root, timeoutMs: 5000 });
  if (!r.ok) {
    // remote may already exist — try set-url instead.
    const setUrl = await run('git', ['remote', 'set-url', 'origin', url], { cwd: root, timeoutMs: 5000 });
    if (!setUrl.ok) return { ok: false, error: setUrl.stderr.trim() || r.stderr.trim() };
  }
  return { ok: true };
}

export async function pushSnapshot(root: string, branch: string): Promise<{ ok: boolean; error?: string }> {
  if (!(await which('git'))) return { ok: false, error: 'git not on PATH' };
  const r = await run('git', ['push', '--force-with-lease', 'origin', branch], { cwd: root, timeoutMs: 60000 });
  return { ok: r.ok, error: r.ok ? undefined : (r.stderr.trim() || r.stdout.trim()) };
}
