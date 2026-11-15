// What each installed Ollama model can do. Current Ollama reports capabilities
// directly on /api/tags (and /api/show); older daemons do not, so there is a
// name-based guess as the last resort, flagged as such so the UI can say so.
// Pure: no Electron or Node imports, so it runs under vitest as is.

/** 'image' = an image generation model (it produces pictures; it cannot chat). */
export type ModelCapability = 'completion' | 'vision' | 'tools' | 'thinking' | 'embedding' | 'image';

export interface ModelInfo {
  name: string;
  sizeBytes?: number;
  family?: string;
  paramSize?: string;
  quant?: string;
  /** Largest context window the model supports, in tokens. */
  contextLength?: number;
  /** Output dimension, for embedding models. */
  embeddingLength?: number;
  capabilities: ModelCapability[];
  /** 'ollama' = reported by the daemon; 'guess' = inferred from the model name. */
  capsSource: 'ollama' | 'guess';
  /** Served by Ollama Cloud through the local daemon (no local VRAM, no num_ctx). */
  cloud: boolean;
}

const KNOWN: ModelCapability[] = ['completion', 'vision', 'tools', 'thinking', 'embedding', 'image'];

export const isCloudModel = (name: string): boolean => /(:|-)cloud$/i.test(name);

export function guessCapabilities(name: string): ModelCapability[] {
  const n = name.toLowerCase();
  if (/embed|bge-|minilm|e5-/.test(n)) return ['embedding'];
  if (/z-image|flux|stable-diffusion|sdxl/.test(n)) return ['image'];
  const caps: ModelCapability[] = ['completion'];
  if (/vision|llava|moondream|minicpm-v|bakllava|gemma3|qwen3\.5|kimi/.test(n)) caps.push('vision');
  if (/deepseek-r1|qwq|qwen3|gpt-oss|kimi|magistral|-thinking/.test(n)) caps.push('thinking');
  if (/llama3\.[123]|qwen|mistral|kimi|gpt-oss|command-r|firefunction|hermes/.test(n) && !/llama3\.2-vision/.test(n)) caps.push('tools');
  return caps;
}

function humanParams(raw: unknown): string | undefined {
  if (raw == null || raw === '') return undefined;
  const s = String(raw);
  if (!/^\d+$/.test(s)) return s.toUpperCase(); // already "12.2B" (some cloud tags report "1t")
  const n = Number(s);
  if (n >= 1e12) return `${(n / 1e12).toFixed(n >= 1e13 ? 0 : 1)}T`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${Math.round(n / 1e6)}M`;
  return s;
}

function lengthFrom(modelInfo: Record<string, any> | undefined, suffix: string): number | undefined {
  if (!modelInfo) return undefined;
  for (const [k, v] of Object.entries(modelInfo)) {
    if (k.endsWith(suffix) && typeof v === 'number') return v;
  }
  return undefined;
}

/** Normalize one /api/tags entry, optionally enriched by its /api/show response. */
export function normalizeModel(tag: any, show?: any): ModelInfo {
  const name = String(tag?.name ?? tag?.model ?? '');
  const details = { ...(show?.details ?? {}), ...(tag?.details ?? {}) };
  const reported: unknown = tag?.capabilities ?? show?.capabilities;
  const fromDaemon = Array.isArray(reported) && reported.length > 0;
  const capabilities = fromDaemon
    ? (reported as string[]).filter((c): c is ModelCapability => (KNOWN as string[]).includes(c))
    : guessCapabilities(name);
  return {
    name,
    sizeBytes: typeof tag?.size === 'number' ? tag.size : undefined,
    family: details.family || undefined,
    paramSize: humanParams(details.parameter_size),
    quant: details.quantization_level || undefined,
    contextLength: details.context_length ?? lengthFrom(show?.model_info, '.context_length'),
    embeddingLength: details.embedding_length ?? lengthFrom(show?.model_info, '.embedding_length'),
    capabilities,
    capsSource: fromDaemon ? 'ollama' : 'guess',
    cloud: isCloudModel(name) || !!show?.remote_host || !!tag?.remote_host,
  };
}
