import { ipcMain, BrowserWindow, webContents } from 'electron';

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
  options?: Record<string, any>;
}
interface VisionReq {
  openaiCompatUrl: string;
  apiKey?: string;
  model: string;
  messages: any[];          // OpenAI-format messages, may include image_url parts
  stream?: boolean;
}

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
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: req.model, messages: req.messages, stream: !!req.stream, options: req.options ?? {} }),
        signal: ctrl.signal
      });
      if (!req.stream) {
        const j: any = await r.json();
        return { content: j.message?.content ?? '', raw: j };
      }
      return streamReader(r, 'native');
    } catch (e: any) {
      return { content: '', error: e?.name === 'AbortError' ? 'Ollama request timed out' : (e?.message ?? String(e)) };
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
      if (!req.stream) {
        const j: any = await r.json();
        return { content: j.choices?.[0]?.message?.content ?? '', raw: j };
      }
      return streamReader(r, 'openai');
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

async function streamReader(r: Response, mode: 'native' | 'openai') {
  if (!r.body) return { content: '' };
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let full = '';
  let thinking = '';
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
          if (delta) { full += delta; broadcast('ollama:chunk', { delta, mode }); }
        } catch { /* ignore */ }
      } else if (mode === 'native') {
        try {
          const j = JSON.parse(trimmed);
          const delta = j.message?.content ?? '';
          if (delta) { full += delta; broadcast('ollama:chunk', { delta, mode }); }
          if (j.message?.thinking) { thinking += j.message.thinking; broadcast('ollama:chunk', { thinking: j.message.thinking, mode }); }
        } catch { /* ignore */ }
      }
    }
  }
  return { content: full, thinking };
}
