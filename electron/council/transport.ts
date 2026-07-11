// Real Council transport (BOOTSTRAP §3 Phase 3): routes an agent call to
//   - ollama-cloud / ollama-local                   → native Ollama API (POST /api/chat, NDJSON)
//   - openai-compat                                 → OpenAI-compatible chat HTTP (genuinely remote endpoints)
//   - claude-code / codex / openclaw               → one-shot CLI via runCaptured
//   - vscode-lm                                     → claw-bridge (Phase 6, not yet)
// The state machine (run.ts) takes this as an injected TransportFn, so this file
// holds only the I/O; all orchestration logic is tested separately with stubs.

import { type RosterAgent, type Msg } from './agents';
import { runCaptured } from '../ipc/runner';
import { bridgeLmInvoke } from '../bridge/client';
import { trace } from '../ipc/trace';
import { type ToolDef } from './mcpClient';

export interface TransportConfig {
  ollamaCloudUrl?: string;   // native Ollama endpoint; default https://ollama.com (direct cloud) — usually the local daemon, which serves *:cloud tags itself
  ollamaCloudKey?: string;   // OLLAMA_API_KEY
  ollamaLocalUrl?: string;   // default http://localhost:11434
  openaiCompatUrl?: string;
  openaiCompatKey?: string;
  think?: boolean | 'low' | 'medium' | 'high'; // request thinking from thinking-capable models (e.g. kimi-k2.7-code); falsy = leave the model default. message.thinking is kept separate and never mixed into content.
  paths?: { claude?: string; codex?: string; openclaw?: string };
  bridgePort?: number;       // claw-bridge (VS Code) localhost port for vscode-lm
  abortSignal?: AbortSignal; // cancels in-flight HTTP + kills CLI children on council:cancel
  claudeUnsetEnv?: string[]; // env vars to drop for claude-code (e.g. ANTHROPIC_API_KEY → use the subscription)
  claudeExtraArgs?: string[];// extra claude flags (--mcp-config <file>, --add-dir <dir>…) → tool + fs access
  actorTimeoutMs?: number;   // per-call timeout for agentic CLI actors (default 10 min — they do full turns)
  agentOptions?: Record<string, { temperature?: number; top_p?: number }>; // per-agent sampling dials (e.g. run hot)
  agentPersonas?: Record<string, string>; // per-agent persona text appended to the system prompt
  tools?: ToolDef[];         // read-only MCP tools offered to cloud agents (Atlas + Context7)
  callTool?: (name: string, args: any) => Promise<string>;
  toolCallCap?: number;      // max tool-call iterations before forcing a final answer
  cwd?: string;
}

const localAuth = (baseUrl: string, key?: string) => key || (/(^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/v1\/?$)/i.test(baseUrl) ? 'ollama' : undefined);

// Strip a legacy OpenAI-compat '/v1' suffix so settings saved before the native-API
// migration keep working against POST /api/chat.
const nativeBase = (baseUrl: string) => baseUrl.replace(/\/$/, '').replace(/\/v1$/i, '');

interface SampleOpts { temperature?: number; top_p?: number }

const CLI_TIMEOUT_DEFAULT = 600000;

export type OnDelta = (chunk: string) => void;

async function chatCompat(baseUrl: string, key: string | undefined, model: string, messages: Msg[], signal?: AbortSignal, onDelta?: OnDelta, sample?: SampleOpts): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const started = Date.now();
  const auth = key || (/(^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?\/v1\/?$)/i.test(baseUrl) ? 'ollama' : undefined);
  const stream = !!onDelta;
  const body: Record<string, unknown> = { model, messages, stream };
  if (sample?.temperature != null) body.temperature = sample.temperature;
  if (sample?.top_p != null) body.top_p = sample.top_p;
  trace('council:transport:start', { transport: 'openai-compat', url, model, stream, temperature: sample?.temperature, top_p: sample?.top_p, messages: messages.map(m => ({ role: m.role, bytes: m.content.length })) });
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: JSON.stringify(body),
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

/** Tool-calling agent loop for cloud models (non-streaming per turn). Sends the
 *  read-only tools, executes any tool_calls against the MCP servers, feeds results
 *  back, and loops until the model answers (or the iteration cap). */
