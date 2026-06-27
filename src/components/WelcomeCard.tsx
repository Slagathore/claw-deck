import React, { useEffect, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import { type RunningModel } from '../lib/vram';

const DISMISS_KEY = 'clawdeck:welcome:dismissed';

interface Props {
  models: string[];
  running: RunningModel[];
}

/**
 * First-run "Getting Started" card shown above the Chat input. Self-dismissing
 * once the user clicks "Got it", and auto-collapses once they have:
 *   - configured Ollama URL + chat model
 *   - at least one chat model pulled (visible in models[])
 *   - at least one history turn
 *
 * Stored in localStorage so it survives between sessions.
 */
export default function WelcomeCard({ models, running }: Props) {
  const { data: s } = useSettings();
  const setTab = useUI(u => u.setTab);
  const [dismissed, setDismissed] = useState<boolean>(() => {
    try { return localStorage.getItem(DISMISS_KEY) === '1'; } catch { return false; }
  });
  const [historyCount, setHistoryCount] = useState<number>(0);

  useEffect(() => {
    if (dismissed) return;
    window.api.history.list({ limit: 1 }).then(r => setHistoryCount((r ?? []).length));
  }, [dismissed]);

  if (dismissed) return null;

  const hasOllamaUrl = !!(s.ollamaUrl && s.ollamaUrl.startsWith('http'));
  const hasChatModel = !!s.chatModel;
  const hasPulledModel = models.length > 0;
  const hasRunning = running.length > 0;
  const hasHistory = historyCount > 0;
  const allDone = hasOllamaUrl && hasChatModel && hasPulledModel && hasHistory;

  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, '1'); } catch { /* ignore */ }
    setDismissed(true);
  }

  const Step = ({ done, children, onClick }: { done: boolean; children: React.ReactNode; onClick?: () => void }) => (
    <li style={{ marginBottom: 4 }}>
      <span style={{ color: done ? '#5dd39e' : '#888', marginRight: 6 }}>{done ? '✓' : '○'}</span>
      {onClick ? <a href="#" onClick={e => { e.preventDefault(); onClick(); }}>{children}</a> : children}
    </li>
  );

  return (
    <div className="card" style={{ borderLeft: '3px solid #6aa9ff' }}>
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <strong>Welcome to Claw Deck</strong>
          <div className="label" style={{ marginTop: 4 }}>
            Local-first GUI for chatting with models running in Ollama, plus a hardened upgrade pipeline.
            {allDone && ' You\'re all set — dismiss this card to free up space.'}
          </div>
          <ol style={{ margin: '8px 0 0 0', paddingLeft: 18 }}>
            <Step done={hasOllamaUrl} onClick={() => setTab('settings')}>
              Set <b>Ollama URL</b> in Settings (default: <code>http://localhost:11434</code>)
            </Step>
            <Step done={hasPulledModel}>
              Pull a model in any terminal — e.g. <code>ollama pull llama3</code> — then it shows in the dropdown above
            </Step>
            <Step done={hasChatModel} onClick={() => setTab('settings')}>
              Set a default <b>chat model</b> in Settings (so Auto-route works)
            </Step>
            <Step done={hasRunning}>
              Send your first message — Ollama loads the model into VRAM lazily. The header shows live VRAM use.
            </Step>
            <Step done={hasHistory} onClick={() => setTab('history')}>
              Anything you send shows up in History — branch (↳) to reuse a prompt
            </Step>
          </ol>
          <div className="label" style={{ marginTop: 8 }}>
            Tips: <span className="kbd">Ctrl</span>+<span className="kbd">K</span> opens the command palette ·
            type <code>/vision</code>, <code>/reason</code>, or <code>/chat</code> in the input to force a backend ·
            attach an image and Auto switches to your vision model.
          </div>
        </div>
        <button onClick={dismiss} title="Hide this welcome card">Got it</button>
      </div>
    </div>
  );
}
