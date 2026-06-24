import { describe, it, expect } from 'vitest';
import { parseTsProgram } from '../electron/atlas/parse/tsProgram';

const FILES: Record<string, string> = {
  'src/util.ts': `
export function helper(x: number) { return x + 1; }
/** @deprecated use helper */
export function oldHelper(x: number) { return x; }
function privateOrphan() { return 42; }
`,
  'src/main.ts': `
import { helper } from './util';
export function run() { return helper(2); }
export class Service {
  go() { return this.inner(); }
  inner() { return run(); }
}
`,
  'src/Widget.tsx': `
export const Widget = () => null;
export function Panel() { return null; }
`,
};

describe('parseTsProgram', () => {
  const { symbols, edges } = parseTsProgram(FILES);
  const byKey = (k: string) => symbols.find((s) => s.key === k);
  const hasEdge = (src: string, dst: string, kind: string) =>
    edges.some((e) => e.srcKey === src && e.dstKey === dst && e.kind === kind && e.resolved);

  it('extracts top-level symbols with kinds', () => {
    expect(byKey('src/util.ts#helper')?.kind).toBe('function');
    expect(byKey('src/main.ts#run')?.kind).toBe('function');
    expect(byKey('src/main.ts#Service')?.kind).toBe('class');
    expect(byKey('src/main.ts#Service.go')?.kind).toBe('method');
    expect(byKey('src/main.ts#Service.inner')?.kind).toBe('method');
  });

  it('classifies exported tsx PascalCase as component', () => {
    expect(byKey('src/Widget.tsx#Widget')?.kind).toBe('component');
    expect(byKey('src/Widget.tsx#Panel')?.kind).toBe('component');
  });

  it('flags @deprecated and exported-ness', () => {
    expect(byKey('src/util.ts#oldHelper')?.deprecated).toBe(true);
    expect(byKey('src/util.ts#helper')?.exported).toBe(true);
    expect(byKey('src/util.ts#privateOrphan')?.exported).toBe(false);
  });

  it('resolves a cross-file caller -> callee edge', () => {
    expect(hasEdge('src/main.ts#run', 'src/util.ts#helper', 'calls')).toBe(true);
  });

  it('resolves intra-class method calls (this.inner / run)', () => {
    expect(hasEdge('src/main.ts#Service.go', 'src/main.ts#Service.inner', 'calls')).toBe(true);
    expect(hasEdge('src/main.ts#Service.inner', 'src/main.ts#run', 'calls')).toBe(true);
  });

  it('emits import edges from the module anchor', () => {
    expect(hasEdge('src/main.ts#<module>', 'src/util.ts#helper', 'imports')).toBe(true);
  });

  it('creates one module anchor per file', () => {
    expect(byKey('src/util.ts#<module>')?.kind).toBe('module');
    expect(byKey('src/main.ts#<module>')?.kind).toBe('module');
  });
});
