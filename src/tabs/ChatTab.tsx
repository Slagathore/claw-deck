import React, { useEffect, useRef, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import { useChat, type ChatBackend, type StepRun } from '../store/chat';
import { view, formatView } from '../lib/metrics';
import { summarizeRunning, type RunningModel } from '../lib/vram';
import { type Plan, describeStep, isDestructive } from '../lib/planner';
import { capLabels } from '../lib/modelSlots';
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

/**
 * Unified Chat: plain chat plus an in-tab "Agent mode". The conversation itself
 * lives in the chat store (src/store/chat.ts), which saves every message to the
 * thread store, so leaving this tab, closing the app, or restarting the PC all
 * come back to the same thread. This component is only the view.
 */
export default function ChatTab() {
  const { data: s } = useSettings();
  const consumePending = useUI(u => u.consumePending);
  const chat = useChat();
  const {
    agent, backend, model, input, msgs, images, busy, liveThinking, liveContent, liveTools,
    metrics, autoApprove, runs, runningPlan, modelInfo, title, threadId
  } = chat;
  const { setAgent, setBackend, setModel, setInput, setImages, setAutoApprove, send, runPlan, retryAsPlan, newChat, refreshModels } = chat;

  const [region, setRegion] = useState<string | null>(null);
  const [running, setRunning] = useState<RunningModel[]>([]);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [placeholderIdx, setPlaceholderIdx] = useState(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Models that can hold a conversation (embedding-only models are left out of the picker).
  const chatModels = modelInfo.filter(m => m.capabilities.includes('completion') || !m.capabilities.includes('embedding'));
  const models = chatModels.map(m => m.name);
  const optionLabel = (name: string) => {
    const info = modelInfo.find(m => m.name === name);
    const caps = info ? capLabels(info).filter(c => c !== 'chat') : [];
    return caps.length ? `${name}  ·  ${caps.join(', ')}` : name;
  };

  // Consume a prompt branched in from History / Prompts / palette (with agent intent).
  useEffect(() => {
    const p = consumePending();
    if (!p) return;
    if (p.agent) setAgent(true);
    if (p.prompt) setInput(p.prompt);
  }, [consumePending, setAgent, setInput]);

  const loadModels = () => refreshModels(s.ollamaUrl).then(err => setOllamaError(err));
  useEffect(() => { loadModels(); }, [s.ollamaUrl]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Jump straight to the end when the tab (re)opens on an existing thread, then follow new output.
  const firstScroll = useRef(true);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: firstScroll.current ? 'auto' : 'smooth' });
    firstScroll.current = false;
  }, [msgs, liveContent]);

  const agentModel = s.reasoningModel || model || s.chatModel;

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
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <label
          className={`badge ${agent ? 'ok' : ''}`}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '4px 10px', whiteSpace: 'nowrap' }}
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
        <select value={model} onChange={e => setModel(e.target.value)} style={{ minWidth: 220 }} title="Model used when the backend is not Auto. The words after the name are what the model can do.">
          <option value={model}>{optionLabel(model)}</option>
          {models.filter(m => m !== model).map(m => <option key={m} value={m}>{optionLabel(m)}</option>)}
        </select>
        <button
          onClick={() => { newChat(); textareaRef.current?.focus(); }}
          disabled={msgs.length === 0 && !busy}
          title="Start a fresh thread. This one stays saved in History."
          style={{ whiteSpace: 'nowrap' }}
        >
          ＋ New chat
        </button>
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
        {threadId && title && (
          <span className="label" title={`Saved thread: ${title}`} style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            💾 {title}
          </span>
        )}
        <span className="label" title="models currently loaded in Ollama VRAM" style={{ whiteSpace: 'nowrap' }}>{summarizeRunning(running)}</span>
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
          <button className="link" onClick={loadModels}>Retry</button>
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
            {m.role === 'assistant' && (m.meta?.recalled || m.meta?.tools?.length) && (
              <div className="label memory-note">
                {m.meta?.recalled ? (
                  <span title={(m.meta.recalledFrom ?? []).join('\n')}>
                    🧠 used {m.meta.recalled} excerpt{m.meta.recalled === 1 ? '' : 's'} from earlier chats
                  </span>
                ) : null}
                {(m.meta?.tools ?? []).map((t: any, j: number) => (
                  <span key={j}>🔎 {t.name}{t.args?.query ? `: ${t.args.query}` : ''}</span>
                ))}
              </div>
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
            {liveTools.map((t, j) => <div key={j} className="label">🔎 {t}</div>)}
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
