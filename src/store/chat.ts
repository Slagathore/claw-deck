/**
 * The Chat tab's state and send logic, held outside the component so a
 * conversation survives switching tabs (the tab unmounts) and an in-flight reply
 * keeps streaming while another tab is showing. Every message is written to the
 * thread store as it happens, and the open thread id is remembered, so the same
 * chat is back after closing the app or restarting the PC.
 */
import { create } from 'zustand';
import { useSettings, useUI } from './ui';
import { splitThinking } from '../lib/thinking';
import { newMetrics, recordDelta, finalize, view, type MetricsSnapshot } from '../lib/metrics';
import { routeRequest } from '../lib/router';
import { type Plan, type PlanStep, type ParsedPlan, type StepStatus, parsePlan, PLANNER_SYSTEM_PROMPT } from '../lib/planner';
import { buildChatSystem, formatRecall, type RecallHit } from '../lib/appGuide';
import { fitContext } from '../lib/chatContext';
import { type ModelInfo, contextBudgetChars, findModel, resolveParams } from '../lib/modelSlots';
import type { MessageRow } from '../../electron/memory/store';

export type ChatBackend = 'auto' | 'chat' | 'vision' | 'openclaw' | 'claude';
const BACKENDS: ChatBackend[] = ['auto', 'chat', 'vision', 'openclaw', 'claude'];

export interface StepRun { status: StepStatus; output: string }

export interface ChatMsg {
  /** Row id in the thread store once saved. */
  id?: number;
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  thinking?: string;
  /** Present for assistant turns produced in Agent mode. */
  parsed?: ParsedPlan;
  /** Stored alongside the message (model, metrics, recall count, tool lookups, step runs). */
  meta?: Record<string, any>;
}

interface ChatState {
  hydrated: boolean;
  threadId: string | null;
  title: string;
  msgs: ChatMsg[];
  runs: Record<string, StepRun>;          // key: `turnIdx:stepIdx`
  agent: boolean;
  backend: ChatBackend;
  model: string;
  input: string;
  images: string[];
  busy: boolean;
  liveContent: string;
  liveThinking: string;
  liveTools: string[];
  metrics: MetricsSnapshot | null;
  runningPlan: number | null;
  autoApprove: boolean;
  modelInfo: ModelInfo[];

  hydrate: () => Promise<void>;
  newChat: () => void;
  openThread: (id: string) => Promise<boolean>;
  forgetThread: (id?: string) => void;
  refreshModels: (baseUrl?: string) => Promise<string | null>;
  setAgent: (v: boolean) => void;
  setBackend: (v: ChatBackend) => void;
  setModel: (v: string) => void;
  setInput: (v: string) => void;
  setImages: (v: string[] | ((prev: string[]) => string[])) => void;
  setAutoApprove: (v: boolean) => void;
  handleChunk: (c: any) => void;
  send: () => Promise<void>;
  runPlan: (turnIdx: number, plan: Plan) => Promise<void>;
  retryAsPlan: (turnIdx: number) => Promise<void>;
}

const ACTIVE_KEY = 'clawdeck:chat:activeThread';
const DRAFT_KEY = 'clawdeck:chat:draft';
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* ignore */ } }
};

// Bumped whenever the visible thread changes. A reply that started under an older
// generation is still saved to its own thread, but no longer touches the screen.
let gen = 0;
// Only chunks from our own in-flight request are shown (other callers share the channel).
let activeStream: string | null = null;
let liveMetrics: MetricsSnapshot | null = null;
let appVersion: string | undefined;

