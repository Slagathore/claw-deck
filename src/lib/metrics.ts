/**
 * Streaming metrics: time-to-first-token, tokens, tokens/sec.
 * "Token" here is a coarse approximation: we treat each whitespace-separated
 * run as ~1 token. That is fine for a live rate meter — it is not billing.
 */
export interface MetricsSnapshot {
  startedAt: number;
  firstTokenAt?: number;
  endedAt?: number;
  tokens: number;
}

export function newMetrics(): MetricsSnapshot {
  return { startedAt: Date.now(), tokens: 0 };
}

export function recordDelta(m: MetricsSnapshot, delta: string): MetricsSnapshot {
  if (!delta) return m;
  const tokens = m.tokens + countTokens(delta);
  const firstTokenAt = m.firstTokenAt ?? Date.now();
  return { ...m, firstTokenAt, tokens };
}

export function finalize(m: MetricsSnapshot): MetricsSnapshot {
  return { ...m, endedAt: Date.now() };
}

export function countTokens(s: string): number {
  if (!s) return 0;
  const trimmed = s.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export interface MetricsView {
  ttftMs?: number;
  elapsedMs: number;
  tokens: number;
  tokensPerSec: number;
}

export function view(m: MetricsSnapshot, now: number = Date.now()): MetricsView {
  const end = m.endedAt ?? now;
  const elapsedMs = Math.max(0, end - m.startedAt);
  const genStart = m.firstTokenAt ?? m.startedAt;
  const genMs = Math.max(1, end - genStart);
  const tokensPerSec = m.tokens > 0 ? (m.tokens / genMs) * 1000 : 0;
  return {
    ttftMs: m.firstTokenAt ? m.firstTokenAt - m.startedAt : undefined,
    elapsedMs,
    tokens: m.tokens,
    tokensPerSec
  };
}

export function formatView(v: MetricsView): string {
  const parts = [`${v.tokens} tok`, `${v.tokensPerSec.toFixed(1)} tok/s`];
  if (v.ttftMs !== undefined) parts.push(`TTFT ${v.ttftMs}ms`);
  parts.push(`${(v.elapsedMs / 1000).toFixed(2)}s`);
  return parts.join(' · ');
}
