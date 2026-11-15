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

export function slotFit(m: ModelInfo, slot: ModelSlot): SlotFit {
  const embedOnly = has(m, 'embedding') && !has(m, 'completion');
  switch (slot) {
    case 'embed':
      if (!has(m, 'embedding')) return { fit: 'bad', why: 'Not an embedding model.' };
      if (m.embeddingLength && m.embeddingLength !== ATLAS_EMBED_DIM) {
        return { fit: 'ok', why: `${m.embeddingLength}-dim vectors. Chat memory handles that, but Project Brain is built for ${ATLAS_EMBED_DIM}-dim and would need re-embedding.` };
      }
      return { fit: 'good', why: m.embeddingLength ? `${m.embeddingLength}-dim embeddings.` : 'Embedding model.' };
    case 'vision':
      if (embedOnly) return { fit: 'bad', why: 'Embedding model, cannot chat.' };
      return has(m, 'vision') ? { fit: 'good', why: 'Reads images.' } : { fit: 'bad', why: 'Cannot read images.' };
    case 'reasoning':
      if (embedOnly) return { fit: 'bad', why: 'Embedding model, cannot chat.' };
      return has(m, 'thinking')
        ? { fit: 'good', why: 'Has a thinking mode.' }
        : { fit: 'ok', why: 'No separate thinking mode; it will answer directly.' };
    case 'chat':
    case 'summary':
      if (embedOnly) return { fit: 'bad', why: 'Embedding model, cannot chat.' };
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
  completion: 'chat', vision: 'vision', tools: 'tools', thinking: 'thinking', embedding: 'embedding'
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

export interface ResolvedParams {
  think?: Exclude<ThinkLevel, false>;
  options: Record<string, number>;
  /** Whether to offer the history-search tools to this model. */
  tools: boolean;
}

/**
 * What to actually send for a model: thinking only when the model has a thinking
 * mode (others reject the request), num_ctx only for local models, and the
 * history tools only for models that support tool calling. When the model is
 * unknown (not installed, daemon unreachable) the global setting is passed through.
 */
export function resolveParams(model: string, info: ModelInfo | undefined, globalThink: ThinkLevel | undefined, params: Record<string, ModelParams> | undefined): ResolvedParams {
  const p = params?.[model] ?? {};
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

/** Rough character budget for the conversation sent to a model. */
export function contextBudgetChars(model: string, info: ModelInfo | undefined, params: Record<string, ModelParams> | undefined): number {
  const set = params?.[model]?.num_ctx;
  // Local models run at Ollama's default window unless num_ctx is set; assume a modest one.
  const tokens = info?.cloud ? (info.contextLength ?? 32000) : (set ?? 8192);
  // ~3 chars per token, and leave 40% for the system prompt, recall, and the reply.
  return Math.max(8000, Math.min(240_000, Math.floor(tokens * 3 * 0.6)));
}
