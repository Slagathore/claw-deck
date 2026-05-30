import React, { useEffect } from 'react';
import { useSettings, useUI } from './store/ui';
import ChatTab from './tabs/ChatTab';
import CliConsoleTab from './tabs/CliConsoleTab';
import TerminalTab from './tabs/TerminalTab';
import HistoryTab from './tabs/HistoryTab';
import PromptVaultTab from './tabs/PromptVaultTab';
import SettingsTab from './tabs/SettingsTab';
import UpgradesTab from './tabs/UpgradesTab';
import SelfUpgradeTab from './tabs/SelfUpgradeTab';
import SecurityTab from './tabs/SecurityTab';
import CommandPalette from './components/CommandPalette';

export default function App() {
  const { tab, setTab, paletteOpen, togglePalette } = useUI();
  const { load, loaded } = useSettings();

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); togglePalette();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [togglePalette]);

  if (!loaded) return <div style={{ padding: 30 }}>Loading…</div>;

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Claw Deck</h1>
        {([
          ['chat',     'Chat / Run',          'Talk to your local LLM. Auto-routes to chat / vision / reasoning models. Streaming + token/sec meter.'],
          ['cli',      'CLI Console',         'Spawn OpenClaw or Claude Code as a subprocess with live stdout streaming and per-session tabs.'],
          ['terminal', 'Terminal',            'General-purpose shell tab — PowerShell / cmd / Git Bash / WSL / custom. Supports elevation.'],
          ['history',  'History',             'Searchable log of every chat turn. Click ↳ to branch a prior prompt back into Chat.'],
          ['prompts',  'Prompt Vault',        'Reusable prompt templates with {{variable}} substitution. "Use in Chat" sends the rendered prompt to the Chat tab.'],
          ['settings', 'Settings',            'Configure Ollama URL, model names, CLI paths, upgrade policy, signing keys, MCP servers, etc.'],
          ['upgrades', 'OpenClaw Upgrades',   'Install/update OpenClaw releases through the hardened gate (allowlist → hash → signature → AV+YARA → VirusTotal).'],
          ['self',     'Self-Upgrade',        'Check for Claw Deck updates from your configured GitHub release feed; same gate as above.'],
          ['security', 'Security & Audit',    'Append-only, hash-chained ledger of every install / scan decision. Tamper-evident.']
        ] as const).map(([k, label, hint]) => (
          <button key={k} className={`tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)} title={hint}>
            {label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <div className="label" style={{ padding: '6px 8px' }}>
          <span className="kbd">Ctrl</span> + <span className="kbd">K</span> palette
        </div>
      </aside>
      <main className="main">
        {tab === 'chat' && <ChatTab />}
        {tab === 'cli' && <CliConsoleTab />}
        {tab === 'terminal' && <TerminalTab />}
        {tab === 'history' && <HistoryTab />}
        {tab === 'prompts' && <PromptVaultTab />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'upgrades' && <UpgradesTab kind="openclaw" title="OpenClaw Upgrades" />}
        {tab === 'self' && <SelfUpgradeTab />}
        {tab === 'security' && <SecurityTab />}
      </main>
      {paletteOpen && <CommandPalette onClose={togglePalette} />}
    </div>
  );
}
