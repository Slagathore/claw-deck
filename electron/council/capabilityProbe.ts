// In-app capability probe — runs the compact PROBE_PROMPTS against the roster's reachable
// (Ollama) models and returns a model→{capId:status} map for the director's builder routing.
// The portable, richer version is the standalone tool in CodeStuff/dependencies/capability-probe;
// this is the lean app-embedded one (no external dependency). Reasoning is suppressed
// (think:false) and an empty reply is retried with a bigger budget — same error-correction idea.

import { PROBE_PROMPTS, ProbedCaps } from './capabilities';
import { looksLikeProviderError } from './providerError';

async function chat(base: string, model: string, prompt: string, numPredict: number, timeoutMs: number): Promise<{ content: string; error: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/api/chat`, {
      method: 'POST', signal: ctrl.signal, headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, stream: false, think: false, options: { num_predict: numPredict, temperature: 0.3 }, messages: [{ role: 'user', content: prompt }] }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (!r.ok || j.error) return { content: '', error: (j.error || `HTTP ${r.status}`).toString() };
    return { content: (j.message?.content ?? '').toString(), error: null };
  } catch (e: any) { return { content: '', error: String(e?.message ?? e) }; }
  finally { clearTimeout(timer); }
}

export interface ProbeOpts { base: string; timeoutMs?: number; caps?: string[]; onProgress?: (model: string, capId: string, status: string) => void; signal?: { aborted: boolean } }

export async function probeCapabilities(models: { id: string; model: string }[], opts: ProbeOpts): Promise<ProbedCaps> {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const prompts = opts.caps ? PROBE_PROMPTS.filter((p) => opts.caps!.includes(p.id)) : PROBE_PROMPTS;
  const out: ProbedCaps = {};
  for (const m of models) {
    if (opts.signal?.aborted) break;
    out[m.model] = {};
    for (const p of prompts) {
      if (opts.signal?.aborted) break;
      let r = await chat(opts.base, m.model, p.prompt, 1200, timeoutMs);
      if (!r.error && !r.content.trim()) r = await chat(opts.base, m.model, p.prompt, 3000, timeoutMs);   // empty → escalate budget
      const status = r.error
        ? (looksLikeProviderError(r.error) ? 'error' : 'unreachable')
        : (!r.content.trim() ? 'empty' : (p.pass(r.content) ? 'pass' : 'fail'));
      out[m.model][p.id] = status;
      opts.onProgress?.(m.model, p.id, status);
    }
  }
  return out;
}