const streamId = () => `chat:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
const settings = () => useSettings.getState().data ?? {};
const titleOf = (text: string) => { const t = text.replace(/\s+/g, ' ').trim(); return t.length > 64 ? t.slice(0, 61).trimEnd() + '…' : t; };

function toChatMsg(r: MessageRow): ChatMsg {
  const meta = r.meta ?? {};
  return {
    id: r.id, role: r.role, content: r.content,
    images: r.images?.length ? r.images : undefined,
    thinking: r.thinking || undefined,
    parsed: r.role === 'assistant' && meta.agent ? parsePlan(r.content) : undefined,
    meta
  };
}

function runsFrom(msgs: ChatMsg[]): Record<string, StepRun> {
  const out: Record<string, StepRun> = {};
  msgs.forEach((m, turn) => {
    const saved = m.meta?.runs as Record<string, StepRun> | undefined;
    if (!saved) return;
    for (const [step, run] of Object.entries(saved)) out[`${turn}:${step}`] = run;
  });
  return out;
}

async function saveMessage(threadId: string, m: ChatMsg): Promise<number | undefined> {
  try {
    const r = await window.api.threads.append(threadId, { role: m.role, content: m.content, thinking: m.thinking, images: m.images, meta: m.meta });
    return r.id;
  } catch { return undefined; } // saving is best-effort; the chat itself must keep working
}

async function recallFor(query: string, threadId: string | null): Promise<RecallHit[]> {
  if (!query.trim()) return [];
  try { return await window.api.threads.search({ query, k: 5, excludeThreadId: threadId, strict: true }); }
  catch { return []; }
}

export const useChat = create<ChatState>((set, get) => {
  /** Create the thread on first use (an empty "new chat" is never saved). */
  async function ensureThread(firstText: string): Promise<string> {
    const st = get();
    if (st.threadId) return st.threadId;
    const t = await window.api.threads.create({ kind: 'chat', agent: st.agent, backend: st.backend, model: st.model });
    set({ threadId: t.id, title: titleOf(firstText) || 'Untitled chat' });
    ls.set(ACTIVE_KEY, t.id);
    return t.id;
  }

  function syncThread(patch: { agent?: boolean; backend?: string; model?: string }) {
    const id = get().threadId;
    if (id) window.api.threads.update(id, patch).catch(() => { /* best-effort */ });
  }

  /** Append an assistant turn: always saved to its thread, shown only if that thread is still open. */
  async function deliver(myGen: number, threadId: string, msg: ChatMsg, extra: Partial<ChatState> = {}) {
    msg.id = await saveMessage(threadId, msg);
    if (gen !== myGen) return;
    set(s => ({ msgs: [...s.msgs, msg], busy: false, liveContent: '', liveThinking: '', liveTools: [], ...extra }));
  }

  async function sendChat() {
    const st = get();
    const s = settings();
    const myGen = gen;
    const images = st.images;
    liveMetrics = newMetrics();
    set({ busy: true, liveContent: '', liveThinking: '', liveTools: [], metrics: liveMetrics });

    let resolvedBackend: 'chat' | 'vision' | 'openclaw' | 'claude';
    let resolvedModel: string;
    let cleanedPrompt = st.input;
    let routeReason: string | undefined;
    if (st.backend === 'auto') {
      const routed = routeRequest({
        prompt: st.input, imageCount: images.length,
        settings: { chatModel: s.chatModel, reasoningModel: s.reasoningModel, visionModel: s.visionModel }
      });
      cleanedPrompt = routed.cleanedPrompt;
      routeReason = routed.reason;
      resolvedBackend = routed.backend === 'reasoning' ? 'chat' : routed.backend;
      resolvedModel = routed.model;
    } else {
      resolvedBackend = st.backend;
      resolvedModel = st.model;
    }
    const useVision = resolvedBackend === 'vision' || (resolvedBackend === 'chat' && images.length > 0);
    if (resolvedBackend === 'vision') resolvedModel = s.visionModel;

    const userMsg: ChatMsg = { role: 'user', content: cleanedPrompt, images: images.length ? images : undefined };
    const convo = [...st.msgs, userMsg];
    set({ msgs: convo, input: '', images: [] });
    ls.set(DRAFT_KEY, null);

    let threadId: string;
    try {
      threadId = await ensureThread(cleanedPrompt);
    } catch (e: any) {
      if (gen === myGen) set(x => ({ busy: false, msgs: [...x.msgs, { role: 'assistant', content: `Error: could not save this chat (${e?.message ?? e}).`, meta: { error: true } }] }));
      return;
    }
    userMsg.id = await saveMessage(threadId, userMsg);

    try {
      let response = '';
      let thinking = '';
      let tools: { name: string; args: any }[] = [];
      let recall: RecallHit[] = [];
      if (resolvedBackend === 'openclaw' || resolvedBackend === 'claude') {
        response = `(${resolvedBackend} CLI mode: open the Console tab to start a session.)`;
      } else {
        recall = await recallFor(cleanedPrompt, threadId);
        const info = findModel(get().modelInfo, resolvedModel);
        const rp = resolveParams(resolvedModel, info, s.think, s.modelParams);
        const canSearch = !useVision && rp.tools;
        if (!appVersion) appVersion = await window.api.app.version().then(v => v.version).catch(() => undefined);
        const system = buildChatSystem({
          version: appVersion, activeModel: resolvedModel,
          chatModel: s.chatModel, reasoningModel: s.reasoningModel, visionModel: s.visionModel, embedModel: s.embedModel,
          ollamaUrl: s.ollamaUrl, installedModels: get().modelInfo.map(m => m.name),
          canSearchHistory: canSearch, threadTitle: get().title
        }, recall);
        // Failed turns are kept on screen but not re-sent; the rest is trimmed to what fits.
        const { kept } = fitContext(convo.filter(m => !m.meta?.error), contextBudgetChars(resolvedModel, info, s.modelParams));
        const id = streamId();
        activeStream = id;
        if (useVision) {
          const messages = [
            { role: 'system', content: system },
            ...kept.map(m => m.images?.length
              ? { role: m.role, content: [{ type: 'text', text: m.content || 'Describe the image(s).' }, ...m.images.map(url => ({ type: 'image_url', image_url: { url } }))] }
              : { role: m.role, content: m.content })
          ];
          const r = await window.api.ollama.vision({ openaiCompatUrl: s.openaiCompatUrl, apiKey: s.openaiCompatKey, model: resolvedModel, messages, stream: true, streamId: id });
          if (r.error && !r.content) throw new Error(r.error);
          response = r.content;
        } else {
          const r = await window.api.ollama.chat({
            baseUrl: s.ollamaUrl, model: resolvedModel,
            messages: [{ role: 'system', content: system }, ...kept.map(m => ({ role: m.role, content: m.content }))],
            stream: true, think: rp.think, options: rp.options,
            tools: canSearch ? 'memory' : undefined, threadId, streamId: id
          });
          if (r.error && !r.content) throw new Error(r.error);
          response = r.content;
          thinking = r.thinking || '';
          tools = r.tools ?? [];
        }
        if (activeStream === id) activeStream = null;
      }
      const parsed = splitThinking(response);
      const finalMetrics = finalize(liveMetrics ?? newMetrics());
      const asst: ChatMsg = {
        role: 'assistant', content: parsed.visible || response, thinking: thinking || parsed.thinking || undefined,
        meta: {
          backend: resolvedBackend, model: resolvedModel, metrics: view(finalMetrics),
          routed: st.backend === 'auto' ? routeReason : undefined,
          recalled: recall.length || undefined,
          recalledFrom: recall.length ? [...new Set(recall.map(h => h.threadTitle))].slice(0, 5) : undefined,
          tools: tools.length ? tools : undefined
        }
      };
      await deliver(myGen, threadId, asst, { metrics: finalMetrics });
    } catch (e: any) {
      await deliver(myGen, threadId, { role: 'assistant', content: `Error: ${e?.message ?? e}`, meta: { error: true } });
    }
  }

  async function runPlanner(history: ChatMsg[], strictRetry = false) {
    const st = get();
    const s = settings();
    const myGen = gen;
    const agentModel = s.reasoningModel || st.model || s.chatModel;
    const lastUser = [...history].reverse().find(m => m.role === 'user' && !m.content.startsWith('[plan-results]'));
    let threadId: string;
    try { threadId = await ensureThread(lastUser?.content ?? ''); }
    catch (e: any) {
      if (gen === myGen) set(x => ({ busy: false, msgs: [...x.msgs, { role: 'assistant', content: `Error: could not save this chat (${e?.message ?? e}).`, meta: { error: true } }] }));
      return;
    }
    if (!agentModel) {
      await deliver(myGen, threadId, { role: 'assistant', content: 'Error: no chat model is set. Open Settings or run the first-launch tour to pick one.', meta: { error: true } });
      return;
    }
    set({ busy: true, liveContent: '', liveThinking: '', liveTools: [] });
    const recall = lastUser ? await recallFor(lastUser.content, threadId) : [];
    let sys = strictRetry
      ? PLANNER_SYSTEM_PROMPT + '\n\nIMPORTANT: The user wants you to DO something. You MUST output a single fenced ```json block with summary + steps. Do NOT output prose-only. If unsure, emit a single-step plan of type "note" explaining what you would need.'
      : PLANNER_SYSTEM_PROMPT;
    const block = formatRecall(recall);
    if (block) sys += `\n\nRECALLED CONTEXT (excerpts from earlier saved conversations that look related; use if helpful):\n${block}`;
    const info = findModel(get().modelInfo, agentModel);
    const { kept } = fitContext(history.filter(m => !m.meta?.error), contextBudgetChars(agentModel, info, s.modelParams));
    const id = streamId();
    activeStream = id;
    try {
      const rp = resolveParams(agentModel, info, undefined, s.modelParams);
      const r = await window.api.ollama.chat({
        baseUrl: s.ollamaUrl, model: agentModel,
        messages: [{ role: 'system', content: sys }, ...kept.map(m => ({ role: m.role, content: m.content }))],
        stream: true, options: rp.options, streamId: id
      });
      if (r.error && !r.content) throw new Error(r.error);
      const parsed = parsePlan(r.content);
      const asst: ChatMsg = {
        role: 'assistant', content: r.content, parsed,
        meta: { agent: true, backend: 'agent', model: agentModel, planOk: parsed.ok, steps: parsed.plan?.steps?.length ?? 0, recalled: recall.length || undefined }
      };
      await deliver(myGen, threadId, asst);
      if (gen === myGen && parsed.ok && parsed.plan && get().autoApprove) {
        setTimeout(() => { if (gen === myGen) void get().runPlan(history.length, parsed.plan!); }, 50);
      }
    } catch (e: any) {
      await deliver(myGen, threadId, { role: 'assistant', content: `Error talking to Ollama: ${e?.message ?? e}`, meta: { error: true } });
    } finally {
      if (activeStream === id) activeStream = null;
    }
  }

  async function executeStep(step: PlanStep, onChunk: (s: string) => void): Promise<{ ok: boolean; tail?: string }> {
    const s = settings();
    try {
      switch (step.type) {
        case 'note':
          onChunk(step.text);
          return { ok: true };
        case 'openTab': {
          // Tolerate plans that still use pre-merge tab names.
          const map: Record<string, string> = { cli: 'console', terminal: 'console', assistant: 'chat' };
          const t = map[step.tab] ?? step.tab;
          useUI.getState().setTab(t as any);
          onChunk(`Switched to ${t} tab.`);
          return { ok: true };
        }
        case 'setSetting':
          await useSettings.getState().save({ [step.key]: step.value });
          onChunk(`Saved ${step.key} = ${JSON.stringify(step.value)}`);
          return { ok: true };
        case 'pullModel': {
          const id = `agent:${Date.now()}:${step.model}`;
          let lastPct = -1;
          const off = window.api.ollama.onPullProgress(ev => {
            if (ev.id !== id) return;
            if (ev.total && ev.completed) {
              const pct = Math.round((ev.completed / ev.total) * 100);
              if (pct !== lastPct) { lastPct = pct; onChunk(`\r${ev.status ?? 'pulling'} ${pct}%`); }
            } else if (ev.status) {
              onChunk(`\n${ev.status}`);
            }
            if (ev.error) onChunk(`\nERROR: ${ev.error}`);
          });
          try {
            const r = await window.api.ollama.pull({ baseUrl: s.ollamaUrl, model: step.model, id });
            if (r.ok) void get().refreshModels(s.ollamaUrl);
            return { ok: !!r.ok, tail: r.error };
          } finally {
            off(); // always unsubscribe, even if the pull throws
          }
        }
        case 'addMcpServer': {
          const existing = s.mcpServers ?? [];
          const next = [...existing.filter((x: any) => x.name !== step.name), { name: step.name, command: step.command, args: step.args ?? [], env: step.env ?? {}, enabled: true }];
          await useSettings.getState().save({ mcpServers: next });
          onChunk(`MCP server "${step.name}" saved.`);
          return { ok: true };
        }
        case 'webFetch': {
          try {
            const res = await fetch(step.url);
            const text = await res.text();
            onChunk(text.slice(0, 1500));
            return { ok: res.ok };
          } catch (e: any) { return { ok: false, tail: e.message }; }
        }
        case 'searchHistory': {
          const hits = await window.api.threads.search({ query: step.query, k: 6, excludeThreadId: get().threadId });
          onChunk(hits.length ? formatRecall(hits, 2400) : 'No matching history found.');
          return { ok: true };
        }
        case 'shell': {
          return await new Promise((resolve) => {
            window.api.runner.start({ backend: 'shell', binary: step.command, args: step.args ?? [], cwd: step.cwd })
              .then(({ id }) => {
                const off = window.api.runner.onEvent(ev => {
                  if (ev.id !== id) return;
                  if (ev.kind === 'stdout' || ev.kind === 'stderr') onChunk(ev.data);
                  if (ev.kind === 'exit') { off(); resolve({ ok: ev.data === 0, tail: `\n[exit ${ev.data}]` }); }
                  if (ev.kind === 'error') { off(); resolve({ ok: false, tail: `\n[error: ${ev.data}]` }); }
                });
              })
              .catch((e: any) => resolve({ ok: false, tail: `\n[error: ${e?.message ?? e}]` }));
          });
        }
      }
    } catch (e: any) {
      return { ok: false, tail: e.message };
    }
  }

  return {
    hydrated: false,
    threadId: null,
    title: '',
    msgs: [],
    runs: {},
    agent: false,
    backend: 'auto',
    model: '',
    input: '',
    images: [],
    busy: false,
    liveContent: '',
    liveThinking: '',
    liveTools: [],
    metrics: null,
    runningPlan: null,
    autoApprove: false,
    modelInfo: [],

    hydrate: async () => {
      if (get().hydrated) return;
      const s = settings();
      set({ hydrated: true, model: get().model || s.chatModel || 'llama3.2', input: get().input || ls.get(DRAFT_KEY) || '' });
      void get().refreshModels(s.ollamaUrl);
      const id = ls.get(ACTIVE_KEY);
      // A prompt handed over before hydration (palette, Prompts tab) wins over restoring.
      if (id && !get().threadId && !get().msgs.length) await get().openThread(id);
    },

    newChat: () => {
      gen++;
      activeStream = null;
      liveMetrics = null;
      ls.set(ACTIVE_KEY, null);
      set({ threadId: null, title: '', msgs: [], runs: {}, busy: false, liveContent: '', liveThinking: '', liveTools: [], metrics: null, runningPlan: null, images: [] });
    },

    openThread: async (id) => {
      let t: Awaited<ReturnType<typeof window.api.threads.get>> = null;
      try { t = await window.api.threads.get(id); } catch { t = null; }
      if (!t) { if (ls.get(ACTIVE_KEY) === id) ls.set(ACTIVE_KEY, null); return false; }
      gen++;
      activeStream = null;
      liveMetrics = null;
      const msgs = t.messages.map(toChatMsg);
      const backend = BACKENDS.includes(t.thread.backend as ChatBackend) ? (t.thread.backend as ChatBackend) : 'auto';
      set({
        threadId: t.thread.id, title: t.thread.title, msgs, runs: runsFrom(msgs),
        agent: !!t.thread.agent, backend, model: t.thread.model || get().model,
        busy: false, liveContent: '', liveThinking: '', liveTools: [], metrics: null, runningPlan: null, images: []
      });
      ls.set(ACTIVE_KEY, t.thread.id);
      return true;
    },

    forgetThread: (id) => {
      if (!id || get().threadId === id) get().newChat();
    },

    refreshModels: async (baseUrl) => {
      try {
        const r = await window.api.ollama.modelInfo(baseUrl ?? settings().ollamaUrl);
        // A failed probe (Ollama busy or briefly down) must not blank a list we already have.
        if (!r.error) set({ modelInfo: r.models ?? [] });
        return r.error ?? null;
      } catch (e: any) {
        return e?.message || 'failed to reach Ollama';
      }
    },

    setAgent: (v) => { set({ agent: v }); syncThread({ agent: v }); },
    setBackend: (v) => { set({ backend: v }); syncThread({ backend: v }); },
    setModel: (v) => { set({ model: v }); syncThread({ model: v }); },
    setInput: (v) => { set({ input: v }); ls.set(DRAFT_KEY, v || null); },
    setImages: (v) => set(s => ({ images: typeof v === 'function' ? v(s.images) : v })),
    setAutoApprove: (v) => set({ autoApprove: v }),

    handleChunk: (c) => {
      if (!c || !activeStream || c.id !== activeStream) return;
      if (c.delta) {
        if (liveMetrics) liveMetrics = recordDelta(liveMetrics, c.delta);
        set(s => ({ liveContent: s.liveContent + c.delta, metrics: liveMetrics ?? s.metrics }));
      }
      if (c.thinking) set(s => ({ liveThinking: s.liveThinking + c.thinking }));
      if (c.tool) {
        const q = c.tool.args?.query ?? c.tool.args?.thread_id ?? '';
        set(s => ({ liveTools: [...s.liveTools, `${c.tool.name}${q ? `: ${q}` : ''}`] }));
      }
    },

    send: async () => {
      const st = get();
      if (st.busy) return;
      if (!st.input.trim() && st.images.length === 0) return;
      if (st.agent) {
        const myGen = gen;
        const userMsg: ChatMsg = { role: 'user', content: st.input };
        const next = [...st.msgs, userMsg];
        set({ msgs: next, input: '', busy: true });
        ls.set(DRAFT_KEY, null);
        try {
          const threadId = await ensureThread(userMsg.content);
          userMsg.id = await saveMessage(threadId, userMsg);
        } catch { /* runPlanner reports a save failure */ }
        if (gen !== myGen) return;
        await runPlanner(next);
      } else {
        await sendChat();
      }
    },

    runPlan: async (turnIdx, plan) => {
      const myGen = gen;
      const threadId = get().threadId;
      set({ runningPlan: turnIdx });
      const results: { step: PlanStep; status: StepStatus; output: string }[] = [];
      const saved: Record<string, StepRun> = {};
      for (let i = 0; i < plan.steps.length; i++) {
        const key = `${turnIdx}:${i}`;
        let acc = '';
        const show = (status: StepStatus) => { if (gen === myGen) set(s => ({ runs: { ...s.runs, [key]: { status, output: acc } } })); };
        show('running');
        const res = await executeStep(plan.steps[i], (chunk) => { acc += chunk; show('running'); });
        acc += res.tail ?? '';
        const status: StepStatus = res.ok ? 'ok' : 'error';
        show(status);
        saved[String(i)] = { status, output: acc.slice(-4000) };
        results.push({ step: plan.steps[i], status, output: acc });
        if (!res.ok) break;
      }
      // Keep the step outcomes with the plan message so they are still there after a restart.
      const planMsg = get().msgs[turnIdx];
      if (gen === myGen && planMsg?.id != null) {
        const meta = { ...(planMsg.meta ?? {}), runs: saved };
        window.api.threads.setMeta(planMsg.id, meta).catch(() => { /* best-effort */ });
        set(s => ({ msgs: s.msgs.map((m, i) => i === turnIdx ? { ...m, meta } : m) }));
      }
      if (gen !== myGen) return;
      set({ runningPlan: null });
      const recap = results.map((r, i) => {
        // Lookups are the point of the step, so pass more of them back than a command's tail.
        const keep = r.step.type === 'searchHistory' || r.step.type === 'webFetch' ? 2400 : 300;
        return `Step ${i + 1} (${r.step.type}): ${r.status.toUpperCase()}` + (r.output ? `\n  output: ${r.output.slice(-keep)}` : '');
      }).join('\n');
      const followUp: ChatMsg = { role: 'user', content: `[plan-results]\n${recap}\n\nWhat should I do next?` };
      const next = [...get().msgs.slice(0, turnIdx + 1), followUp];
      set({ msgs: next });
      if (threadId) {
        try { await window.api.threads.truncate(threadId, turnIdx + 1); } catch { /* best-effort */ }
        followUp.id = await saveMessage(threadId, followUp);
      }
      if (gen !== myGen) return;
      await runPlanner(next);
    },

    retryAsPlan: async (turnIdx) => {
      const st = get();
      const sliced = st.msgs.slice(0, turnIdx);
      const runs = Object.fromEntries(Object.entries(st.runs).filter(([k]) => Number(k.split(':')[0]) < turnIdx));
      set({ msgs: sliced, runs });
      if (st.threadId) { try { await window.api.threads.truncate(st.threadId, turnIdx); } catch { /* best-effort */ } }
      await runPlanner(sliced, true);
    }
  };
});
