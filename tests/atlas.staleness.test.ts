import { describe, it, expect } from 'vitest';
import { computeStaleness, makeEntrypointPredicate } from '../electron/atlas/staleness';

describe('computeStaleness', () => {
  const symbols = [
    { key: 'main.ts#<module>', exported: true },
    { key: 'main.ts#run', exported: true },
    { key: 'util.ts#helper', exported: true },
    { key: 'util.ts#privateOrphan', exported: false },
    { key: 'util.ts#oldDup', exported: false },
    { key: 'util.ts#newDup', exported: false },
    { key: 'util.ts#legacy', exported: true, deprecated: true },
  ];
  const edges = [
    { srcKey: 'main.ts#<module>', dstKey: 'main.ts#run' },
    { srcKey: 'main.ts#run', dstKey: 'util.ts#helper' },
    { srcKey: 'main.ts#run', dstKey: 'util.ts#newDup' },
  ];
  const res = computeStaleness({
    symbols,
    edges,
    isEntrypoint: makeEntrypointPredicate(['main.ts']),
    similarPairs: [['util.ts#oldDup', 'util.ts#newDup']],
  });

  it('marks reachable symbols active', () => {
    expect(res.status.get('main.ts#run')).toBe('active');
    expect(res.status.get('util.ts#helper')).toBe('active');
  });

  it('marks unreachable internal symbols orphaned', () => {
    expect(res.status.get('util.ts#privateOrphan')).toBe('orphaned');
  });

  it('marks the zero-ref look-alike superseded', () => {
    expect(res.status.get('util.ts#oldDup')).toBe('superseded');
    expect(res.supersededBy.get('util.ts#oldDup')).toBe('util.ts#newDup');
  });

  it('marks @deprecated as deprecated even if exported', () => {
    expect(res.status.get('util.ts#legacy')).toBe('deprecated');
  });

  it('counts incoming references', () => {
    expect(res.refCount.get('util.ts#helper')).toBe(1);
    expect(res.refCount.get('util.ts#newDup')).toBe(1);
    expect(res.refCount.get('util.ts#oldDup')).toBe(0);
  });

  it('keeps exported-but-unreachable symbols active (public surface)', () => {
    // helper is reachable; make an exported, unreachable one:
    const r = computeStaleness({
      symbols: [{ key: 'a.ts#pub', exported: true }],
      edges: [],
      isEntrypoint: () => false,
    });
    expect(r.status.get('a.ts#pub')).toBe('active');
  });
});