async function chatCompatTools(baseUrl: string, key: string | undefined, model: string, messages: Msg[], signal: AbortSignal | undefined, onDelta: OnDelta | undefined, sample: SampleOpts | undefined, tools: ToolDef[], callTool: (n: string, a: any) => Promise<string>, maxIters = 12): Promise<string> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const auth = localAuth(baseUrl, key);
  const msgs: any[] = [...messages];
  for (let iter = 0; iter < maxIters; iter++) {
    // On the final allowed iteration, withhold tools + tell the model to answer now
    // ("do your best from here, friend") rather than dead-ending at the cap.
    const last = iter === maxIters - 1;
    if (last) { onDelta?.('\n  ⚠️ tool-call limit reached — wrapping up with what we have\n'); msgs.push({ role: 'user', content: 'You have reached the tool-call limit. Do NOT call any more tools. Using everything you have gathered, give your best, COMPLETE answer now.' }); }
    const body: Record<string, unknown> = { model, messages: msgs, stream: false };
    if (!last) { body.tools = tools; body.tool_choice = 'auto'; }
    if (sample?.temperature != null) body.temperature = sample.temperature;
    if (sample?.top_p != null) body.top_p = sample.top_p;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) }, body: JSON.stringify(body), signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const j: any = await r.json();
    const m = j.choices?.[0]?.message ?? {};
    const calls = !last && Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (calls.length) {
      msgs.push({ role: 'assistant', content: m.content ?? '', tool_calls: calls });
      for (const tc of calls) {
        let args: any = {}; try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* tolerate */ }
        const tname = tc.function?.name ?? '';
        onDelta?.(`\n  🔧 ${tname}(${JSON.stringify(args).slice(0, 120)})\n`);
        trace('council:tools:call', { tool: tname, model });
        const result = await callTool(tname, args);
        msgs.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 8000) });
      }
      continue;
    }
    const content = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((p: any) => p?.text ?? '').join('') : '';
    if (onDelta && content) onDelta(content);
    return content;
  }
  return '(no answer produced)';
}

type ThinkOpt = boolean | 'low' | 'medium' | 'high' | undefined;

/** Native Ollama chat (POST /api/chat, NDJSON streaming). `message.thinking` arrives separate
 *  from `message.content`; it is never streamed to onDelta and is only surfaced as a fallback
 *  when a reasoning model emitted no content at all (mirrors the old compat `reasoning` fallback). */
async function chatNative(baseUrl: string, key: string | undefined, model: string, messages: Msg[], signal?: AbortSignal, onDelta?: OnDelta, sample?: SampleOpts, think?: ThinkOpt): Promise<string> {
  const url = `${nativeBase(baseUrl)}/api/chat`;
  const started = Date.now();
  const stream = !!onDelta;
  const body: Record<string, unknown> = { model, messages, stream };
  if (think) body.think = think;
  const options: Record<string, unknown> = {};
  if (sample?.temperature != null) options.temperature = sample.temperature;
  if (sample?.top_p != null) options.top_p = sample.top_p;
  if (Object.keys(options).length) body.options = options;
  trace('council:transport:start', { transport: 'ollama-native', url, model, stream, temperature: sample?.temperature, top_p: sample?.top_p, messages: messages.map(m => ({ role: m.role, bytes: m.content.length })) });
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const text = (await r.text().catch(() => '')).slice(0, 1000);
    trace('council:transport:error', { transport: 'ollama-native', url, model, status: r.status, ms: Date.now() - started, body: text });
    throw new Error(`HTTP ${r.status} ${text.slice(0, 300)}`);
  }

  if (!stream || !r.body) {
    const j: any = await r.json();
    const msg = j.message ?? {};
    let text = typeof msg.content === 'string' ? msg.content : '';
    if (!text.trim() && typeof msg.thinking === 'string' && msg.thinking.trim()) text = msg.thinking;
    trace('council:transport:finish', { transport: 'ollama-native', url, model, status: r.status, ms: Date.now() - started, contentBytes: text.length });
    return text;
  }

  // streaming: parse Ollama NDJSON, push content deltas to onDelta as they arrive
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = '', full = '', thinking = '';
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
        const j = JSON.parse(t);
        const delta = j.message?.content ?? '';
        if (delta) { full += delta; onDelta!(delta); }
        if (typeof j.message?.thinking === 'string' && j.message.thinking) thinking += j.message.thinking;
      } catch { /* skip partial/keepalive lines */ }
    }
  }
  const text = full.trim() ? full : thinking;
  trace('council:transport:finish', { transport: 'ollama-native', url, model, status: r.status, ms: Date.now() - started, contentBytes: text.length, streamed: true });
  return text;
}

