import { describe, it, expect } from 'vitest';
import { guessCapabilities, isCloudModel, normalizeModel } from '../electron/lib/modelCaps';
import {
  capLabels, contextBudgetChars, describeModel, findModel, resolveParams, slotFit, sortForSlot, type ModelInfo
} from '../src/lib/modelSlots';
import { fitContext } from '../src/lib/chatContext';

// Shapes copied from a real Ollama 0.40 /api/tags and /api/show.
const TAG_QWEN = { name: 'qwen3.5:4b', size: 3397841620, digest: 'd1', details: { family: 'qwen35', parameter_size: '4.7B', quantization_level: 'Q4_K_M', context_length: 262144, embedding_length: 2560 }, capabilities: ['completion', 'vision', 'tools', 'thinking'] };
const TAG_GEMMA = { name: 'gemma3:12b', size: 8159981216, details: { family: 'gemma3', parameter_size: '12.2B', quantization_level: 'Q4_K_M', context_length: 131072 }, capabilities: ['completion', 'vision'] };
const SHOW_NOMIC = { capabilities: ['embedding'], details: { family: 'nomic-bert', parameter_size: '137M', quantization_level: 'F16' }, model_info: { 'nomic-bert.context_length': 2048, 'nomic-bert.embedding_length': 768 } };
const SHOW_KIMI = { capabilities: ['vision', 'thinking', 'completion', 'tools'], details: { family: 'kimi-k2', parameter_size: '1042000000000', quantization_level: 'INT4' }, model_info: { 'kimi-k2.context_length': 262144 } };

const qwen = normalizeModel(TAG_QWEN);
const gemma = normalizeModel(TAG_GEMMA);
const nomic = normalizeModel({ name: 'nomic-embed-text:latest', size: 274302450 }, SHOW_NOMIC);
const kimi = normalizeModel({ name: 'kimi-k2.7-code:cloud' }, SHOW_KIMI);
const all: ModelInfo[] = [gemma, nomic, kimi, qwen];

describe('normalizeModel', () => {
  it('reads capabilities and sizes straight from /api/tags', () => {
    expect(qwen).toMatchObject({ name: 'qwen3.5:4b', paramSize: '4.7B', quant: 'Q4_K_M', contextLength: 262144, capsSource: 'ollama', cloud: false });
    expect(qwen.capabilities).toEqual(['completion', 'vision', 'tools', 'thinking']);
  });

  it('falls back to /api/show when tags carry no capabilities', () => {
    expect(nomic).toMatchObject({ capabilities: ['embedding'], embeddingLength: 768, contextLength: 2048, capsSource: 'ollama' });
    expect(kimi).toMatchObject({ cloud: true, paramSize: '1.0T', contextLength: 262144 });
  });

  it('guesses from the name when the daemon reports nothing, and says so', () => {
    const m = normalizeModel({ name: 'llava:13b' });
    expect(m.capsSource).toBe('guess');
    expect(m.capabilities).toContain('vision');
    expect(guessCapabilities('mxbai-embed-large')).toEqual(['embedding']);
    expect(guessCapabilities('deepseek-r1:7b')).toContain('thinking');
    expect(guessCapabilities('phi3')).toEqual(['completion']);
  });

  it('spots cloud tags', () => {
    expect(isCloudModel('qwen3.5:397b-cloud')).toBe(true);
    expect(isCloudModel('kimi-k2.7-code:cloud')).toBe(true);
    expect(isCloudModel('cloudy-model:7b')).toBe(false);
  });
});

