import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { git } from '../electron/executor/git';
import { createWorktree, captureDiff, applyToLiveTree, removeWorktree, writeArtifacts } from '../electron/executor/worktree';

let repo: string;
let gitOk = true;

async function setupRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdeck-wt-'));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'test@clawdeck.local']);
  await git(dir, ['config', 'user.name', 'Test']);
  await git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.fusion/\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'line one\nline two\n', 'utf8');
  await git(dir, ['add', '-A']);
  const c = await git(dir, ['commit', '-m', 'init']);
  if (!c.ok) gitOk = false;
  return dir;
}

beforeAll(async () => { repo = await setupRepo(); }, 30000);
afterAll(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('worktree executor (real git)', () => {
  it('delegate round-trip: create → edit → capture diff → approve onto live tree', async () => {
    if (!gitOk) return;
    const { ok, wt } = await createWorktree(repo, 'run-approve');
    expect(ok).toBe(true);
    expect(fs.existsSync(wt.dir)).toBe(true);

    // an "actor" edits the worktree
    fs.writeFileSync(path.join(wt.dir, 'app.txt'), 'line one\nline two CHANGED\nline three\n', 'utf8');
    const diff = await captureDiff(wt);
    expect(diff).toContain('CHANGED');
    expect(diff).toContain('line three');
    writeArtifacts(wt, '# plan\nedit app.txt', diff);
    expect(fs.existsSync(path.join(wt.artifactsDir, 'CHANGE_PLAN.md'))).toBe(true);
    expect(fs.existsSync(path.join(wt.artifactsDir, 'changes.diff'))).toBe(true);

    // approve → apply onto live tree
    const ap = await applyToLiveTree(wt, diff);
    expect(ap.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8')).toContain('CHANGED');

    await removeWorktree(wt);
    expect(fs.existsSync(wt.dir)).toBe(false);
  }, 30000);

  it('reject leaves the live tree clean', async () => {
    if (!gitOk) return;
    // commit the prior approve so the tree is clean before this case
    await git(repo, ['add', '-A']);
    await git(repo, ['commit', '-m', 'approved change']);

    const { ok, wt } = await createWorktree(repo, 'run-reject');
    expect(ok).toBe(true);
    fs.writeFileSync(path.join(wt.dir, 'app.txt'), 'totally different\n', 'utf8');
    await captureDiff(wt);

    // reject: discard the worktree, never touch the live tree
    await removeWorktree(wt);
    expect(fs.existsSync(wt.dir)).toBe(false);

    const status = await git(repo, ['status', '--porcelain']);
    expect(status.stdout.trim()).toBe('');           // live tree clean (.fusion is gitignored)
    expect(fs.readFileSync(path.join(repo, 'app.txt'), 'utf8')).toContain('CHANGED'); // approved change intact
  }, 30000);
});
