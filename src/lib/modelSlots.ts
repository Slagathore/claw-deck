/**
 * Which installed model suits which settings slot, and what each model needs.
 * Pure helpers shared by the Settings pickers and the chat send path.
 */
import type { ModelInfo, ModelCapability } from '../../electron/lib/modelCaps';

export type { ModelInfo, ModelCapability };

export type ModelSlot = 'chat' | 'reasoning' | 'vision' | 'embed' | 'summary';
export type ThinkLevel = boolean | 'low' | 'medium' | 'high';

/** Per-model overrides the user can set from the Settings pickers. */
export interface ModelParams {
  /** undefined = follow the global Thinking setting. */
  think?: ThinkLevel;
  /** Context window in tokens (local models only). */
  num_ctx?: number;
  temperature?: number;
}

export interface SlotFit {
  fit: 'good' | 'ok' | 'bad';
  why: string;
}

/** Atlas stores 768-dim vectors; a different size would need its index rebuilt. */
export const ATLAS_EMBED_DIM = 768;

const has = (m: ModelInfo, c: ModelCapability) => m.capabilities.includes(c);

/** Why a model with no text completion cannot fill a chat-type slot. */
function whyNoChat(m: ModelInfo): string {
  if (has(m, 'embedding')) return 'Embedding model, cannot chat.';
  if (has(m, 'image')) return 'Image generation model, cannot chat.';
  return 'Does not do text chat.';
}

export function slotFit(m: ModelInfo, slot: ModelSlot): SlotFit {
  const noChat = !has(m, 'completion');
  switch (slot) {
    case 'embed':
      if (!has(m, 'embedding')) return { fit: 'bad', why: 'Not an embedding model.' };
      if (m.embeddingLength && m.embeddingLength !== ATLAS_EMBED_DIM) {
        return { fit: 'ok', why: `${m.embeddingLength}-dim vectors. Chat memory handles that, but Project Brain is built for ${ATLAS_EMBED_DIM}-dim and would need re-embedding.` };
      }
      return { fit: 'good', why: m.embeddingLength ? `${m.embeddingLength}-dim embeddings.` : 'Embedding model.' };
    case 'vision':
      if (noChat) return { fit: 'bad', why: whyNoChat(m) };
      return has(m, 'vision') ? { fit: 'good', why: 'Reads images.' } : { fit: 'bad', why: 'Cannot read images.' };
    case 'reasoning':
      if (noChat) return { fit: 'bad', why: whyNoChat(m) };
      return has(m, 'thinking')
        ? { fit: 'good', why: 'Has a thinking mode.' }
        : { fit: 'ok', why: 'No separate thinking mode; it will answer directly.' };
    case 'chat':
    case 'summary':
      if (noChat) return { fit: 'bad', why: whyNoChat(m) };
      return { fit: 'good', why: has(m, 'tools') ? 'Chat model with tool calling (can search history on demand).' : 'Chat model.' };
  }
}

const RANK = { good: 0, ok: 1, bad: 2 } as const;

/** Models for a slot: best fit first, then local before cloud, then by name. */
export function sortForSlot(models: ModelInfo[], slot: ModelSlot): ModelInfo[] {
  return [...models].sort((a, b) =>
    RANK[slotFit(a, slot).fit] - RANK[slotFit(b, slot).fit]
    || Number(a.cloud) - Number(b.cloud)
    || a.name.localeCompare(b.name));
}

