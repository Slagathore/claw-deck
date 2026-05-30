import { describe, it, expect } from 'vitest';
import { parseFlags, pickModel, chooseBackend } from '../src/lib/headless';

describe('headless.parseFlags', () => {
  it('handles flags with values and bare flags', () => {
    const { flags, positional } = parseFlags(['--task', 'hi', 'extra', '--json']);
    expect(flags.task).toBe('hi');
    expect(flags.json).toBe(true);
    expect(positional).toEqual(['extra']);
  });
  it('treats trailing --flag with no value as boolean', () => {
    const { flags } = parseFlags(['--task', 'hi', '--verbose']);
    expect(flags.verbose).toBe(true);
  });
  it('does not consume the next token if it is also a flag', () => {
    const { flags } = parseFlags(['--task', '--model', 'llama3']);
    expect(flags.task).toBe(true);
    expect(flags.model).toBe('llama3');
  });
});

describe('headless.pickModel', () => {
  it('honors explicit override', () => {
    expect(pickModel({ chatModel: 'a', visionModel: 'b' }, 'chat', 'override')).toBe('override');
  });
  it('falls back to chat or vision model from settings', () => {
    expect(pickModel({ chatModel: 'llama3' }, 'chat')).toBe('llama3');
    expect(pickModel({ visionModel: 'gemma-vision' }, 'vision')).toBe('gemma-vision');
  });
  it('returns undefined when nothing configured', () => {
    expect(pickModel({}, 'chat')).toBeUndefined();
  });
});

describe('headless.chooseBackend', () => {
  it('respects explicit --backend', () => {
    expect(chooseBackend({ backend: 'vision' })).toBe('vision');
    expect(chooseBackend({ backend: 'chat' })).toBe('chat');
  });
  it('uses vision when --image is provided', () => {
    expect(chooseBackend({ image: './p.png' })).toBe('vision');
  });
  it('defaults to chat', () => {
    expect(chooseBackend({})).toBe('chat');
  });
});
