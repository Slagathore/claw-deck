import React, { useEffect, useState } from 'react';
import { useSettings } from '../store/ui';

const ONBOARD_KEY = 'clawdeck:onboarded';
const WELCOME_KEY = 'clawdeck:welcome:dismissed';

interface Props { onClose: () => void; }

/**
 * One-time onboarding wizard shown on first launch. Walks the user through:
 *   1. Detect a running Ollama (probes a few common URLs)
 *   2. Pick a chat model from what's pulled (with hint to `ollama pull` if empty)
 *   3. Done — sets the dismiss flag so it never reappears.
 */
export default function OnboardingWizard({ onClose }: Props) {
  const { data: s, save } = useSettings();
  const [step, setStep] = useState(0);
  const [probing, setProbing] = useState(false);
  const [foundUrl, setFoundUrl] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [pickedModel, setPickedModel] = useState<string>(s.chatModel || '');
  const [error, setError] = useState<string>('');

  // Step 0: auto-probe Ollama on mount.
  useEffect(() => {
    if (step !== 0) return;
    const candidates = [s.ollamaUrl, 'http://localhost:11434', 'http://127.0.0.1:11434'].filter(Boolean);
    let cancelled = false;
    setProbing(true);
    (async () => {
      for (const url of candidates) {
        try {
          const r = await window.api.ollama.listModels(url);
          if (cancelled) return;
          setFoundUrl(url);
          setModels(r.models ?? []);
          setProbing(false);
          return;
        } catch { /* try next */ }
      }
      if (!cancelled) { setProbing(false); setFoundUrl(null); }
    })();
    return () => { cancelled = true; };
  }, [step, s.ollamaUrl]);

  // Step 1: refresh model list when we know the URL.
  useEffect(() => {
    if (step !== 1 || !foundUrl) return;
    window.api.ollama.listModels(foundUrl).then(r => setModels(r.models ?? [])).catch(() => {});
  }, [step, foundUrl]);

  function finish() {
    try { localStorage.setItem(ONBOARD_KEY, '1'); localStorage.setItem(WELCOME_KEY, '1'); } catch { /* ignore */ }
    onClose();
  }

  async function saveAndNext() {
    setError('');
    try {
      const patch: any = {};
      if (foundUrl && foundUrl !== s.ollamaUrl) patch.ollamaUrl = foundUrl;
      if (pickedModel && pickedModel !== s.chatModel) patch.chatModel = pickedModel;
      if (Object.keys(patch).length) await save(patch);
      setStep(step + 1);
    } catch (e: any) {
      setError(e.message);
    }
  }

  return (
    <div className="wizard-backdrop" onClick={e => { if (e.target === e.currentTarget) finish(); }}>
      <div className="wizard">
        <h2>Welcome to Claw Deck</h2>
        <div className="label">Three quick checks and you're chatting locally.</div>
        <div className="step-dots">
          {[0, 1, 2].map(i => <span key={i} className={i === step ? 'active' : i < step ? 'done' : ''} />)}
        </div>

        <div className="wizard-body">
          {step === 0 && (
            <div className="col">
              <h3 style={{ margin: 0 }}>1. Find Ollama</h3>
              {probing && <div className="label">Probing localhost:11434…</div>}
              {!probing && foundUrl && (
                <div className="banner info">
                  ✓ Ollama is running at <code>{foundUrl}</code>. {models.length} model{models.length === 1 ? '' : 's'} pulled.
                </div>
              )}
              {!probing && !foundUrl && (
                <>
                  <div className="banner">
                    Couldn't reach Ollama. Install from <code>ollama.com/download</code> and run it, then click Retry.
                  </div>
                  <div className="row">
                    <button onClick={() => setStep(0)}>Retry</button>
                    <button className="link" onClick={() => navigator.clipboard.writeText('ollama.com/download')}>
                      Copy URL
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {step === 1 && (
            <div className="col">
              <h3 style={{ margin: 0 }}>2. Pick a chat model</h3>
              {models.length === 0 ? (
                <div className="banner warn">
                  No models pulled yet. Open the Console tab and run a command like:
                  <br/><code>ollama pull llama3.2</code>
                  <br/>Then come back and click Refresh.
                  <div className="row" style={{ marginTop: 8 }}>
                    <button onClick={() => window.api.ollama.listModels(foundUrl ?? s.ollamaUrl).then(r => setModels(r.models ?? []))}>Refresh</button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="label">Pick the model the Chat tab should use by default.</div>
                  <select value={pickedModel} onChange={e => setPickedModel(e.target.value)}>
                    <option value="">— select —</option>
                    {models.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </>
              )}
            </div>
          )}

          {step === 2 && (
            <div className="col">
              <h3 style={{ margin: 0 }}>3. You're ready</h3>
              <div className="label">
                Tips to remember:
                <ul style={{ marginTop: 6 }}>
                  <li>Press <span className="kbd">Ctrl</span>+<span className="kbd">K</span> for the command palette.</li>
                  <li>Type <code>/vision</code>, <code>/reason</code>, or <code>/chat</code> in the input to force a backend.</li>
                  <li>Attach an image and Auto routes to your vision model.</li>
                  <li>The bottom bar always shows Ollama / VRAM / MCP state.</li>
                </ul>
              </div>
            </div>
          )}

          {error && <div className="banner">{error}</div>}
        </div>

        <div className="wizard-foot">
          <button className="link" onClick={finish}>Skip</button>
          <span className="spacer" />
          {step > 0 && <button onClick={() => setStep(step - 1)}>Back</button>}
          {step < 2 && (
            <button
              className="primary"
              onClick={saveAndNext}
              disabled={(step === 0 && !foundUrl) || (step === 1 && !pickedModel && models.length > 0)}
            >
              Next →
            </button>
          )}
          {step === 2 && <button className="primary" onClick={finish}>Get started</button>}
        </div>
      </div>
    </div>
  );
}

export function shouldShowOnboarding(): boolean {
  try { return localStorage.getItem(ONBOARD_KEY) !== '1'; } catch { return false; }
}
