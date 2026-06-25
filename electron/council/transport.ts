// Real Council transport (BOOTSTRAP §3 Phase 3): routes an agent call to
//   - ollama-cloud / ollama-local / openai-compat → OpenAI-compatible chat HTTP
//   - claude-code / codex / openclaw               → one-shot CLI via runCaptured
//   - vscode-lm                                     → claw-bridge (Phase 6, not yet)
// The state machine (run.ts) takes this as an injected TransportFn, so this file
// holds only the I/O; all orchestration logic is tested separately with stubs.

import { RosterAgent, Msg } from './agents';
import { runCaptured } from '../ipc/runner';
import { bridgeLmInvoke } from '../bridge/client';
import { trace } from '../ipc/trace';

export interface TransportConfig {
  ollamaCloudUrl?: string;   // default https://ollama.com/v1
  ollamaCloudKey?: string;   // OLLAMA_API_KEY
  ollamaLocalUrl?: string;   // default http://localhost:11434/v1
  openaiCompatUrl?: string;
  openaiCompatKey?: string;
  paths?: { claude?: string; codex?: string; openclaw?: string };
  bridgePort?: number;       // claw-bridge (VS Code) localhost port for vscode-lm
  abortSignal?: AbortSignal; // cancels in-flight HTTP + kills CLI children on council:cancel
  claudeUnsetEnv?: string[]; // env vars to drop for claude-code (e.g. ANTHROPIC_API_KEY → use the subscription)
  cwd?: string;
}

export type OnDelta = (chunk: string) => void;

async function chatCompat(baseUrl: string, key: string | undefined, model: string, messages: Msg[], signal?: AbortSignal, onDelta?: OnDelta): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const started = Date.now();
  const auth = key || (/(^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/v1\/?$)/i.test(baseUrl) ? 'ollama' : undefined);
  const stream = !!onDelta;
  trace('council:transport:start', { transport: 'openai-compat', url, model, stream, messages: messages.map(m => ({ role: m.role, bytes: m.content.length })) });
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify({ model, messages, stream }),
    signal,
  });
  if (!r.ok) {
    const text = (await r.text().catch(() => '')).slice(0, 1000);
    trace('council:transport:error', { transport: 'openai-compat', url, model, status: r.status, ms: Date.now() - started, body: text });
    throw new Error(`HTTP ${r.status} ${text.slice(0, 300)}`);
  }

  if (!stream || !r.body) {
    const j: any = await r.json();
    const msg = j.choices?.[0]?.message ?? {};
    const content = msg.content;
    let text = '';
    if (typeof content === 'string') text = content;
    else if (Array.isArray(content)) text = content.map((p: any) => typeof p?.text === 'string' ? p.text : '').join('');
    if (!text.trim() && typeof msg.reasoning === 'string' && msg.reasoning.trim()) text = msg.reasoning;
    trace('council:transport:finish', { transport: 'openai-compat', url, model, status: r.status, ms: Date.now() - started, contentBytes: text.length });
    return text;
  }

  // streaming: parse OpenAI-style SSE, push content deltas to onDelta as they arrive
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', full = '', reasoning = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta ?? {};
        if (typeof delta.content === 'string' && delta.content) { full += delta.content; onDelta!(delta.content); }
        else if (typeof delta.reasoning === 'string' && delta.reasoning) { reasoning += delta.reasoning; }
      } catch { /* skip non-JSON keepalive lines */ }
    }
  }
  const text = full.trim() ? full : reasoning;
  trace('council:transport:finish', { transport: 'openai-compat', url, model, status: r.status, ms: Date.now() - started, contentBytes: text.length, streamed: true });
  return text;
}

function renderPrompt(messages: Msg[]): string {
  return messages.map((m) => (m.role === 'system' ? `[system]\n${m.content}` : m.content)).join('\n\n');
}

