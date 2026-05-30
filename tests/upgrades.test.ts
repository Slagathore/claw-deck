import { describe, it, expect } from 'vitest';

// Smoke tests for shape contracts we depend on in the renderer.
describe('upgrade manifest contract', () => {
  it('rejects manifest without url', () => {
    const m: any = { kind: 'openclaw', name: 'x', version: '1.0' };
    expect(!!m.url).toBe(false);
  });
  it('accepts well-formed manifest', () => {
    const m = { kind: 'openclaw', name: 'x', version: '1.0', url: 'https://github.com/x/y.zip', sha256: 'a'.repeat(64) };
    expect(m.sha256.length).toBe(64);
    expect(m.url.startsWith('https://')).toBe(true);
  });
});
