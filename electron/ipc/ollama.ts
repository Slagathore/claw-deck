import { ipcMain, webContents } from 'electron';
import { type ModelInfo, normalizeModel } from '../lib/modelCaps';
import { MEMORY_TOOLS, callMemoryTool } from './threads';

/**
 * Ollama integration with two paths:
 *  - Native Ollama API  (POST /api/chat)
 *  - OpenAI-compatible  (POST {openaiCompatUrl}/chat/completions)
 *
 * The OpenAI path is the one used for vision + Gemini-style models that have
 * tool-calling issues on the native Anthropic/Ollama-native path. Forum-recommended
 * workaround: send images as OpenAI vision `image_url` parts with base64 data URI.
 */

interface ChatReq {
  baseUrl: string;
  model: string;
  messages: any[];
  stream?: boolean;
  think?: boolean | 'low' | 'medium' | 'high';   // request a thinking pass (thinking-capable models); omitted when falsy → model default
  options?: Record<string, any>;
  /** Echoed on every 'ollama:chunk' so a listener can ignore other callers' streams. */
  streamId?: string;
  /** 'memory' lets the model search saved conversations (tool-capable models only). */
  tools?: 'memory';
  /** The thread being answered, so memory tools skip what is already in context. */
  threadId?: string | null;
}
interface VisionReq {
  openaiCompatUrl: string;
  apiKey?: string;
  model: string;
  messages: any[];          // OpenAI-format messages, may include image_url parts
  stream?: boolean;
  streamId?: string;
}

const MAX_TOOL_ROUNDS = 5;
const showCache = new Map<string, any>(); // digest -> /api/show response

function broadcast(channel: string, payload: any) {
  for (const wc of webContents.getAllWebContents()) wc.send(channel, payload);
}

