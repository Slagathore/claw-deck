import { describe, it, expect } from 'vitest';
import { gateMode, describeGate, type GateResult } from '../electron/selfUpgrade/gate';

describe('gateMode — honest about what could run', () => {
  it('is full only when npm AND node_modules are present', () => {
    expect(gateMode({ npm: true, nodeModules: true })).toBe('full');
  });
  it('is reduced when node_modules is missing (packaged, deps not prepared)', () => {
    expect(gateMode({ npm: true, nodeModules: false })).toBe('reduced');
  });
  it('is reduced when npm is missing', () => {
    expect(gateMode({ npm: false, nodeModules: true })).toBe('reduced');
  });
});

describe('describeGate', () => {
  it('names the checks that ran and the ones that were skipped', () => {
    const g: GateResult = {
      ok: true, reasons: [], mode: 'reduced',
      ran: ['security-scan-delta'],
      skipped: [{ check: 'typecheck (tsc)', reason: 'no node_modules' }, { check: 'unit tests (vitest)', reason: 'no node_modules' }],
      baseline: { critical: 0, high: 0 }, patched: { critical: 0, high: 0 }, newCritical: [], newHigh: []
    };
    const s = describeGate(g);
    expect(s).toMatch(/reduced gate/);
    expect(s).toMatch(/ran: security-scan-delta/);
    expect(s).toMatch(/skipped: typecheck \(tsc\), unit tests \(vitest\)/);
  });
});
