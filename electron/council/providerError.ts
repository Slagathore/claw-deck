// Provider-error quarantine. A transport can return a usage-limit / auth / overload
// message as NORMAL output (exit 0, 200 OK) instead of throwing — e.g. the Claude CLI
// printing "usage limit reached" or an API returning a rate_limit_error body. If that
// text is treated as a model's answer it poisons the pipeline: it gets consolidated
// into the artifact, a critic "finds issues" in it, the judge scores it, the builder
// tries to implement it — moss-hollow literally tried to fix the out-of-tokens message
// in-game. This detector lets every call site DROP such a reply (treat it as a failed
// call), never as content.
//
// Pure + dependency-free → unit-testable. Bias: catch errors (a false positive only
// degrades one step to a retry/skip; a false negative leaks an error into the build).

// Unambiguous provider-exhaustion / auth / overload signatures — match anywhere.
const STRONG: RegExp[] = [
  /usage limit reached/i,
  /reached your usage limit/i,
  /approaching your usage limit/i,
  /credit balance is too low/i,
  /rate[_ ]limit[_ ]error/i,
  /overloaded[_ ]?error/i,
  /"type"\s*:\s*"overloaded"/i,
  /insufficient[_ ]?(quota|credits|funds|balance)/i,
  /exceeded your (?:current )?(?:quota|organization|monthly)/i,
  /authentication[_ ]?error/i,
  /invalid (?:x-api-key|api key|bearer token)/i,
  /\bANTHROPIC_API_KEY\b/,
  /run (?:`?claude login`?|`?\/login`?)/i,
  /please (?:sign in|log ?in|authenticate)/i,
  /\b5-hour limit\b/i,
  /reset(?:s|ting)? at \d{1,2}(?::\d{2})?\s*(?:am|pm)/i,   // "resets at 3pm" — not "timer resets at 0"
  /upgrade to (?:a paid plan|claude (?:pro|max))/i,
  /you've hit your (?:usage )?limit/i,
];

// Weaker hints — only trust them in a SHORT reply (a real answer rarely is one).
const WEAK: RegExp[] = [
  /\b(?:rate|usage) limit\b/i,
  /\bout of (?:tokens|credits)\b/i,
  /too many requests/i,
  /\b429\b/,
  /\b50[239]\b/,
  /service unavailable/i,
  /temporarily unavailable/i,
];

/** Does this transport reply look like a provider error rather than a real answer? */
export function looksLikeProviderError(text: string | null | undefined): boolean {
  if (!text) return false;
  const t = text.slice(0, 4000);
  if (STRONG.some((r) => r.test(t))) return true;
  // a genuinely short reply that mentions a quota/limit/5xx is almost certainly an error,
  // not a model answer (which would be substantive).
  if (t.trim().length < 600 && WEAK.some((r) => r.test(t))) return true;
  return false;
}

/** Short label for logs/warnings. */
export function providerErrorKind(text: string): string {
  if (/usage limit|5-hour|resets? at|hit your/i.test(text)) return 'usage-limit';
  if (/credit balance|insufficient|quota|billing/i.test(text)) return 'quota/billing';
  if (/auth|api key|login|sign in/i.test(text)) return 'auth';
  if (/overload|too many requests|429|503|502|unavailable/i.test(text)) return 'overloaded';
  return 'provider-error';
}
