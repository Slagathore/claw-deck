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
  // Prefer not to open on an assistant turn (a reply with no question in front of it reads as
  // noise), but never at the price of sending the newest message with nothing before it.
  let from = start;
  while (from < msgs.length - 1 && msgs[from].role === 'assistant') from++;
  if (from < msgs.length - 1) start = from;
  return { kept: msgs.slice(start), dropped: start };
}