describe('slot fitting', () => {
  it('vision slot only suits models that read images', () => {
    expect(slotFit(gemma, 'vision').fit).toBe('good');
    expect(slotFit(nomic, 'vision').fit).toBe('bad');
    expect(slotFit(normalizeModel({ name: 'phi3', capabilities: ['completion'] }), 'vision').fit).toBe('bad');
  });

  it('embedding slot only suits embedding models and flags non-768 sizes', () => {
    expect(slotFit(nomic, 'embed').fit).toBe('good');
    expect(slotFit(qwen, 'embed').fit).toBe('bad');
    const big = normalizeModel({ name: 'mxbai-embed-large', capabilities: ['embedding'], details: { embedding_length: 1024 } });
    expect(slotFit(big, 'embed')).toMatchObject({ fit: 'ok' });
    expect(slotFit(big, 'embed').why).toContain('1024');
  });

  it('reasoning slot prefers thinking models; chat rejects embedding models', () => {
    expect(slotFit(qwen, 'reasoning').fit).toBe('good');
    expect(slotFit(gemma, 'reasoning').fit).toBe('ok');
    expect(slotFit(nomic, 'chat').fit).toBe('bad');
    expect(slotFit(gemma, 'chat').fit).toBe('good');
  });

  it('sorts best fit first, local before cloud', () => {
    expect(sortForSlot(all, 'reasoning').map(m => m.name)).toEqual(['qwen3.5:4b', 'kimi-k2.7-code:cloud', 'gemma3:12b', 'nomic-embed-text:latest']);
    expect(sortForSlot(all, 'embed')[0].name).toBe('nomic-embed-text:latest');
  });

  it('describes a model in one line', () => {
    expect(describeModel(qwen)).toBe('4.7B Q4_K_M · 3.4 GB · 256k ctx · vision, tools, thinking');
    expect(describeModel(kimi)).toContain('cloud');
    expect(capLabels(nomic)).toEqual(['embedding']);
    expect(capLabels(normalizeModel({ name: 'phi3', capabilities: ['completion'] }))).toEqual(['chat']);
  });

  it('finds a model by bare name or :latest', () => {
    expect(findModel(all, 'nomic-embed-text')?.name).toBe('nomic-embed-text:latest');
    expect(findModel(all, 'qwen3.5:4b')).toBe(qwen);
    expect(findModel(all, 'missing')).toBeUndefined();
  });
});

describe('resolveParams', () => {
  it('only asks for thinking when the model has a thinking mode', () => {
    expect(resolveParams('qwen3.5:4b', qwen, 'high', {}).think).toBe('high');
    expect(resolveParams('gemma3:12b', gemma, 'high', {}).think).toBeUndefined();
    expect(resolveParams('unknown', undefined, true, {}).think).toBe(true); // unknown model: pass the setting through
  });

  it('per-model thinking overrides the global setting both ways', () => {
    expect(resolveParams('qwen3.5:4b', qwen, 'high', { 'qwen3.5:4b': { think: false } }).think).toBeUndefined();
    expect(resolveParams('qwen3.5:4b', qwen, false, { 'qwen3.5:4b': { think: 'low' } }).think).toBe('low');
  });

  it('sends num_ctx for local models only, capped at the model maximum', () => {
    expect(resolveParams('gemma3:12b', gemma, false, { 'gemma3:12b': { num_ctx: 32768, temperature: 0.2 } }).options).toEqual({ num_ctx: 32768, temperature: 0.2 });
    expect(resolveParams('gemma3:12b', gemma, false, { 'gemma3:12b': { num_ctx: 999999 } }).options.num_ctx).toBe(131072);
    expect(resolveParams('kimi-k2.7-code:cloud', kimi, false, { 'kimi-k2.7-code:cloud': { num_ctx: 8192 } }).options).toEqual({});
  });

  it('offers history tools only to tool-capable models', () => {
    expect(resolveParams('qwen3.5:4b', qwen, false, {}).tools).toBe(true);
    expect(resolveParams('gemma3:12b', gemma, false, {}).tools).toBe(false);
    expect(resolveParams('unknown', undefined, false, {}).tools).toBe(false);
  });
});

describe('context budget', () => {
  it('scales with the window that will really be used', () => {
    const small = contextBudgetChars('gemma3:12b', gemma, {});
    const big = contextBudgetChars('gemma3:12b', gemma, { 'gemma3:12b': { num_ctx: 65536 } });
    expect(big).toBeGreaterThan(small);
    expect(contextBudgetChars('kimi-k2.7-code:cloud', kimi, {})).toBe(240_000);
  });

  it('keeps the newest messages that fit and never drops the last one', () => {
    const msgs = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `${i}`.repeat(100) }));
    const { kept, dropped } = fitContext(msgs, 400);
    expect(kept[kept.length - 1]).toBe(msgs[9]);
    expect(dropped + kept.length).toBe(10);
    expect(kept.length).toBeLessThan(10);
    expect(kept[0].role).toBe('user');
    expect(fitContext([{ role: 'user', content: 'x'.repeat(5000) }], 100).kept).toHaveLength(1);
    expect(fitContext(msgs, 1e6)).toMatchObject({ dropped: 0 });
    expect(fitContext([], 100)).toEqual({ kept: [], dropped: 0 });
  });
});
