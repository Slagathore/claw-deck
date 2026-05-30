import React, { useEffect, useState } from 'react';
import { useUI } from '../store/ui';

const ACTIONS = [
  { id: 'tab:chat', label: 'Go to: Chat' },
  { id: 'tab:cli', label: 'Go to: Run a CLI' },
  { id: 'tab:terminal', label: 'Go to: Terminal' },
  { id: 'tab:history', label: 'Go to: History' },
  { id: 'tab:prompts', label: 'Go to: Prompts' },
  { id: 'tab:settings', label: 'Go to: Settings' },
  { id: 'tab:upgrades', label: 'Go to: OpenClaw Upgrades' },
  { id: 'tab:self', label: 'Go to: Update Claw Deck' },
  { id: 'tab:security', label: 'Go to: Security & Audit' },
  { id: 'screenshot', label: 'Capture screenshot' },
  { id: 'onboarding', label: 'Re-run first-launch tour' }
];

export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const { setTab } = useUI();
  const filtered = ACTIONS.filter(a => a.label.toLowerCase().includes(q.toLowerCase()));

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowDown') setSel(s => Math.min(s + 1, filtered.length - 1));
      if (e.key === 'ArrowUp') setSel(s => Math.max(s - 1, 0));
      if (e.key === 'Enter') { run(filtered[sel]?.id); onClose(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [filtered, sel]);

  async function run(id?: string) {
    if (!id) return;
    if (id.startsWith('tab:')) setTab(id.slice(4) as any);
    if (id === 'screenshot') await window.api.screenshot.captureScreen();
    if (id === 'onboarding') {
      try { localStorage.removeItem('clawdeck:onboarded'); } catch { /* ignore */ }
      window.location.reload();
    }
  }

  return (
    <div className="palette">
      <input autoFocus placeholder="Type a command…" value={q} onChange={e => { setQ(e.target.value); setSel(0); }} />
      <ul>
        {filtered.map((a, i) => (
          <li key={a.id} className={i === sel ? 'sel' : ''} onMouseEnter={() => setSel(i)} onClick={() => { run(a.id); onClose(); }}>
            {a.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
