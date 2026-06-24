import { describe, it, expect } from 'vitest';
import { isQuotaError, nextActor } from '../electron/executor/fallback';

describe('isQuotaError', () => {
  it('flags HTTP 401/403/429', () => {
    expect(isQuotaError(1, 'request failed: HTTP 429 Too Many Requests')).toBe(true);
    expect(isQuotaError(1, 'status 403 forbidden')).toBe(true);
    expect(isQuotaError(1, 'got a 401 from the provider')).toBe(true);
  });
  it('flags credit/quota/rate-limit phrasing', () => {
    expect(isQuotaError(1, 'Error: you are out of credits')).toBe(true);
    expect(isQuotaError(1, 'rate limit exceeded, retry later')).toBe(true);
    expect(isQuotaError(1, 'insufficient quota for this model')).toBe(true);
    expect(isQuotaError(1, 'model is overloaded')).toBe(true);
  });
  it('does not flag ordinary failures', () => {
    expect(isQuotaError(0, 'all good')).toBe(false);
    expect(isQuotaError(1, 'TypeError: undefined is not a function')).toBe(false);
    expect(isQuotaError(2, 'compile error on line 4031')).toBe(false); // contains 403 substring guard
  });
});

describe('nextActor', () => {
  it('advances down the chain then returns null', () => {
    expect(nextActor(['a', 'b', 'c'], 0)).toBe('b');
    expect(nextActor(['a', 'b', 'c'], 1)).toBe('c');
    expect(nextActor(['a', 'b', 'c'], 2)).toBeNull();
  });
});
