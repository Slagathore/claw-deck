// Real Council transport (BOOTSTRAP §3 Phase 3): routes an agent call to
//   - ollama-cloud / ollama-local / openai-compat → OpenAI-compatible chat HTTP
//   - claude-code / codex / openclaw               → one-shot CLI via runCaptured
//   - vscode-lm                                     → claw-bridge (Phase 6, not yet)
// The state machine (run.ts) takes this as an injected TransportFn, so this file
// holds only the I/O; all orchestration logic is tested separately with stubs.

import { RosterAgent, Msg } from './agents';
import { runCaptured } from '../ipc/runner';

export interface TransportConfig {
  ollamaCloudUrl?: string;   // default https://ollama.com/v1
  ollamaCloudKey?: string;   // OLLAMA_API_KEY
  ollamaLocalUrl?: string;   // default http://localhost:11434/v1
  openaiCompatUrl?: string;
  openaiCompatKey?: string;
  paths?: { claude?: string; codex?: string; openclaw?: string };
  cwd?: string;
}

async function chatCompat(baseUrl: string, key: string | undefined, model: string, messages: Msg[]): Promise<string> {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j: any = await r.json();
  return j.choices?.[0]?.message?.content ?? '';
}

async function cliPrompt(binary: string, baseArgs: string[], messages: Msg[], cwd?: string): Promise<string> {
  const prompt = messages.map((m) => (m.role === 'system' ? `[system]\n${m.content}` : m.content)).join('\n\n');
  const r = await runCaptured({ binary, args: baseArgs, input: prompt, cwd, timeoutMs: 180000 });
  if (r.code !== 0 && !r.stdout.trim()) throw new Error(r.stderr.slice(0, 300) || `${binary} exited ${r.code}`);
  return r.stdout || r.stderr;
}

export function makeTransport(cfg: TransportConfig): (agent: RosterAgent, messages: Msg[]) => Promise<string> {
  return async (agent, messages) => {
    switch (agent.transport) {
      case 'ollama-cloud': return chatCompat(cfg.ollamaCloudUrl ?? 'https://ollama.com/v1', cfg.ollamaCloudKey, agent.model ?? '', messages);
      case 'ollama-local': return chatCompat(cfg.ollamaLocalUrl ?? 'http://localhost:11434/v1', undefined, agent.model ?? '', messages);
      case 'openai-compat': return chatCompat(cfg.openaiCompatUrl ?? 'http://localhost:11434/v1', cfg.openaiCompatKey, agent.model ?? '', messages);
      // CLI invocations are best-effort one-shots (flags may evolve per CLI):
      case 'claude-code': return cliPrompt(cfg.paths?.claude ?? agent.binary ?? 'claude', ['--print'], messages, cfg.cwd);
      case 'codex': return cliPrompt(cfg.paths?.codex ?? agent.binary ?? 'codex', ['exec'], messages, cfg.cwd);
      case 'openclaw': return cliPrompt(cfg.paths?.openclaw ?? agent.binary ?? 'openclaw', ['run'], messages, cfg.cwd);
      case 'vscode-lm': throw new Error('vscode-lm transport requires the claw-bridge VS Code extension (Phase 6)');
      default: throw new Error(`unknown transport: ${(agent as RosterAgent).transport}`);
    }
  };
}
