/**
 * Parse <think>...</think> blocks (DeepSeek-R1 / QwQ style) out of a response.
 * Also handles Anthropic-style standalone "thinking" already split server-side.
 */
export function splitThinking(text: string): { thinking: string; visible: string } {
  if (!text) return { thinking: '', visible: '' };
  const parts: string[] = [];
  let visible = text;
  const re = /<think>([\s\S]*?)<\/think>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) parts.push(m[1].trim());
  visible = text.replace(re, '').trim();
  return { thinking: parts.join('\n\n').trim(), visible };
}
