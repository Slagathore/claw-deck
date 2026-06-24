import { describe, it, expect } from 'vitest';
import { parsePolyglot, polyLangOf } from '../electron/atlas/parse/polyglot';

const FILES: Record<string, string> = {
  'svc.py': [
    'class Service:',
    '    def run(self):',
    '        return helper()',
    '',
    'def helper():',
    '    return 1',
    '',
    'def _unused():',
    '    return 2',
  ].join('\n'),
  'deploy.sh': [
    'function deploy() {',
    '  build',
    '}',
    'build() {',
    '  echo hi',
    '}',
  ].join('\n'),
  'player.gd': [
    'extends Node',
    'class_name Player',
    'var health = 100',
    'func _ready():',
    '    move()',
    'func move():',
    '    pass',
  ].join('\n'),
};

describe('parsePolyglot', () => {
  const { symbols, edges } = parsePolyglot(FILES);
  const byKey = (k: string) => symbols.find((s) => s.key === k);
  const hasEdge = (src: string, dst: string, kind: string) => edges.some((e) => e.srcKey === src && e.dstKey === dst && e.kind === kind);

  it('detects language by extension', () => {
    expect(polyLangOf('a.py')).toBe('python');
    expect(polyLangOf('a.sh')).toBe('bash');
    expect(polyLangOf('a.gd')).toBe('gdscript');
    expect(polyLangOf('a.ts')).toBeNull();
  });

  it('python: class, methods, functions, privacy', () => {
    expect(byKey('svc.py#Service')?.kind).toBe('class');
    expect(byKey('svc.py#Service.run')?.kind).toBe('method');
    expect(byKey('svc.py#helper')?.kind).toBe('function');
    expect(byKey('svc.py#_unused')?.exported).toBe(false);
    expect(hasEdge('svc.py#Service.run', 'svc.py#helper', 'calls')).toBe(true);
  });

  it('bash: function defs + bare-word call edges', () => {
    expect(byKey('deploy.sh#deploy')?.kind).toBe('function');
    expect(byKey('deploy.sh#build')?.kind).toBe('function');
    expect(hasEdge('deploy.sh#deploy', 'deploy.sh#build', 'calls')).toBe(true);
  });

  it('gdscript: class_name, funcs, vars, calls', () => {
    expect(byKey('player.gd#Player')?.kind).toBe('class');
    expect(byKey('player.gd#_ready')?.kind).toBe('function');
    expect(byKey('player.gd#move')?.kind).toBe('function');
    expect(byKey('player.gd#health')?.kind).toBe('const');
    expect(hasEdge('player.gd#_ready', 'player.gd#move', 'calls')).toBe(true);
  });

  it('creates a module anchor per file', () => {
    expect(byKey('svc.py#<module>')?.kind).toBe('module');
    expect(byKey('deploy.sh#<module>')?.kind).toBe('module');
    expect(byKey('player.gd#<module>')?.kind).toBe('module');
  });
});
