import React, { useEffect, useRef, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import { splitThinking } from '../lib/thinking';
import { newMetrics, recordDelta, finalize, view, formatView, MetricsSnapshot } from '../lib/metrics';
import ImageUploader from '../components/ImageUploader';
import RegionSelect from '../components/RegionSelect';

type Msg = { role: 'user' | 'assistant'; content: string; images?: string[]; thinking?: string };

export default function ChatTab() {
  const { data: s } = useSettings();
  const consumePending = useUI(state => state.consumePending);
  const [backend, setBackend] = useState<'chat' | 'vision' | 'openclaw' | 'claude'>('chat');
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
  const metricsRef = useRef<MetricsSnapshot | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const p = consumePending();
    if (p) setInput(p);
  }, [consumePending]);

  useEffect(() => {
    window.api.ollama.listModels(s.ollamaUrl).then(r => setModels(r.models ?? []));
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

  async function send() {
    if (!input.trim() && images.length === 0) return;
    setBusy(true); setLiveContent(''); setLiveThinking('');
    const m0 = newMetrics();
    metricsRef.current = m0;
    setMetrics(m0);
    const userMsg: Msg = { role: 'user', content: input, images };
    const next = [...msgs, userMsg];
    setMsgs(next);
    setInput(''); setImages([]);

    try {
      let response = '';
      let thinking = '';
      if (backend === 'vision' || images.length > 0) {
        // OpenAI-compat vision path (works for Gemini-flash through Ollama OpenAI endpoint)
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
          model: backend === 'vision' ? s.visionModel : model,
          messages,
          stream: true
        });
        response = r.content;
      } else if (backend === 'chat') {
        const r = await window.api.ollama.chat({
          baseUrl: s.ollamaUrl,
          model,
          messages: next.map(m => ({ role: m.role, content: m.content })),
          stream: true
        });
        response = r.content;
        thinking = r.thinking || '';
      } else {
        response = `(${backend} CLI mode: open the CLI Console tab to start a session.)`;
      }
      const parsed = splitThinking(response);
      const asst: Msg = { role: 'assistant', content: parsed.visible || response, thinking: thinking || parsed.thinking };
      setMsgs(m => [...m, asst]);
      const finalMetrics = finalize(metricsRef.current ?? m0);
      metricsRef.current = finalMetrics;
      setMetrics(finalMetrics);
      await window.api.history.add({
        backend, model, prompt: userMsg.content, response: asst.content,
        thinking: asst.thinking,
        meta: {
          images: images.length,
          metrics: view(finalMetrics),
          snapshot: {
            ts: Date.now(),
            backend, model,
            ollamaUrl: s.ollamaUrl,
            openaiCompatUrl: backend === 'vision' ? s.openaiCompatUrl : undefined,
            visionModel: backend === 'vision' ? s.visionModel : undefined
          }
        }
      });
    } catch (e: any) {
      setMsgs(m => [...m, { role: 'assistant', content: `Error: ${e.message}` }]);
    } finally {
      setBusy(false);
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
      <div className="row">
        <select value={backend} onChange={e => setBackend(e.target.value as any)}>
          <option value="chat">Ollama Chat</option>
          <option value="vision">Vision (OpenAI-compat)</option>
          <option value="openclaw">OpenClaw CLI</option>
          <option value="claude">Claude Code CLI</option>
        </select>
        <select value={model} onChange={e => setModel(e.target.value)} style={{ minWidth: 220 }}>
          <option value={model}>{model}</option>
          {models.filter(m => m !== model).map(m => <option key={m} value={m}>{m}</option>)}
        </select>
        {s.showThinking && (liveThinking || msgs.some(m => m.thinking)) && (
          <span className="badge ok">thinking enabled</span>
        )}
        <div style={{ flex: 1 }} />
        {metrics && (
          <span className="label" title="tokens (whitespace), tokens/sec, time-to-first-token, elapsed">
            {formatView(view(metrics))}
          </span>
        )}
      </div>

      <div className="card" style={{ flex: 1, overflow: 'auto' }}>
        {msgs.length === 0 && <div className="label">No messages yet. Type below, attach images, or screenshot.</div>}
        {msgs.map((m, i) => (
          <div key={i}>
            <div className={`msg ${m.role}`}>
              <div className="label" style={{ marginBottom: 4 }}>{m.role}</div>
              {m.content}
              {m.images && m.images.length > 0 && (
                <div className="row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
                  {m.images.map((u, j) => <img key={j} src={u} className="thumb" />)}
                </div>
              )}
            </div>
            {s.showThinking && m.thinking && (
              <div className="thinking"><b>thinking:</b> {m.thinking}</div>
            )}
          </div>
        ))}
        {busy && (
          <div className="msg assistant">
            {liveContent || <span className="label">…</span>}
            {s.showThinking && liveThinking && <div className="thinking"><b>thinking:</b> {liveThinking}</div>}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <ImageUploader value={images} onChange={setImages} />
      <div className="row">
        <textarea
          placeholder="Ask something… (Shift+Enter for newline)"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }}
        />
        <div className="col" style={{ width: 180 }}>
          <button onClick={captureScreen} disabled={busy}>Screenshot</button>
          <button onClick={captureRegion} disabled={busy}>Region…</button>
          <button className="primary" onClick={send} disabled={busy}>Send</button>
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
