/**
 * Keep the tail of a conversation that fits a character budget. The full thread
 * stays saved and searchable; this only decides what is re-sent each turn.
 */
export interface CtxMsg { role: string; content: string }

export function fitContext<T extends CtxMsg>(msgs: T[], maxChars: number): { kept: T[]; dropped: number } {
  if (!msgs.length) return { kept: [], dropped: 0 };
  let used = 0;
  let start = msgs.length;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const len = (msgs[i].content?.length ?? 0) + 16;
    // Always keep the newest message, even if it alone is over budget.
    if (i < msgs.length - 1 && used + len > maxChars) break;
    used += len;
    start = i;
  }
  // Do not open on an assistant turn: a reply with no question in front of it reads as noise.
  while (start < msgs.length - 1 && msgs[start].role === 'assistant') start++;
  return { kept: msgs.slice(start), dropped: start };
}
