import React, { useEffect } from 'react';
import { useSettings, useUI } from './store/ui';
import ChatTab from './tabs/ChatTab';
import CliConsoleTab from './tabs/CliConsoleTab';
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
          ['chat', 'Chat / Run'],
          ['cli', 'CLI Console'],
          ['history', 'History'],
          ['prompts', 'Prompt Vault'],
          ['settings', 'Settings'],
          ['upgrades', 'OpenClaw Upgrades'],
          ['self', 'Self-Upgrade'],
          ['security', 'Security & Audit']
        ] as const).map(([k, label]) => (
          <button key={k} className={`tab-btn ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>
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