export function formatBytes(n?: number): string {
  if (!n) return '';
  const gb = n / 1e9;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`;
}

export function formatContext(n?: number): string {
  if (!n) return '';
  return n >= 1000 ? `${Math.round(n / 1024)}k ctx` : `${n} ctx`;
}

const CAP_LABEL: Record<ModelCapability, string> = {
  completion: 'chat', vision: 'vision', tools: 'tools', thinking: 'thinking', embedding: 'embedding', image: 'image generation'
};

/** Capability words worth showing (plain "chat" is implied unless it is all the model does). */
export function capLabels(m: ModelInfo): string[] {
  const extra = m.capabilities.filter(c => c !== 'completion').map(c => CAP_LABEL[c]);
  return extra.length ? extra : m.capabilities.map(c => CAP_LABEL[c]);
}

/** One-line description for a dropdown option. */
export function describeModel(m: ModelInfo): string {
  const bits = [
    [m.paramSize, m.quant].filter(Boolean).join(' '),
    m.cloud ? 'cloud' : formatBytes(m.sizeBytes),
    formatContext(m.contextLength),
    capLabels(m).join(', ')
  ].filter(Boolean);
  return bits.join(' · ');
}

export function findModel(models: ModelInfo[], name?: string | null): ModelInfo | undefined {
  if (!name) return undefined;
  return models.find(m => m.name === name)
    // Ollama treats a bare name as ":latest".
    ?? models.find(m => m.name === `${name}:latest` || `${m.name}:latest` === name);
}

/** Per-model options, found whether the setting says "llama3.2" or "llama3.2:latest". */
export function paramsFor(model: string, info: ModelInfo | undefined, params: Record<string, ModelParams> | undefined): ModelParams {
  if (!params) return {};
  return params[model]
    ?? (info ? params[info.name] : undefined)
    ?? params[`${model}:latest`]
    ?? (model.endsWith(':latest') ? params[model.slice(0, -':latest'.length)] : undefined)
    ?? {};
}

export interface ResolvedParams {
  think?: Exclude<ThinkLevel, false>;
  options: Record<string, number>;
  /** Whether this model supports tool calling (needed for the history-search tools). */
  tools: boolean;
}

/**
 * What to actually send for a model: thinking only when the model has a thinking
 * mode (others reject the request), num_ctx only for local models, and the
 * history tools only for models that support tool calling. When the model is
 * unknown (not installed, daemon unreachable) the global setting is passed through.
 */
export function resolveParams(model: string, info: ModelInfo | undefined, globalThink: ThinkLevel | undefined, params: Record<string, ModelParams> | undefined): ResolvedParams {
  const p = paramsFor(model, info, params);
  const wanted = p.think !== undefined ? p.think : globalThink;
  const canThink = info ? has(info, 'thinking') : true;
  const options: Record<string, number> = {};
  if (p.num_ctx && !(info?.cloud)) {
    options.num_ctx = info?.contextLength ? Math.min(p.num_ctx, info.contextLength) : p.num_ctx;
  }
  if (typeof p.temperature === 'number' && Number.isFinite(p.temperature)) options.temperature = p.temperature;
  return {
    think: wanted && canThink ? wanted : undefined,
    options,
    tools: !!info && has(info, 'tools')
  };
}

/**
 * Upper bound, in characters, on the conversation re-sent to a model each turn.
 *
 * It is sized to the most the model could ever take (its own maximum window, or
 * the window the user set for it here), not to Ollama's default window: a window
 * raised outside this app (OLLAMA_CONTEXT_LENGTH, a Modelfile) must keep working,
 * and when the real window is smaller Ollama trims the oldest turns itself, as it
 * always has. The bound exists so a thread that has grown for months is not sent
 * whole on every message.
 */
export function contextBudgetChars(model: string, info: ModelInfo | undefined, params: Record<string, ModelParams> | undefined): number {
  const set = info?.cloud ? undefined : paramsFor(model, info, params).num_ctx;
  const tokens = set || info?.contextLength || 131072;
  // ~3 chars per token, leaving a fifth for the system prompt, recalled history, and the reply.
  return Math.max(24_000, Math.min(3_000_000, Math.floor(tokens * 3 * 0.8)));
}

// ---- where a model runs, and whether saved history may be shared with it ----

/** How much of the saved history a model may be given. */
export type RecallPolicy = 'off' | 'local' | 'all';

const CLOUD_TAG = /(:|-)cloud$/i;

export function isLocalUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
  } catch { return false; }
}

/** True when a request to this model stays on this machine: a local endpoint and not a cloud-served model. */
export function runsLocally(model: string, info: ModelInfo | undefined, baseUrl?: string | null): boolean {
  if (!isLocalUrl(baseUrl)) return false;
  return !(info ? info.cloud : CLOUD_TAG.test(model));
}

/** Whether excerpts of other saved conversations may be put in front of a model. */
export function mayShareHistory(policy: RecallPolicy | undefined, local: boolean): boolean {
  const p = policy ?? 'local';
  return p === 'all' || (p === 'local' && local);
}
