import React, { useEffect, useRef, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import { splitThinking } from '../lib/thinking';
import { newMetrics, recordDelta, finalize, view, formatView, type MetricsSnapshot } from '../lib/metrics';
import { routeRequest } from '../lib/router';
import { summarizeRunning, type RunningModel } from '../lib/vram';
import {
  type Plan, type PlanStep, type ParsedPlan, type StepStatus,
  parsePlan, describeStep, isDestructive, PLANNER_SYSTEM_PROMPT
} from '../lib/planner';
import ImageUploader from '../components/ImageUploader';
import RegionSelect from '../components/RegionSelect';
import WelcomeCard from '../components/WelcomeCard';
import QuickstartCards from '../components/QuickstartCards';
import SlashMenu from '../components/SlashMenu';

const PLACEHOLDERS = [
  'Ask something… (Shift+Enter for newline)',
  'Try: "Summarize this code: …"',
  'Try: "/vision describe this screenshot"',
  'Try: "/reason solve this puzzle: …"',
  'Tip: paste an image to auto-route to vision'
];

const AGENT_EXAMPLES = [
  'Install qwen2.5-coder:7b and use it as the chat model.',
  'Set up the filesystem MCP server for C:\\Projects.',
  'Check whether git, gh, and node are installed.',
  'Pull a small vision model and switch the vision slot to it.',
  'Explain how the upgrade gate decides whether to install a binary.'
];

type Msg = {
  role: 'user' | 'assistant';
  content: string;
  images?: string[];
  thinking?: string;
  parsed?: ParsedPlan;          // present for assistant turns produced in Agent mode
};

interface StepRun { status: StepStatus; output: string; }

/**
 * Unified Chat — plain chat plus an in-tab "Agent mode" (the former Assistant
 * tab). Agent mode prompts the model for a JSON plan, renders it as an
 * approve-and-run checklist, executes each step via IPC, and feeds the results
 * back to the model for the next move.
 */
export default function ChatTab() {
  const { data: s, save } = useSettings();
  const setTab = useUI(u => u.setTab);
  const consumePending = useUI(u => u.consumePending);

  const [agent, setAgent] = useState(false);
  const [backend, setBackend] = useState<'auto' | 'chat' | 'vision' | 'openclaw' | 'claude'>('auto');
  const [model, setModel] = useState<string>(s.chatModel || 'llama3.2');
  const [models, setModels] = useState<string[]>([]);
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [images, setImages] = useState<string[]>([]);  // base64 data URLs
  const [busy, setBusy] = useState(false);
  const [liveThinking, setLiveThinking] = useState('');
  const [liveContent, setLiveContent] = useState('');
  const [metrics, setMetrics] = useState<MetricsSnapshot | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [running, setRunning] = useState<RunningModel[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  // Agent-mode state.
  const [autoApprove, setAutoApprove] = useState(false);
  const [runs, setRuns] = useState<Record<string, StepRun>>({}); // key: `turnIdx:stepIdx`
  const [runningPlan, setRunningPlan] = useState<number | null>(null);
  const metricsRef = useRef<MetricsSnapshot | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Consume a prompt branched in from History / Prompts / palette (with agent intent).
  useEffect(() => {
    const p = consumePending();
    if (!p) return;
    if (p.agent) setAgent(true);
    if (p.prompt) setInput(p.prompt);
  }, [consumePending]);

  useEffect(() => {
    window.api.ollama.listModels(s.ollamaUrl)
      .then(r => { setModels(r.models ?? []); setOllamaError(null); })
      .catch(e => setOllamaError(e?.message || 'failed to reach Ollama'));
  }, [s.ollamaUrl]);

  // Rotate placeholder hints every 5s while input is empty.
  useEffect(() => {
    if (input.length > 0 || msgs.length > 0) return;
    const t = setInterval(() => setPlaceholderIdx(i => (i + 1) % PLACEHOLDERS.length), 5000);
    return () => clearInterval(t);
  }, [input, msgs.length]);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      const r = await window.api.ollama.ps(s.ollamaUrl);
      if (!cancelled) setRunning(r.running ?? []);
    }
    poll();
    const t = setInterval(poll, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [s.ollamaUrl]);

  useEffect(() => {
    const off = window.api.ollama.onChunk((c: any) => {
      if (c.delta) {
        setLiveContent(prev => prev + c.delta);
        if (metricsRef.current) {
          const next = recordDelta(metricsRef.current, c.delta);
          metricsRef.current = next;
          setMetrics(next);
        }
      }
      if (c.thinking) setLiveThinking(prev => prev + c.thinking);
    });
    return off;
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [msgs, liveContent]);

  // ---- plain chat send -----------------------------------------------------

  async function sendChat() {
    setBusy(true); setLiveContent(''); setLiveThinking('');
    const m0 = newMetrics();
    metricsRef.current = m0;
    setMetrics(m0);

    let resolvedBackend: 'chat' | 'vision' | 'openclaw' | 'claude';
    let resolvedModel: string;
    let cleanedPrompt = input;
    let routeReason: string | undefined;
    if (backend === 'auto') {
      const routed = routeRequest({
        prompt: input, imageCount: images.length,
        settings: { chatModel: s.chatModel, reasoningModel: s.reasoningModel, visionModel: s.visionModel }
      });
      cleanedPrompt = routed.cleanedPrompt;
      routeReason = routed.reason;
      resolvedBackend = routed.backend === 'reasoning' ? 'chat' : routed.backend;
      resolvedModel = routed.model;
    } else {
      resolvedBackend = backend;
      resolvedModel = model;
    }

    const userMsg: Msg = { role: 'user', content: cleanedPrompt, images };
    const next = [...msgs, userMsg];
    setMsgs(next);
    setInput(''); setImages([]);

    try {
      let response = '';
      let thinking = '';
      if (resolvedBackend === 'vision' || (resolvedBackend !== 'openclaw' && resolvedBackend !== 'claude' && images.length > 0)) {
        const messages = next.map(m => {
          if (m.images && m.images.length > 0) {
            return {
              role: m.role,
              content: [
                { type: 'text', text: m.content || 'Describe the image(s).' },
                ...m.images.map(url => ({ type: 'image_url', image_url: { url } }))
              ]
            };
          }
          return { role: m.role, content: m.content };
        });
        const r = await window.api.ollama.vision({
          openaiCompatUrl: s.openaiCompatUrl,
          apiKey: s.openaiCompatKey,
          model: resolvedBackend === 'vision' ? s.visionModel : resolvedModel,
          messages,
          stream: true
        });
        response = r.content;
      } else if (resolvedBackend === 'chat') {
        const r = await window.api.ollama.chat({
          baseUrl: s.ollamaUrl,
          model: resolvedModel,
          messages: next.map(m => ({ role: m.role, content: m.content })),
          stream: true
        });
        response = r.content;
        thinking = r.thinking || '';
      } else {
        response = `(${resolvedBackend} CLI mode: open the Console tab to start a session.)`;
      }
      const parsed = splitThinking(response);
      const asst: Msg = { role: 'assistant', content: parsed.visible || response, thinking: thinking || parsed.thinking };
      setMsgs(m => [...m, asst]);
      const finalMetrics = finalize(metricsRef.current ?? m0);
      metricsRef.current = finalMetrics;
      setMetrics(finalMetrics);
      await window.api.history.add({
        backend: resolvedBackend, model: resolvedModel, prompt: userMsg.content, response: asst.content,
        thinking: asst.thinking,
        meta: {
          images: images.length,
          metrics: view(finalMetrics),
          routed: backend === 'auto' ? routeReason : undefined,
          snapshot: {
            ts: Date.now(),
            backend: resolvedBackend, model: resolvedModel,
            ollamaUrl: s.ollamaUrl,
            openaiCompatUrl: resolvedBackend === 'vision' ? s.openaiCompatUrl : undefined,
            visionModel: resolvedBackend === 'vision' ? s.visionModel : undefined
          }
        }
      });
    } catch (e: any) {
      setMsgs(m => [...m, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  }

  // ---- agent (plan & execute) ----------------------------------------------

  function send() {
    if (!input.trim() && images.length === 0) return;
    if (busy) return;
    if (agent) {
      const userMsg: Msg = { role: 'user', content: input };
      const next = [...msgs, userMsg];
      setMsgs(next);
      setInput('');
      runPlanner(next);
    } else {
      sendChat();
    }
  }

  const agentModel = s.reasoningModel || model || s.chatModel;

  async function runPlanner(history: Msg[], strictRetry: boolean = false) {
    if (!agentModel) {
      setMsgs(t => [...t, { role: 'assistant', content: 'Error: no chat model is set. Open Settings or run the first-launch tour to pick one.' }]);
      return;
    }
    setBusy(true);
    setLiveContent('');
    const sys = strictRetry
      ? PLANNER_SYSTEM_PROMPT + '\n\nIMPORTANT: The user wants you to DO something. You MUST output a single fenced ```json block with summary + steps. Do NOT output prose-only. If unsure, emit a single-step plan of type "note" explaining what you would need.'
      : PLANNER_SYSTEM_PROMPT;
    const messages = [
      { role: 'system', content: sys },
      ...history.map(t => ({ role: t.role, content: t.content }))
    ];
    try {
      const r = await window.api.ollama.chat({ baseUrl: s.ollamaUrl, model: agentModel, messages, stream: true });
      const parsed = parsePlan(r.content);
      const asst: Msg = { role: 'assistant', content: r.content, parsed };
      setMsgs(t => [...t, asst]);
      // Record the agent turn in History (skip the auto plan-results follow-ups).
      const lastUser = [...history].reverse().find(m => m.role === 'user');
      if (lastUser && !lastUser.content.startsWith('[plan-results]')) {
        window.api.history.add({
          backend: 'agent', model: agentModel,
          prompt: lastUser.content,
          response: parsed.ok && parsed.plan ? `Plan: ${parsed.plan.summary}\n\n${r.content}` : r.content,
          meta: { source: 'agent', planOk: parsed.ok, steps: parsed.plan?.steps?.length ?? 0 }
        }).catch(() => { /* best-effort */ });
      }
      if (parsed.ok && parsed.plan && autoApprove) {
        setTimeout(() => runPlan(history.length, parsed.plan!), 50);
      }
    } catch (e: any) {
      setMsgs(t => [...t, { role: 'assistant', content: `Error talking to Ollama: ${e.message}` }]);
    } finally {
      setBusy(false);
      setLiveContent('');
    }
  }

  async function retryAsPlan(turnIdx: number) {
    const sliced = msgs.slice(0, turnIdx);
    setMsgs(sliced);
    await runPlanner(sliced, true);
  }

  async function runPlan(turnIdx: number, plan: Plan) {
    setRunningPlan(turnIdx);
    const results: { step: PlanStep; status: StepStatus; output: string }[] = [];
    for (let i = 0; i < plan.steps.length; i++) {
      const key = `${turnIdx}:${i}`;
      setRuns(r => ({ ...r, [key]: { status: 'running', output: '' } }));
      const res = await executeStep(plan.steps[i], (chunk) => {
        setRuns(r => ({ ...r, [key]: { status: 'running', output: (r[key]?.output ?? '') + chunk } }));
      });
      setRuns(r => ({ ...r, [key]: { status: res.ok ? 'ok' : 'error', output: (r[key]?.output ?? '') + (res.tail ?? '') } }));
      results.push({ step: plan.steps[i], status: res.ok ? 'ok' : 'error', output: res.tail ?? '' });
      if (!res.ok) break;
    }
    setRunningPlan(null);
    const recap = results.map((r, i) =>
      `Step ${i + 1} (${r.step.type}): ${r.status.toUpperCase()}` +
      (r.output ? `\n  output: ${r.output.slice(-300)}` : '')
    ).join('\n');
    const followUp: Msg = { role: 'user', content: `[plan-results]\n${recap}\n\nWhat should I do next?` };
    const next = [...msgs.slice(0, turnIdx + 1), followUp];
    setMsgs(next);
    await runPlanner(next);
  }

  async function executeStep(step: PlanStep, onChunk: (s: string) => void): Promise<{ ok: boolean; tail?: string }> {
    try {
      switch (step.type) {
        case 'note':
          onChunk(step.text);
          return { ok: true };
        case 'openTab': {
          // Tolerate plans that still use pre-merge tab names.
          const map: Record<string, string> = { cli: 'console', terminal: 'console', assistant: 'chat' };
          const t = map[step.tab] ?? step.tab;
          setTab(t as any);
          onChunk(`Switched to ${t} tab.`);
          return { ok: true };
        }
        case 'setSetting':
          await save({ [step.key]: step.value });
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
            return { ok: !!r.ok, tail: r.error };
          } finally {
            off(); // always unsubscribe, even if the pull throws
          }
        }
        case 'addMcpServer': {
          const existing = s.mcpServers ?? [];
          const next = [...existing.filter((x: any) => x.name !== step.name), { name: step.name, command: step.command, args: step.args ?? [], env: step.env ?? {}, enabled: true }];
          await save({ mcpServers: next });
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
              });
          });
        }
      }
    } catch (e: any) {
      return { ok: false, tail: e.message };
    }
  }

  async function captureScreen() {
    const r = await window.api.screenshot.captureScreen();
    if (r.dataUrl) setImages(imgs => [...imgs, r.dataUrl!]);
  }

  async function captureRegion() {
    const r = await window.api.screenshot.captureScreen();
    if (r.dataUrl) setRegion(r.dataUrl);
  }

  return (
    <div className="col" style={{ height: '100%' }}>
      <WelcomeCard models={models} running={running} />
      <div className="row">
        <label
          className={`badge ${agent ? 'ok' : ''}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '4px 10px' }}
          title="Agent mode: Claw writes a plan, you approve, it runs each step and feeds results back to itself."
        >
          <input type="checkbox" checked={agent} onChange={e => setAgent(e.target.checked)} />
          🤖 Agent mode
        </label>
        {!agent && (
          <select value={backend} onChange={e => setBackend(e.target.value as any)}>
            <option value="auto">Auto (route by content)</option>
            <option value="chat">Ollama Chat</option>
            <option value="vision">Vision (OpenAI-compat)</option>
            <option value="openclaw">OpenClaw CLI</option>
            <option value="claude">Claude Code CLI</option>
          </select>
        )}
        <select value={model} onChange={e => setModel(e.target.value)} style={{ minWidth: 220 }}>
          <option value={model}>{model}</option>
          {models.filter(m => m !== model).map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        {agent && <span className="label">plans with <code>{agentModel || '(no model)'}</code></span>}
        {agent && (
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={autoApprove} onChange={e => setAutoApprove(e.target.checked)} />
            <span className="label">Auto-approve plans</span>
          </label>
        )}
        {!agent && s.showThinking && (liveThinking || msgs.some(m => m.thinking)) && (
          <span className="badge ok">thinking enabled</span>
        )}
        <div style={{ flex: 1 }} />
        <span className="label" title="models currently loaded in Ollama VRAM">{summarizeRunning(running)}</span>
        {!agent && metrics && (
          <span className="label" title="tokens (whitespace), tokens/sec, time-to-first-token, elapsed">
            {formatView(view(metrics))}
          </span>
        )}
      </div>

      {ollamaError && (
        <div className="banner">
          <span>Ollama isn't reachable at <code>{s.ollamaUrl}</code> — {ollamaError}</span>
          <button className="link" onClick={() => useUI.getState().setTab('settings')}>Fix in Settings</button>
          <button className="link" onClick={() => window.api.ollama.listModels(s.ollamaUrl).then(r => { setModels(r.models ?? []); setOllamaError(null); }).catch(e => setOllamaError(e?.message || 'failed'))}>Retry</button>
        </div>
      )}

      <div className="card" style={{ flex: 1, overflow: 'auto' }}>
        {msgs.length === 0 && !agent && (
          <QuickstartCards onPick={p => { setInput(p); textareaRef.current?.focus(); }} />
        )}
        {msgs.length === 0 && agent && (
          <div className="col" style={{ gap: 6 }}>
            <div className="label">Agent mode — ask me to <em>do</em> something. I'll plan, you approve, I run it:</div>
            {AGENT_EXAMPLES.map(p => (
              <button key={p} style={{ textAlign: 'left' }} onClick={() => setInput(p)}>{p}</button>
            ))}
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i}>
            <div className={`msg ${m.role}`}>
              <div className="label" style={{ marginBottom: 4 }}>{m.role}</div>
              {m.role === 'assistant' && m.parsed?.ok
                ? m.content.replace(/```json[\s\S]*?```/i, '').trim() || '(plan below)'
                : m.content}
              {m.images && m.images.length > 0 && (
                <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  {m.images.map((u, j) => <img key={j} src={u} className="thumb" />)}
                </div>
              )}
            </div>
            {s.showThinking && m.thinking && (
              <div className="thinking"><b>thinking:</b> {m.thinking}</div>
            )}
            {m.parsed?.ok && m.parsed.plan && (
              <PlanCard
                turnIdx={i}
                plan={m.parsed.plan}
                runs={runs}
                isRunning={runningPlan === i}
                onRun={() => runPlan(i, m.parsed!.plan!)}
              />
            )}
            {m.parsed && !m.parsed.ok && m.role === 'assistant' && m.parsed.intent === 'malformed' && (
              <div className="banner warn" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ flex: 1 }}>Couldn't parse a plan: {m.parsed.error}</span>
                <button onClick={() => retryAsPlan(i)} disabled={busy}>↻ Retry as plan</button>
              </div>
            )}
            {m.parsed && !m.parsed.ok && m.role === 'assistant' && m.parsed.intent === 'explanation' && (
              <div className="row" style={{ marginTop: 4, justifyContent: 'flex-end' }}>
                <button onClick={() => retryAsPlan(i)} disabled={busy} title="Ask the model to redo this as an executable plan">⚡ Turn this into a plan</button>
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="msg assistant">
            {liveContent || <span className="label">{agent ? '…thinking' : '…'}</span>}
            {!agent && s.showThinking && liveThinking && <div className="thinking"><b>thinking:</b> {liveThinking}</div>}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {!agent && <ImageUploader value={images} onChange={setImages} />}
      <div className="row" style={{ alignItems: 'stretch' }}>
        <div style={{ flex: 1, position: 'relative' }}>
          {!agent && (
            <SlashMenu
              query={input}
              onPick={cmd => {
                const rest = input.replace(/^\s*\S*/, '');
                setInput(cmd + (rest.startsWith(' ') ? rest : ' ' + rest.trimStart()));
                textareaRef.current?.focus();
              }}
            />
          )}
          <textarea
            ref={textareaRef}
            placeholder={agent ? 'Ask me to do something… (Shift+Enter for newline)' : PLACEHOLDERS[placeholderIdx]}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          />
        </div>
        <div className="col" style={{ width: 180 }}>
          {!agent && <button onClick={captureScreen} disabled={busy} title="Capture full screen and attach">📷 Screenshot</button>}
          {!agent && <button onClick={captureRegion} disabled={busy} title="Capture, then drag to select a region">✂️ Region…</button>}
          <button className="primary send-btn" onClick={send} disabled={busy} title="Send (Enter)">
            {busy ? (agent ? 'Planning…' : 'Sending…') : (agent ? '▶ Ask Claw' : '▶ Send')}
          </button>
        </div>
      </div>
      {region && (
        <RegionSelect
          src={region}
          onCancel={() => setRegion(null)}
          onCrop={url => { setImages(imgs => [...imgs, url]); setRegion(null); }}
        />
      )}
    </div>
  );
}

function PlanCard({ turnIdx, plan, runs, isRunning, onRun }: {
  turnIdx: number; plan: Plan; runs: Record<string, StepRun>; isRunning: boolean; onRun: () => void;
}) {
  const anyDone = plan.steps.some((_, i) => runs[`${turnIdx}:${i}`]);
  const allOk = plan.steps.every((_, i) => runs[`${turnIdx}:${i}`]?.status === 'ok');
  return (
    <div className="card col" style={{ borderLeft: '3px solid var(--accent)', marginTop: 4 }}>
      <div className="row">
        <strong>Plan</strong>
        <span className="label">{plan.summary}</span>
        <div style={{ flex: 1 }} />
        {!anyDone && (
          <button className="primary" onClick={onRun} disabled={isRunning} title="Execute every step in order">
            {isRunning ? 'Running…' : '▶ Approve & Run'}
          </button>
        )}
        {anyDone && allOk && <span className="badge ok">all steps ok</span>}
      </div>
      <ol style={{ margin: 0, paddingLeft: 18 }}>
        {plan.steps.map((s, i) => {
          const key = `${turnIdx}:${i}`;
          const r = runs[key];
          const icon = r?.status === 'ok' ? '✓' : r?.status === 'error' ? '✗' : r?.status === 'running' ? '…' : isDestructive(s) ? '⚠' : '·';
          const color = r?.status === 'ok' ? 'var(--good)' : r?.status === 'error' ? 'var(--bad)' : r?.status === 'running' ? 'var(--warn)' : 'var(--muted)';
          return (
            <li key={i} style={{ marginBottom: 6 }}>
              <span style={{ color, marginRight: 6 }}>{icon}</span>
              {describeStep(s)}
              {r?.output && (
                <pre style={{ margin: '4px 0 0 18px', padding: 6, background: 'var(--bg)', borderRadius: 4, fontSize: 11, maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>
                  {r.output.slice(-2000)}
                </pre>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
