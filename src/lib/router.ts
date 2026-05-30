/**
 * Rule-based model router. Given the current settings + the in-flight request,
 * pick which backend ("chat" | "vision" | "reasoning") and which model to use.
 *
 * Kept tiny + deterministic so the user can predict it. Rules, in order:
 *   1. Any image attached  -> vision
 *   2. Explicit "/vision"   -> vision   (slash command stripped from prompt)
 *   3. Explicit "/reason"   -> reasoning
 *   4. Prompt asks for chain-of-thought / proof / analysis -> reasoning
 *   5. Otherwise            -> chat
 */
export type RoutedBackend = 'chat' | 'vision' | 'reasoning';

export interface RouteInput {
  prompt: string;
  imageCount: number;
  settings: {
    chatModel: string;
    reasoningModel: string;
    visionModel: string;
  };
}

export interface RouteResult {
  backend: RoutedBackend;
  model: string;
  cleanedPrompt: string;
  reason: string;
}

const REASONING_HINTS = /\b(prove|derive|reason\b|chain[- ]of[- ]thought|step[- ]by[- ]step|why does|explain why|analy[sz]e)\b/i;

export function routeRequest(req: RouteInput): RouteResult {
  const s = req.settings;
  let p = req.prompt ?? '';

  // slash commands take precedence over other rules
  const slashMatch = p.match(/^\s*\/(vision|reason|chat)\b\s*/i);
  let forced: RoutedBackend | null = null;
  if (slashMatch) {
    const tag = slashMatch[1].toLowerCase();
    forced = tag === 'vision' ? 'vision' : tag === 'reason' ? 'reasoning' : 'chat';
    p = p.slice(slashMatch[0].length);
  }

  if (forced === 'vision' || (forced === null && req.imageCount > 0)) {
    return { backend: 'vision', model: s.visionModel, cleanedPrompt: p, reason: forced === 'vision' ? 'forced /vision' : `${req.imageCount} image(s) attached` };
  }
  if (forced === 'reasoning') {
    return { backend: 'reasoning', model: s.reasoningModel, cleanedPrompt: p, reason: 'forced /reason' };
  }
  if (forced === 'chat') {
    return { backend: 'chat', model: s.chatModel, cleanedPrompt: p, reason: 'forced /chat' };
  }
  if (REASONING_HINTS.test(p)) {
    return { backend: 'reasoning', model: s.reasoningModel, cleanedPrompt: p, reason: 'reasoning keywords detected' };
  }
  return { backend: 'chat', model: s.chatModel, cleanedPrompt: p, reason: 'default chat' };
}
