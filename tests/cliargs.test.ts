import { describe, it, expect } from 'vitest';
import { parseArgs } from '../src/lib/cliargs';

describe('cliargs.parseArgs', () => {
  it('splits on whitespace', () => {
    expect(parseArgs('--task plan --model llama3')).toEqual(['--task', 'plan', '--model', 'llama3']);
  });
  it('preserves double-quoted args', () => {
    expect(parseArgs('--msg "hello world" --n 2')).toEqual(['--msg', 'hello world', '--n', '2']);
  });
  it('preserves single-quoted args', () => {
    expect(parseArgs("--msg 'one two' end")).toEqual(['--msg', 'one two', 'end']);
  });
  it('returns empty array for empty input', () => {
    expect(parseArgs('')).toEqual([]);
    expect(parseArgs('   ')).toEqual([]);
  });
  it('collapses multiple spaces', () => {
    expect(parseArgs('a   b\tc')).toEqual(['a', 'b', 'c']);
  });
});
