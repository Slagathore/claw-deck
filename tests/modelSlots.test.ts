import { describe, it, expect } from 'vitest';
import { guessCapabilities, isCloudModel, normalizeModel } from '../electron/lib/modelCaps';
import {
  capLabels, contextBudgetChars, describeModel, findModel, isLocalUrl, mayShareHistory, paramsFor, resolveParams, runsLocally, slotFit, sortForSlot, type ModelInfo
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

  it('image generation models are recognized and kept out of every chat slot', () => {
    const zimg = normalizeModel({ name: 'x/z-image-turbo:latest', capabilities: ['image'] }); // real /api/tags shape
    expect(zimg).toMatchObject({ capabilities: ['image'], capsSource: 'ollama' });
    for (const slot of ['chat', 'reasoning', 'vision', 'summary'] as const) {
      expect(slotFit(zimg, slot)).toEqual({ fit: 'bad', why: 'Image generation model, cannot chat.' });
    }
    expect(slotFit(zimg, 'embed').fit).toBe('bad');
    expect(capLabels(zimg)).toEqual(['image generation']);
    expect(guessCapabilities('z-image-turbo')).toEqual(['image']);
    // a daemon that reports only capabilities this app does not know yields none, which is not chat
    expect(slotFit(normalizeModel({ name: 'odd', capabilities: ['insert'] }), 'chat')).toEqual({ fit: 'bad', why: 'Does not do text chat.' });
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

describe('per-model options lookup', () => {
  it('finds options whether the setting says the bare name or :latest', () => {
    const latest = normalizeModel({ name: 'llama3.2:latest', capabilities: ['completion', 'tools'] });
    expect(paramsFor('llama3.2', latest, { 'llama3.2:latest': { num_ctx: 4096 } })).toEqual({ num_ctx: 4096 });
    expect(paramsFor('llama3.2:latest', latest, { 'llama3.2': { temperature: 0.1 } })).toEqual({ temperature: 0.1 });
    expect(paramsFor('llama3.2', undefined, { 'llama3.2:latest': { num_ctx: 2048 } })).toEqual({ num_ctx: 2048 });
    expect(paramsFor('other', latest, { 'llama3.2': { num_ctx: 1 } })).toEqual({ num_ctx: 1 }.num_ctx ? {} : {});
    expect(resolveParams('llama3.2', latest, false, { 'llama3.2:latest': { num_ctx: 4096 } }).options).toEqual({ num_ctx: 4096 });
  });
});

describe('who may be shown saved history', () => {
  it('knows a local endpoint from a remote one', () => {
    for (const u of ['http://localhost:11434', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434', 'http://0.0.0.0:11434']) expect(isLocalUrl(u)).toBe(true);
    for (const u of ['https://ollama.com', 'http://192.168.1.20:11434', 'http://localhost.evil.com:11434', '', undefined, 'not a url']) expect(isLocalUrl(u)).toBe(false);
  });

  it('a model runs locally only on a local endpoint and when it is not cloud served', () => {
    expect(runsLocally('gemma3:12b', gemma, 'http://localhost:11434')).toBe(true);
    expect(runsLocally('kimi-k2.7-code:cloud', kimi, 'http://localhost:11434')).toBe(false);   // forwarded to Ollama Cloud
    expect(runsLocally('gemma3:12b', gemma, 'https://ollama.example.com')).toBe(false);
    expect(runsLocally('qwen3.5:397b-cloud', undefined, 'http://localhost:11434')).toBe(false); // not listed, cloud by name
    expect(runsLocally('mystery', undefined, 'http://localhost:11434')).toBe(true);
  });

  it('the default keeps other chats away from cloud models', () => {
    expect(mayShareHistory(undefined, true)).toBe(true);
    expect(mayShareHistory(undefined, false)).toBe(false);
    expect(mayShareHistory('local', false)).toBe(false);
    expect(mayShareHistory('all', false)).toBe(true);
    expect(mayShareHistory('off', true)).toBe(false);
    expect(mayShareHistory('off', false)).toBe(false);
  });
});

describe('context budget', () => {
  it('is an upper bound sized to the most the model can take, not to an assumed default window', () => {
    // No window set here: the cap is the model's own maximum, so a window raised in Ollama
    // itself keeps working and a 20K-character paste stays in the conversation.
    const unset = contextBudgetChars('gemma3:12b', gemma, {});
    expect(unset).toBe(Math.floor(131072 * 3 * 0.8));
    expect(unset).toBeGreaterThan(300_000);
    // A window set in Settings is the real window, so the cap follows it.
    expect(contextBudgetChars('gemma3:12b', gemma, { 'gemma3:12b': { num_ctx: 8192 } })).toBe(24_000);
    expect(contextBudgetChars('gemma3:12b', gemma, { 'gemma3:12b': { num_ctx: 65536 } })).toBe(Math.floor(65536 * 3 * 0.8));
    // Cloud models ignore num_ctx; unknown models get a generous default; nothing exceeds the ceiling.
    expect(contextBudgetChars('kimi-k2.7-code:cloud', kimi, { 'kimi-k2.7-code:cloud': { num_ctx: 2048 } })).toBe(Math.floor(262144 * 3 * 0.8));
    expect(contextBudgetChars('mystery', undefined, {})).toBe(Math.floor(131072 * 3 * 0.8));
    expect(contextBudgetChars('huge', { ...gemma, contextLength: 10_000_000 }, {})).toBe(3_000_000);
  });

  it('a long paste followed by a short follow-up keeps the paste in context', () => {
    const msgs = [
      { role: 'user', content: 'x'.repeat(20_000) },
      { role: 'assistant', content: 'Here is my read of the file.' },
      { role: 'user', content: 'now fix line 30' },
    ];
    const { kept, dropped } = fitContext(msgs, contextBudgetChars('gemma3:12b', gemma, {}));
    expect(dropped).toBe(0);
    expect(kept).toHaveLength(3);
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
    // an oversized earlier message is dropped, but the reply that followed it is kept as context
    const big = [{ role: 'user', content: 'x'.repeat(5000) }, { role: 'assistant', content: 'summary of it' }, { role: 'user', content: 'and now?' }];
    expect(fitContext(big, 1000).kept.map(m => m.role)).toEqual(['assistant', 'user']);
  });
});
