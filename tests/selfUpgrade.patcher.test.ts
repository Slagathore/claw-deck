import { describe, it, expect } from 'vitest';
import { validatePatchSet, applyPatchSet, extractPatchSetFromText, PatchSet } from '../electron/selfUpgrade/patcher';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

describe('patcher.validatePatchSet', () => {
  const root = path.join(os.tmpdir(), 'claw-deck-patcher-validate');

  it('rejects empty file list', () => {
    const r = validatePatchSet({ id: 'x', rationale: '', files: [] }, root);
    expect(r.ok).toBe(false);
  });

  it('rejects absolute paths', () => {
    const r = validatePatchSet({ id: 'x', rationale: '', files: [{ path: '/etc/passwd', mode: 'replace', contents: '' }] }, root);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/absolute/);
  });

  it('rejects parent-escape paths', () => {
    const r = validatePatchSet({ id: 'x', rationale: '', files: [{ path: '../escape.ts', mode: 'replace', contents: '' }] }, root);
    expect(r.ok).toBe(false);
  });

  it('rejects .git segments', () => {
    const r = validatePatchSet({ id: 'x', rationale: '', files: [{ path: '.git/hooks/pre-commit', mode: 'replace', contents: '' }] }, root);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/forbidden/);
  });

  it('rejects node_modules segments', () => {
    const r = validatePatchSet({ id: 'x', rationale: '', files: [{ path: 'node_modules/evil/index.js', mode: 'replace', contents: '' }] }, root);
    expect(r.ok).toBe(false);
  });

  it('requires contents for create/replace', () => {
    const r = validatePatchSet({ id: 'x', rationale: '', files: [{ path: 'a.ts', mode: 'replace' }] }, root);
    expect(r.ok).toBe(false);
  });

  it('accepts a normal replacement', () => {
    const r = validatePatchSet({ id: 'x', rationale: '', files: [{ path: 'src/foo.ts', mode: 'replace', contents: 'export const a = 1;' }] }, root);
    expect(r.ok).toBe(true);
  });
});

describe('patcher.applyPatchSet', () => {
  it('writes files inside root and reports them', async () => {
    const root = path.join(os.tmpdir(), `claw-deck-patcher-apply-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    const patch: PatchSet = {
      id: 'demo', rationale: 'test',
      files: [
        { path: 'a/b/c.ts', mode: 'create', contents: 'export const x = 42;' },
        { path: 'README.md', mode: 'replace', contents: '# hi' }
      ]
    };
    const r = await applyPatchSet(patch, root);
    expect(r.changed.length).toBe(2);
    expect((await fs.readFile(path.join(root, 'a/b/c.ts'), 'utf8'))).toContain('42');
    expect((await fs.readFile(path.join(root, 'README.md'), 'utf8'))).toBe('# hi');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('throws on invalid patch set', async () => {
    const root = path.join(os.tmpdir(), `claw-deck-patcher-throw-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    await expect(applyPatchSet({ id: 'x', rationale: '', files: [{ path: '../bad', mode: 'replace', contents: '' }] }, root))
      .rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('deletes files when mode=delete', async () => {
    const root = path.join(os.tmpdir(), `claw-deck-patcher-del-${Date.now()}`);
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(path.join(root, 'goner.txt'), 'gone');
    await applyPatchSet({ id: 'x', rationale: '', files: [{ path: 'goner.txt', mode: 'delete' }] }, root);
    await expect(fs.access(path.join(root, 'goner.txt'))).rejects.toThrow();
    await fs.rm(root, { recursive: true, force: true });
  });
});

describe('patcher.extractPatchSetFromText', () => {
  it('parses a fenced JSON block', () => {
    const text = 'Here is your patch:\n```json\n{"id":"x","rationale":"y","files":[{"path":"a.ts","mode":"create","contents":"//"}]}\n```\nDone.';
    const p = extractPatchSetFromText(text);
    expect(p).not.toBeNull();
    expect(p!.id).toBe('x');
    expect(p!.files.length).toBe(1);
  });

  it('parses raw JSON without a fence', () => {
    const text = '{"id":"x","rationale":"y","files":[{"path":"a.ts","mode":"create","contents":""}]}';
    const p = extractPatchSetFromText(text);
    expect(p).not.toBeNull();
  });

  it('returns null on garbage', () => {
    expect(extractPatchSetFromText('hello world')).toBeNull();
    expect(extractPatchSetFromText('')).toBeNull();
    expect(extractPatchSetFromText('{not json')).toBeNull();
  });

  it('returns null when files is not an array', () => {
    expect(extractPatchSetFromText('{"id":"x","files":"not-array"}')).toBeNull();
  });
});