/** Tool-calling agent loop over the native API (non-streaming per turn) — same contract as
 *  chatCompatTools. Native /api/chat returns `message.tool_calls` with `function.arguments`
 *  already parsed as an object, and tool results go back as `role: 'tool'` messages. */
async function chatNativeTools(baseUrl: string, key: string | undefined, model: string, messages: Msg[], signal: AbortSignal | undefined, onDelta: OnDelta | undefined, sample: SampleOpts | undefined, tools: ToolDef[], callTool: (n: string, a: any) => Promise<string>, maxIters = 12, think?: ThinkOpt): Promise<string> {
  const url = `${nativeBase(baseUrl)}/api/chat`;
  const msgs: any[] = [...messages];
  for (let iter = 0; iter < maxIters; iter++) {
    // On the final allowed iteration, withhold tools + tell the model to answer now
    // ("do your best from here, friend") rather than dead-ending at the cap.
    const last = iter === maxIters - 1;
    if (last) { onDelta?.('\n  ⚠️ tool-call limit reached — wrapping up with what we have\n'); msgs.push({ role: 'user', content: 'You have reached the tool-call limit. Do NOT call any more tools. Using everything you have gathered, give your best, COMPLETE answer now.' }); }
    const body: Record<string, unknown> = { model, messages: msgs, stream: false };
    if (think) body.think = think;
    if (!last) body.tools = tools;
    const options: Record<string, unknown> = {};
    if (sample?.temperature != null) options.temperature = sample.temperature;
    if (sample?.top_p != null) options.top_p = sample.top_p;
    if (Object.keys(options).length) body.options = options;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), signal });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const j: any = await r.json();
    const m = j.message ?? {};
    const calls = !last && Array.isArray(m.tool_calls) ? m.tool_calls : [];
    if (calls.length) {
      msgs.push({ role: 'assistant', content: m.content ?? '', tool_calls: calls });
      for (const tc of calls) {
        const rawArgs = tc.function?.arguments;
        let args: any = {};
        if (rawArgs && typeof rawArgs === 'object') args = rawArgs;
        else { try { args = JSON.parse(rawArgs || '{}'); } catch { /* tolerate */ } }
        const tname = tc.function?.name ?? '';
        onDelta?.(`\n  🔧 ${tname}(${JSON.stringify(args).slice(0, 120)})\n`);
        trace('council:tools:call', { tool: tname, model });
        const result = await callTool(tname, args);
        msgs.push({ role: 'tool', tool_name: tname, content: String(result).slice(0, 8000) });
      }
      continue;
    }
    const content = typeof m.content === 'string' ? m.content : '';
    if (onDelta && content) onDelta(content);
    return content;
  }
  return '(no answer produced)';
}

function renderPrompt(messages: Msg[]): string {
  return messages.map((m) => (m.role === 'system' ? `[system]\n${m.content}` : m.content)).join('\n\n');
}

async function cliPrompt(binary: string, baseArgs: string[], messages: Msg[], cwd?: string, signal?: AbortSignal, onDelta?: OnDelta, unsetEnv?: string[], timeoutMs = CLI_TIMEOUT_DEFAULT): Promise<string> {
  const prompt = messages.map((m) => (m.role === 'system' ? `[system]\n${m.content}` : m.content)).join('\n\n');
  trace('council:transport:start', { transport: 'cli', binary, args: baseArgs, cwd, promptBytes: prompt.length, timeoutMs });
  const r = await runCaptured({ binary, args: baseArgs, input: prompt, cwd, timeoutMs, signal, onData: onDelta, unsetEnv });
  trace('council:transport:finish', { transport: 'cli', binary, code: r.code, stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length });
  if (r.code !== 0 && !r.stdout.trim()) throw new Error(r.stderr.slice(0, 300) || `${binary} exited ${r.code}`);
  return r.stdout || r.stderr;
}