async function cliPrompt(binary: string, baseArgs: string[], messages: Msg[], cwd?: string, signal?: AbortSignal, onDelta?: OnDelta, unsetEnv?: string[]): Promise<string> {
  const prompt = messages.map((m) => (m.role === 'system' ? `[system]\n${m.content}` : m.content)).join('\n\n');
  trace('council:transport:start', { transport: 'cli', binary, args: baseArgs, cwd, promptBytes: prompt.length });
  const r = await runCaptured({ binary, args: baseArgs, input: prompt, cwd, timeoutMs: 180000, signal, onData: onDelta, unsetEnv });
  trace('council:transport:finish', { transport: 'cli', binary, code: r.code, stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length });
  if (r.code !== 0 && !r.stdout.trim()) throw new Error(r.stderr.slice(0, 300) || `${binary} exited ${r.code}`);
  return r.stdout || r.stderr;
}

async function openclawPrompt(binary: string, model: string | undefined, messages: Msg[], cwd?: string, signal?: AbortSignal, onDelta?: OnDelta): Promise<string> {
  const prompt = renderPrompt(messages);
  const args = ['agent', '--local', '--json', '--message', prompt];
  if (model) args.push('--model', model);
  trace('council:transport:start', { transport: 'openclaw', binary, model, cwd, promptBytes: prompt.length });
  const r = await runCaptured({ binary, args, cwd, timeoutMs: 180000, signal, onData: onDelta });
  trace('council:transport:finish', { transport: 'openclaw', binary, model, code: r.code, stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length });
  if (r.code !== 0 && !r.stdout.trim()) throw new Error(r.stderr.slice(0, 500) || `${binary} exited ${r.code}`);
  const raw = r.stdout || r.stderr;
  try {
    const j = JSON.parse(raw);
    return j.reply ?? j.content ?? j.message ?? raw;
  } catch {
    return raw;
  }
}

export function makeTransport(cfg: TransportConfig): (agent: RosterAgent, messages: Msg[], onDelta?: OnDelta) => Promise<string> {
  return async (agent, messages, onDelta) => {
    switch (agent.transport) {
      case 'ollama-cloud': return chatCompat(cfg.ollamaCloudUrl ?? 'https://ollama.com/v1', cfg.ollamaCloudKey, agent.model ?? '', messages, cfg.abortSignal, onDelta);
      case 'ollama-local': return chatCompat(cfg.ollamaLocalUrl ?? 'http://localhost:11434/v1', undefined, agent.model ?? '', messages, cfg.abortSignal, onDelta);
      case 'openai-compat': return chatCompat(cfg.openaiCompatUrl ?? 'http://localhost:11434/v1', cfg.openaiCompatKey, agent.model ?? '', messages, cfg.abortSignal, onDelta);
      case 'claude-code': return cliPrompt(cfg.paths?.claude ?? agent.binary ?? 'claude', ['--print', '--input-format', 'text', '--permission-mode', 'bypassPermissions', '--no-session-persistence'], messages, cfg.cwd, cfg.abortSignal, onDelta, cfg.claudeUnsetEnv);
      case 'codex': return cliPrompt(cfg.paths?.codex ?? agent.binary ?? 'codex', ['exec', '--sandbox', 'workspace-write', '--ask-for-approval', 'never', '--skip-git-repo-check', '--color', 'never', '-'], messages, cfg.cwd, cfg.abortSignal, onDelta);
      case 'openclaw': return openclawPrompt(cfg.paths?.openclaw ?? agent.binary ?? 'openclaw', agent.model, messages, cfg.cwd, cfg.abortSignal, onDelta);
      case 'vscode-lm': {
        const out = await bridgeLmInvoke(cfg.bridgePort ?? 39217, agent.model ?? '', messages);
        if (out == null) throw new Error('vscode-lm unavailable — is VS Code open with the claw-bridge extension running?');
        return out;
      }
      default: throw new Error(`unknown transport: ${(agent as RosterAgent).transport}`);
    }
  };
}
