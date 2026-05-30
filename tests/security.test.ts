import { describe, it, expect } from 'vitest';
import { isHostAllowed } from '../electron/ipc/security';

describe('isHostAllowed', () => {
  const allow = ['github.com', 'releases.openclaw.org'];
  it('rejects non-https', () => {
    expect(isHostAllowed('http://github.com/x', allow)).toBe(false);
  });
  it('accepts exact host', () => {
    expect(isHostAllowed('https://github.com/x/y', allow)).toBe(true);
  });
  it('accepts subdomain', () => {
    expect(isHostAllowed('https://api.github.com/x', allow)).toBe(true);
  });
  it('rejects unrelated host', () => {
    expect(isHostAllowed('https://evil.example.com/x', allow)).toBe(false);
  });
  it('rejects malformed url', () => {
    expect(isHostAllowed('not a url', allow)).toBe(false);
  });
});
