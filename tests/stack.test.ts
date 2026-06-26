import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { detectStack } from '../electron/executor/stack';

let root: string;
const mk = (name: string, files: Record<string, string>): string => {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  return dir;
};

beforeAll(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'stack-test-')); });
afterAll(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ } });

describe('detectStack', () => {
  it('rust → cargo check + cargo test', () => {
    const p = detectStack(mk('rust', { 'Cargo.toml': '[package]\nname="x"' }));
    expect(p.name).toBe('rust');
    expect(p.compile).toMatchObject({ bin: 'cargo', args: ['check', '--quiet'] });
    expect(p.test).toMatchObject({ bin: 'cargo' });
  });

  it('go → go build + go test', () => {
    const p = detectStack(mk('go', { 'go.mod': 'module x' }));
    expect(p.name).toBe('go');
    expect(p.compile?.args).toContain('build');
    expect(p.test?.args).toContain('test');
  });

  it('godot → headless launch as the compile check', () => {
    const p = detectStack(mk('godot', { 'project.godot': 'config_version=5' }), { godot: '/opt/godot' });
    expect(p.name).toBe('godot');
    expect(p.compile?.bin).toBe('/opt/godot');
    expect(p.compile?.args).toContain('--headless');
  });

  it('node → compile from typecheck script; test from test script; needsInstall when deps but no node_modules', () => {
    const p = detectStack(mk('node', { 'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit', test: 'vitest run' }, dependencies: { left: '1' } }) }));
    expect(p.name).toBe('node');
    expect(p.compile?.args).toEqual(['run', 'typecheck', '--silent']);
    expect(p.test?.args).toEqual(['test', '--silent']);
    expect(p.needsInstall).toBe(true);
  });

  it('node → no needsInstall when node_modules present; build script is the compile fallback', () => {
    const p = detectStack(mk('node2', { 'package.json': JSON.stringify({ scripts: { build: 'vite build' }, dependencies: { a: '1' } }), 'node_modules/.keep': '' }));
    expect(p.compile?.args).toEqual(['run', 'build', '--silent']);
    expect(p.needsInstall).toBe(false);
  });

  it('python → compileall (+ pytest only when tests exist)', () => {
    const noTests = detectStack(mk('py', { 'requirements.txt': 'flask' }));
    expect(noTests.name).toBe('python');
    expect(noTests.compile?.args).toContain('compileall');
    expect(noTests.test).toBeUndefined();
    const withTests = detectStack(mk('py2', { 'pyproject.toml': '[project]', 'tests/test_a.py': 'def test_x(): pass' }));
    expect(withTests.test?.args).toContain('pytest');
  });

  it('vanilla web (index.html, no package.json) → web', () => {
    expect(detectStack(mk('web', { 'index.html': '<canvas>', 'game.js': 'let x=1' })).name).toBe('web');
  });

  it('empty dir → unknown (gate skips, never false-fails)', () => {
    expect(detectStack(mk('empty', {})).name).toBe('unknown');
  });

  it('precedence: a Cargo.toml wins over a stray package.json', () => {
    expect(detectStack(mk('mixed', { 'Cargo.toml': '[package]', 'package.json': '{}' })).name).toBe('rust');
  });
});
