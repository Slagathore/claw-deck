import { describe, it, expect } from 'vitest';
import { formatBytes, totalVram, summarizeRunning } from '../src/lib/vram';

describe('vram.formatBytes', () => {
  it('handles 0 and undefined', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(undefined)).toBe('0 B');
  });
  it('scales through units', () => {
    expect(formatBytes(1024)).toMatch(/KB$/);
    expect(formatBytes(1024 * 1024)).toMatch(/MB$/);
    expect(formatBytes(7 * 1024 * 1024 * 1024)).toMatch(/GB$/);
  });
});

describe('vram aggregates', () => {
  it('totalVram sums sizeVram, ignoring undefined', () => {
    expect(totalVram([{ name: 'a', sizeVram: 1000 }, { name: 'b' }, { name: 'c', sizeVram: 2000 }])).toBe(3000);
  });
  it('summarizeRunning empty', () => {
    expect(summarizeRunning([])).toMatch(/no models/);
  });
  it('summarizeRunning lists names + total', () => {
    const s = summarizeRunning([{ name: 'llama3', sizeVram: 8 * 1024 ** 3 }, { name: 'qwen', sizeVram: 4 * 1024 ** 3 }]);
    expect(s).toMatch(/2 loaded/);
    expect(s).toMatch(/llama3/);
    expect(s).toMatch(/qwen/);
    expect(s).toMatch(/GB/);
  });
});
