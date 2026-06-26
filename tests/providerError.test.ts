import { describe, it, expect } from 'vitest';
import { looksLikeProviderError, providerErrorKind } from '../electron/council/providerError';

describe('looksLikeProviderError — positives (must be quarantined)', () => {
  const errors = [
    'Claude usage limit reached. Your limit will reset at 3pm.',
    "You've reached your usage limit. Resets at 9:00 AM.",
    'Your credit balance is too low to complete this request. Please upgrade to a paid plan.',
    '{"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
    '{"type":"overloaded_error"}',
    'Error: 429 Too Many Requests',
    '503 Service Unavailable',
    'Please run claude login to authenticate.',
    'authentication_error: invalid x-api-key',
    'You are out of tokens.',
    'This request would exceed your organization rate limit.',
  ];
  for (const e of errors) it(`flags: ${e.slice(0, 48)}…`, () => expect(looksLikeProviderError(e)).toBe(true));
});

describe('looksLikeProviderError — negatives (legit answers must pass through)', () => {
  const ok = [
    '',
    null,
    'Here is the implementation:\n```ts\nfunction f(){ return 1; }\n```',
    // long technical answer that mentions rate limiting as a FEATURE — must not be flagged
    'Implement a rate limiter using a token-bucket algorithm. ' + 'x'.repeat(700) + ' The limiter caps requests per second.',
    // short game-design replies that happen to use error-adjacent words
    'The arcade timer resets at 0 when the player dies and grants a quota of 5 lives.',
    'SCORE: 8 — solid against the contract.',
    'NO_BLOCKING_ISSUES',
  ];
  for (const t of ok) it(`passes: ${String(t).slice(0, 48)}…`, () => expect(looksLikeProviderError(t as any)).toBe(false));
});

describe('providerErrorKind', () => {
  it('classifies the common buckets', () => {
    expect(providerErrorKind('usage limit reached, resets at 3pm')).toBe('usage-limit');
    expect(providerErrorKind('credit balance is too low')).toBe('quota/billing');
    expect(providerErrorKind('please run claude login')).toBe('auth');
    expect(providerErrorKind('429 too many requests')).toBe('overloaded');
  });
});
