import React, { useEffect, useRef, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import {
  Plan, PlanStep, ParsedPlan, StepStatus,
  parsePlan, describeStep, isDestructive, PLANNER_SYSTEM_PROMPT
} from '../lib/planner';

interface Turn {
  role: 'user' | 'assistant';
  content: string;
  parsed?: ParsedPlan;
}

interface StepRun {
  status: StepStatus;
  output: string;
}

/**
 * Plan-and-Execute Assistant.
 *  - User types intent.
 *  - LLM responds with explanation + JSON plan.
 *  - Plan rendered as checklist; user clicks Run.
 *  - Each step executes via IPC; output streamed back into the step card.
 *  - Results are fed back to the LLM as a follow-up turn for refinement.
 */
export default function AssistantTab() {
  const { data: s, save } = useSettings();
  const setTab = useUI(u => u.setTab);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [liveContent, setLiveContent] = useState('');
  const [runs, setRuns] = useState<Record<string, StepRun>>({}); // key: `turnIdx:stepIdx`
  const [runningPlan, setRunningPlan] = useState<number | null>(null); // turn idx of plan currently executing
  const [autoApprove, setAutoApprove] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = window.api.ollama.onChunk((c: any) => {
      if (c.delta) setLiveContent(prev => prev + c.delta);
    });
    return off;
  }, []);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [turns, liveContent]);

  async function send() {
    if (!input.trim() || busy) return;
    const userTurn: Turn = { role: 'user', content: input };
    const newTurns = [...turns, userTurn];
    setTurns(newTurns);
    setInput('');
    await runPlanner(newTurns);
  }

  async function runPlanner(history: Turn[]) {
    if (!s.chatModel) {
      setTurns(t => [...t, { role: 'assistant', content: 'Error: no chat model is set. Open Settings or run the first-launch tour to pick one.' }]);
      return;
    }
    setBusy(true);
    setLiveContent('');
    const messages = [
      { role: 'system', content: PLANNER_SYSTEM_PROMPT },
      ...history.map(t => ({ role: t.role, content: t.content }))
    ];
    try {
      const r = await window.api.ollama.chat({
        baseUrl: s.ollamaUrl,
        model: s.reasoningModel || s.chatModel,    // prefer reasoning for planning when available
        messages,
        stream: true
      });
      const parsed = parsePlan(r.content);
      const asst: Turn = { role: 'assistant', content: r.content, parsed };
      setTurns(t => [...t, asst]);
      if (parsed.ok && parsed.plan && autoApprove) {
        // Defer to next tick so the new turn renders first.
        setTimeout(() => runPlan(history.length /* index of new turn = previous length */ + 0, parsed.plan!), 50);
      }
    } catch (e: any) {
      setTurns(t => [...t, { role: 'assistant', content: `Error talking to Ollama: ${e.message}` }]);
    } finally {
      setBusy(false);
      setLiveContent('');
    }
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
      if (!res.ok) break; // stop on first failure; user can retry or chat again
    }
    setRunningPlan(null);
    // Feed results back as a follow-up user turn so the LLM can react.
    const recap = results.map((r, i) =>
      `Step ${i + 1} (${r.step.type}): ${r.status.toUpperCase()}` +
      (r.output ? `\n  output: ${r.output.slice(-300)}` : '')
    ).join('\n');
    const followUp: Turn = { role: 'user', content: `[plan-results]\n${recap}\n\nWhat should I do next?` };
    const next = [...turns.slice(0, turnIdx + 1), followUp];
    setTurns(next);
    await runPlanner(next);
  }

  async function executeStep(step: PlanStep, onChunk: (s: string) => void): Promise<{ ok: boolean; tail?: string }> {
    try {
      switch (step.type) {
        case 'note':
          onChunk(step.text);
          return { ok: true };
        case 'openTab':
          setTab(step.tab as any);
          onChunk(`Switched to ${step.tab} tab.`);
          return { ok: true };
        case 'setSetting':
          await save({ [step.key]: step.value });
          onChunk(`Saved ${step.key} = ${JSON.stringify(step.value)}`);
          return { ok: true };
        case 'pullModel': {
          const id = `assistant:${Date.now()}:${step.model}`;
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
          const r = await window.api.ollama.pull({ baseUrl: s.ollamaUrl, model: step.model, id });
          off();
          return { ok: !!r.ok, tail: r.error };
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

  return (
    <div className="col" style={{ height: '100%' }}>
      <div className="card col">
        <h2 style={{ margin: 0 }}>Assistant — plan & execute</h2>
        <div className="label">
          Ask me to <em>do</em> something (install a model, set up an MCP server, check a tool version) or to
          explain how. I'll write a plan; you approve; I run each step and feed the results back to myself for the next move.
          Uses your <code>{s.reasoningModel || s.chatModel || '(no model set)'}</code> model.
        </div>
        <div className="row">
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={autoApprove} onChange={e => setAutoApprove(e.target.checked)} />
            <span className="label">Auto-approve plans (skip the Run button)</span>
          </label>
        </div>
      </div>

      <div className="card col" style={{ flex: 1, overflow: 'auto' }}>
        {turns.length === 0 && (
          <div className="col" style={{ gap: 6 }}>
            <div className="label">Try one of these:</div>
            {[
              'Install qwen2.5-coder:7b and use it as the chat model.',
              'Set up the filesystem MCP server for C:\\Users\\dev\\code_stuff.',
              'Check whether git, gh, and node are installed.',
              'Pull a small vision model and switch the vision slot to it.',
              'Explain how the upgrade gate decides whether to install a binary.'
            ].map(p => (
              <button key={p} style={{ textAlign: 'left' }} onClick={() => setInput(p)}>{p}</button>
            ))}
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i}>
            <div className={`msg ${t.role}`}>
              <div className="label" style={{ marginBottom: 4 }}>{t.role}</div>
              {/* Hide raw JSON from assistant rendering — we'll show the plan card instead */}
              {t.role === 'assistant' && t.parsed?.ok
                ? t.content.replace(/```json[\s\S]*?```/i, '').trim() || '(plan below)'
                : t.content}
            </div>
            {t.parsed?.ok && t.parsed.plan && (
              <PlanCard
                turnIdx={i}
                plan={t.parsed.plan}
                runs={runs}
                isRunning={runningPlan === i}
                onRun={() => runPlan(i, t.parsed!.plan!)}
              />
            )}
            {t.parsed && !t.parsed.ok && t.role === 'assistant' && (
              <div className="banner warn">Couldn't parse a plan: {t.parsed.error}</div>
            )}
          </div>
        ))}
        {busy && (
          <div className="msg assistant">
            {liveContent || <span className="label">…thinking</span>}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="row" style={{ alignItems: 'stretch' }}>
        <textarea
          placeholder="Ask me to do something… (Shift+Enter for newline)"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
          style={{ flex: 1 }}
        />
        <button className="primary send-btn" onClick={send} disabled={busy} style={{ width: 140 }}>
          {busy ? 'Planning…' : '▶ Ask Claw'}
        </button>
      </div>
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
