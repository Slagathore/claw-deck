import { describe, it, expect } from 'vitest';
import { parseYaraStdout, yaraScan } from '../electron/ipc/yara';

describe('yara.parseYaraStdout', () => {
  it('returns empty for empty/whitespace input', () => {
    expect(parseYaraStdout('', '/tmp/x.bin')).toEqual([]);
    expect(parseYaraStdout('   \n  \n', '/tmp/x.bin')).toEqual([]);
  });
  it('parses a single match line', () => {
    expect(parseYaraStdout('Evil_PE /tmp/x.bin\n', '/tmp/x.bin')).toEqual(['Evil_PE']);
  });
  it('parses multiple match lines and dedupes', () => {
    const out = 'A /f\nB /f\nA /f\n';
    expect(parseYaraStdout(out, '/f').sort()).toEqual(['A', 'B']);
  });
  it('ignores malformed lines (no whitespace)', () => {
    expect(parseYaraStdout('justOneToken\nGood /f\n', '/f')).toEqual(['Good']);
  });
});

describe('yara.yaraScan soft-fail behavior', () => {
  it('soft-skips when no rules path is configured', async () => {
    const r = await yaraScan('/nonexistent', {});
    expect(r.ok).toBe(true);
    expect(r.engine).toBe('yara');
    expect(r.detail).toMatch(/skipped/);
    // Soft-skip must never look like a clean scan: ok=true but available=false,
    // so the UI can tell "unscanned" apart from "scanned, found nothing".
    expect(r.available).toBe(false);
  });
  it('soft-skips when the rules file does not exist', async () => {
    const r = await yaraScan('/nonexistent', { rulesPath: '/definitely/not/here.yar' });
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/skipped/);
    expect(r.available).toBe(false);
  });
});
