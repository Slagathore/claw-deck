import React, { useEffect, useState } from 'react';
import { useSettings, useUI } from '../store/ui';
import { formatBytes, type RunningModel, totalVram } from '../lib/vram';

/**
 * Persistent status bar at the bottom of the app. Shows live system state
 * so users always know whether the backend is healthy without digging.
 */
export default function StatusBar() {
  const { data: s } = useSettings();
  const setTab = useUI(u => u.setTab);
  const [ollamaOk, setOllamaOk] = useState<boolean | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [running, setRunning] = useState<RunningModel[]>([]);
  const [mcpCount, setMcpCount] = useState<number>(0);
  const [mcpRunning, setMcpRunning] = useState<number>(0);
  const [version, setVersion] = useState<string>('');

  useEffect(() => {
    window.api.app.version().then(v => setVersion(typeof v === 'string' ? v : v?.version ?? ''));
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function poll() {
      try {
        const r = await window.api.ollama.listModels(s.ollamaUrl);
        if (cancelled) return;
        setOllamaOk(true);
        setModels(r.models ?? []);
      } catch {
        if (cancelled) return;
        setOllamaOk(false);
        setModels([]);
      }
      try {
        const r = await window.api.ollama.ps(s.ollamaUrl);
        if (!cancelled) setRunning(r.running ?? []);
      } catch { /* ignore */ }
      try {
        const list = await window.api.mcp.list();
        if (!cancelled) {
          setMcpCount(list.length);
          setMcpRunning(list.filter((m: any) => m.running || m.pid).length);
        }
      } catch { /* ignore */ }
    }
    poll();
    const t = setInterval(poll, 6000);
    return () => { cancelled = true; clearInterval(t); };
  }, [s.ollamaUrl]);

  const vramText = running.length > 0 ? formatBytes(totalVram(running)) : null;

  return (
    <footer className="statusbar">
      <span
        className="item clickable"
        onClick={() => setTab('settings')}
        title={ollamaOk ? `Ollama reachable at ${s.ollamaUrl}` : `Ollama not reachable at ${s.ollamaUrl} — click to fix in Settings`}
      >
        <span className={`ledge ${ollamaOk === null ? 'warn' : ollamaOk ? 'ok' : 'bad'}`} />
        Ollama {ollamaOk === null ? '…' : ollamaOk ? 'OK' : 'down'}
      </span>
      <span className="item" title="Models pulled in Ollama">
        {models.length} model{models.length === 1 ? '' : 's'}
      </span>
      {running.length > 0 && (
        <span
          className="item clickable"
          onClick={async () => {
            if (confirm(`Unload all ${running.length} model(s) from VRAM?`)) {
              for (const m of running) await window.api.ollama.stop({ baseUrl: s.ollamaUrl, model: m.name });
            }
          }}
          title={`${running.map(r => r.name).join(', ')} — click to unload all from VRAM`}
        >
          ▶ {running.length} loaded · {vramText} VRAM
        </span>
      )}
      <span
        className="item clickable"
        onClick={async () => {
          const r = await window.api.mcp.startAll();
          console.log('startAll', r);
        }}
        title="Start every enabled MCP server"
      >
        MCP: {mcpRunning}/{mcpCount}
      </span>
      <span className="spacer" />
      {s.airgapped && <span className="item" title="Air-gapped mode: upgrade downloads blocked">🔒 air-gapped</span>}
      <span className="item" title="Open the command palette">
        <span className="kbd">Ctrl</span>+<span className="kbd">K</span>
      </span>
      {version && <span className="item" title="Claw Deck version">v{version}</span>}
    </footer>
  );
}
