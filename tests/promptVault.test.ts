import { describe, it, expect } from 'vitest';
import { extractVariables, applyVariables } from '../src/lib/promptVault';

describe('promptVault.extractVariables', () => {
  it('returns empty for empty / no-vars input', () => {
    expect(extractVariables('')).toEqual([]);
    expect(extractVariables('plain text')).toEqual([]);
  });
  it('extracts unique names in source order', () => {
    expect(extractVariables('hello {{name}}, {{greeting}} {{name}}')).toEqual(['name', 'greeting']);
  });
  it('tolerates whitespace inside braces', () => {
    expect(extractVariables('{{  topic  }} and {{name}}')).toEqual(['topic', 'name']);
  });
});

describe('promptVault.applyVariables', () => {
  it('substitutes known variables', () => {
    expect(applyVariables('Hi {{name}}', { name: 'Cole' })).toBe('Hi Cole');
  });
  it('leaves unknown variables intact for visibility', () => {
    expect(applyVariables('{{missing}} here', {})).toBe('{{missing}} here');
  });
  it('handles repeated and whitespace variants', () => {
    expect(applyVariables('{{x}} {{ x }} {{x}}', { x: '1' })).toBe('1 1 1');
  });
  it('treats empty value as empty string', () => {
    expect(applyVariables('A{{x}}B', { x: '' })).toBe('AB');
  });
});