async function openclawPrompt(binary: string, model: string | undefined, messages: Msg[], cwd?: string, signal?: AbortSignal, onDelta?: OnDelta, timeoutMs = CLI_TIMEOUT_DEFAULT): Promise<string> {
  const prompt = renderPrompt(messages);
  const args = ['agent', '--local', '--json', '--message', prompt];
  if (model) args.push('--model', model);
  trace('council:transport:start', { transport: 'openclaw', binary, model, cwd, promptBytes: prompt.length });
  const r = await runCaptured({ binary, args, cwd, timeoutMs, signal, onData: onDelta });
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
  const tooled = !!(cfg.tools && cfg.tools.length && cfg.callTool);
  const cloud = (baseUrl: string, key: string | undefined, model: string, messages: Msg[], onDelta?: OnDelta, sample?: SampleOpts) =>
    tooled ? chatCompatTools(baseUrl, key, model, messages, cfg.abortSignal, onDelta, sample, cfg.tools!, cfg.callTool!, cfg.toolCallCap ?? 12) : chatCompat(baseUrl, key, model, messages, cfg.abortSignal, onDelta, sample);
  const native = (baseUrl: string, key: string | undefined, model: string, messages: Msg[], onDelta?: OnDelta, sample?: SampleOpts) =>
    tooled ? chatNativeTools(baseUrl, key, model, messages, cfg.abortSignal, onDelta, sample, cfg.tools!, cfg.callTool!, cfg.toolCallCap ?? 12, cfg.think) : chatNative(baseUrl, key, model, messages, cfg.abortSignal, onDelta, sample, cfg.think);
  return async (agent, rawMessages, onDelta) => {
    const sample = cfg.agentOptions?.[agent.id];
    const persona = cfg.agentPersonas?.[agent.id];
    // give the agent its assigned personality by extending the system message
    const messages = persona && rawMessages[0]?.role === 'system'
      ? [{ role: 'system' as const, content: `${rawMessages[0].content}\n\nADOPT THIS PERSONA: ${persona}` }, ...rawMessages.slice(1)]
      : rawMessages;
    switch (agent.transport) {
      case 'ollama-cloud': return native(cfg.ollamaCloudUrl ?? 'https://ollama.com', cfg.ollamaCloudKey, agent.model ?? '', messages, onDelta, sample);
      case 'ollama-local': return native(cfg.ollamaLocalUrl ?? 'http://localhost:11434', undefined, agent.model ?? '', messages, onDelta, sample);
      case 'openai-compat': return cloud(cfg.openaiCompatUrl ?? 'http://localhost:11434/v1', cfg.openaiCompatKey, agent.model ?? '', messages, onDelta, sample);
      case 'claude-code': return cliPrompt(cfg.paths?.claude ?? agent.binary ?? 'claude', ['--print', '--input-format', 'text', '--permission-mode', 'bypassPermissions', '--no-session-persistence', ...(cfg.claudeExtraArgs ?? [])], messages, cfg.cwd, cfg.abortSignal, onDelta, cfg.claudeUnsetEnv, cfg.actorTimeoutMs);
      case 'codex': return cliPrompt(cfg.paths?.codex ?? agent.binary ?? 'codex', ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--color', 'never', '-'], messages, cfg.cwd, cfg.abortSignal, onDelta, undefined, cfg.actorTimeoutMs);
      case 'openclaw': return openclawPrompt(cfg.paths?.openclaw ?? agent.binary ?? 'openclaw', agent.model, messages, cfg.cwd, cfg.abortSignal, onDelta, cfg.actorTimeoutMs);
      case 'vscode-lm': {
        const out = await bridgeLmInvoke(cfg.bridgePort ?? 39217, agent.model ?? '', messages);
        if (out == null) throw new Error('vscode-lm unavailable — is VS Code open with the claw-bridge extension running?');
        return out;
      }
      default: throw new Error(`unknown transport: ${(agent as RosterAgent).transport}`);
    }
  };
}
