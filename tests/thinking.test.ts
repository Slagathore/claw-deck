import { describe, it, expect } from 'vitest';
import { splitThinking } from '../src/lib/thinking';

describe('splitThinking', () => {
  it('returns empty for empty input', () => {
    expect(splitThinking('')).toEqual({ thinking: '', visible: '' });
  });
  it('passes through text with no think tags', () => {
    expect(splitThinking('hello')).toEqual({ thinking: '', visible: 'hello' });
  });
  it('extracts single think block', () => {
    const r = splitThinking('<think>plan: do x</think>final answer');
    expect(r.thinking).toBe('plan: do x');
    expect(r.visible).toBe('final answer');
  });
  it('extracts multiple think blocks', () => {
    const r = splitThinking('<think>a</think>mid<think>b</think>end');
    expect(r.thinking).toBe('a\n\nb');
    expect(r.visible).toBe('midend');
  });
  it('is case insensitive', () => {
    const r = splitThinking('<THINK>x</THINK>y');
    expect(r.thinking).toBe('x');
    expect(r.visible).toBe('y');
  });
});