export function registerOllamaHandlers() {
  ipcMain.handle('ollama:listModels', async (_e, baseUrl: string = 'http://localhost:11434') => {
    try {
      const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`);
      if (!r.ok) return { error: `HTTP ${r.status}`, models: [] };
      const j: any = await r.json();
      return { models: (j.models ?? []).map((m: any) => m.name) };
    } catch (e: any) {
      return { error: e.message, models: [] };
    }
  });

  // Installed models with what each can do (vision / tools / thinking / embedding),
  // context window, and size, so pickers can show the right models per slot.
  ipcMain.handle('ollama:modelInfo', async (_e, baseUrl: string = 'http://localhost:11434'): Promise<{ models: ModelInfo[]; error?: string }> => {
    const base = baseUrl.replace(/\/$/, '');
    try {
      const r = await fetch(`${base}/api/tags`);
      if (!r.ok) return { error: `HTTP ${r.status}`, models: [] };
      const j: any = await r.json();
      const tags: any[] = j.models ?? [];
      // Older daemons leave capabilities off /api/tags; ask /api/show for those (cached by digest).
      const needShow = tags.filter(t => !Array.isArray(t.capabilities) || !t.capabilities.length);
      let i = 0;
      await Promise.all(Array.from({ length: Math.min(4, needShow.length) }, async () => {
        while (i < needShow.length) {
          const t = needShow[i++];
          const key = t.digest || t.name;
          if (showCache.has(key)) continue;
          try {
            const sr = await fetch(`${base}/api/show`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: t.name }) });
            if (sr.ok) showCache.set(key, await sr.json());
          } catch { /* fall back to the name-based guess */ }
        }
      }));
      return { models: tags.map(t => normalizeModel(t, showCache.get(t.digest || t.name))) };
    } catch (e: any) {
      return { error: e.message, models: [] };
    }
  });

  ipcMain.handle('ollama:ps', async (_e, baseUrl: string = 'http://localhost:11434') => {
    try {
      const r = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ps`);
      if (!r.ok) return { error: `HTTP ${r.status}`, running: [] };
      const j: any = await r.json();
      const running = (j.models ?? []).map((m: any) => ({
        name: m.name,
        size: m.size,
        sizeVram: m.size_vram,
        expiresAt: m.expires_at ? Date.parse(m.expires_at) : undefined
      }));
      return { running };
    } catch (e: any) {
      return { error: e.message, running: [] };
    }
  });

  // Unload a model from VRAM by calling /api/generate with keep_alive=0.
  ipcMain.handle('ollama:stop', async (_e, opts: { baseUrl?: string; model: string }) => {
    const baseUrl = (opts.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    try {
      const r = await fetch(`${baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: opts.model, keep_alive: 0 })
      });
      return { ok: r.ok };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  // Delete a pulled model from disk via /api/delete.
  ipcMain.handle('ollama:delete', async (_e, opts: { baseUrl?: string; model: string }) => {
    const baseUrl = (opts.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    try {
      const r = await fetch(`${baseUrl}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: opts.model })
      });
      return { ok: r.ok, status: r.status };
    } catch (e: any) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('ollama:chat', async (_e, req: ChatReq) => {
    const url = `${req.baseUrl.replace(/\/$/, '')}/api/chat`;
    // Timeout the connection for non-stream calls so a hung Ollama can't stall
    // the send forever. Streaming responses manage their own lifetime.
    const ctrl = new AbortController();
    const timer = req.stream ? undefined : setTimeout(() => ctrl.abort(), 120000);
    let think = req.think || undefined;
    let tools: readonly any[] | undefined = req.tools === 'memory' ? MEMORY_TOOLS : undefined;
    const messages: any[] = [...req.messages];
    let content = '';
    let thinking = '';
    const toolLog: { name: string; args: any }[] = [];
    try {
      for (let round = 0; ; round++) {
        // Past the round cap, withhold tools so the model has to answer.
        const offer = tools && round < MAX_TOOL_ROUNDS ? tools : undefined;
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: req.model, messages, stream: !!req.stream, ...(think ? { think } : {}), ...(offer ? { tools: offer } : {}), options: req.options ?? {} }),
          signal: ctrl.signal
        });
        if (!r.ok) {
          const text = (await r.text().catch(() => '')).slice(0, 400);
          // A model that lacks an optional feature rejects the whole request; drop the feature and retry.
          if (r.status === 400 && think && /think/i.test(text)) { think = undefined; round--; continue; }
          if (r.status === 400 && tools && /tool/i.test(text)) { tools = undefined; round--; continue; }
          return { content, thinking, tools: toolLog, error: `Ollama HTTP ${r.status}${text ? `: ${text}` : ''}` };
        }
        let msg: { content: string; thinking: string; toolCalls: any[] };
        if (!req.stream) {
          const j: any = await r.json();
          msg = { content: j.message?.content ?? '', thinking: j.message?.thinking ?? '', toolCalls: j.message?.tool_calls ?? [] };
        } else {
          const s = await streamReader(r, 'native', req.streamId);
          msg = { content: s.content, thinking: s.thinking ?? '', toolCalls: s.toolCalls ?? [] };
        }
        content += msg.content;
        thinking += msg.thinking;
        if (!offer || !msg.toolCalls.length) break;
        messages.push({ role: 'assistant', content: msg.content, tool_calls: msg.toolCalls });
        for (const tc of msg.toolCalls) {
          const name = String(tc.function?.name ?? '');
          const raw = tc.function?.arguments;
          let args: any = {};
          if (raw && typeof raw === 'object') args = raw;
          else { try { args = JSON.parse(raw || '{}'); } catch { /* tolerate */ } }
          toolLog.push({ name, args });
          broadcast('ollama:chunk', { id: req.streamId, tool: { name, args }, mode: 'native' });
          const result = await callMemoryTool(name, args, { excludeThreadId: req.threadId });
          messages.push({ role: 'tool', tool_name: name, content: String(result).slice(0, 8000) });
        }
      }
      return { content, thinking, tools: toolLog };
    } catch (e: any) {
      return { content, thinking, tools: toolLog, error: e?.name === 'AbortError' ? 'Ollama request timed out' : (e?.message ?? String(e)) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  ipcMain.handle('ollama:vision', async (_e, req: VisionReq) => {
    const url = `${req.openaiCompatUrl.replace(/\/$/, '')}/chat/completions`;
    const ctrl = new AbortController();
    const timer = req.stream ? undefined : setTimeout(() => ctrl.abort(), 120000);
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(req.apiKey ? { Authorization: `Bearer ${req.apiKey}` } : {})
        },
        body: JSON.stringify({ model: req.model, messages: req.messages, stream: !!req.stream }),
        signal: ctrl.signal
      });
      if (!r.ok) {
        const text = (await r.text().catch(() => '')).slice(0, 400);
        return { content: '', error: `Vision HTTP ${r.status}${text ? `: ${text}` : ''}` };
      }
      if (!req.stream) {
        const j: any = await r.json();
        return { content: j.choices?.[0]?.message?.content ?? '', raw: j };
      }
      return streamReader(r, 'openai', req.streamId);
    } catch (e: any) {
      return { content: '', error: e?.name === 'AbortError' ? 'Vision request timed out' : (e?.message ?? String(e)) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  // Pull a model from the Ollama registry, streaming { status, completed, total }
  // chunks back to the renderer on the 'ollama:pull' channel keyed by id.
  ipcMain.handle('ollama:pull', async (_e, opts: { baseUrl?: string; model: string; id: string }) => {
    const baseUrl = (opts.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
    const id = opts.id;
    try {
      const r = await fetch(`${baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: opts.model, stream: true })
      });
      if (!r.ok || !r.body) {
        broadcast('ollama:pull', { id, status: 'error', error: `HTTP ${r.status}` });
        return { ok: false, error: `HTTP ${r.status}` };
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t) continue;
          try {
            const j: any = JSON.parse(t);
            broadcast('ollama:pull', { id, ...j });
          } catch { /* ignore */ }
        }
      }
      broadcast('ollama:pull', { id, status: 'done' });
      return { ok: true };
    } catch (e: any) {
      broadcast('ollama:pull', { id, status: 'error', error: e.message });
      return { ok: false, error: e.message };
    }
  });
}

async function streamReader(r: Response, mode: 'native' | 'openai', id?: string): Promise<{ content: string; thinking?: string; toolCalls?: any[] }> {
  if (!r.body) return { content: '' };
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let thinking = '';
  const toolCalls: any[] = [];
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (mode === 'openai' && trimmed.startsWith('data:')) {
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          const delta = j.choices?.[0]?.delta?.content ?? '';
          if (delta) { full += delta; broadcast('ollama:chunk', { id, delta, mode }); }
        } catch { /* ignore */ }
      } else if (mode === 'native') {
        try {
          const j = JSON.parse(trimmed);
          const delta = j.message?.content ?? '';
          if (delta) { full += delta; broadcast('ollama:chunk', { id, delta, mode }); }
          if (j.message?.thinking) { thinking += j.message.thinking; broadcast('ollama:chunk', { id, thinking: j.message.thinking, mode }); }
          if (Array.isArray(j.message?.tool_calls)) toolCalls.push(...j.message.tool_calls);
        } catch { /* ignore */ }
      }
    }
  }
  return { content: full, thinking, toolCalls };
}
