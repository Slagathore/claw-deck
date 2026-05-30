import React, { useEffect, useState } from 'react';
import { useSettings, useUI } from './store/ui';
import ChatTab from './tabs/ChatTab';
import AssistantTab from './tabs/AssistantTab';
import LibraryTab from './tabs/LibraryTab';
import CliConsoleTab from './tabs/CliConsoleTab';
import TerminalTab from './tabs/TerminalTab';
import HistoryTab from './tabs/HistoryTab';
import PromptVaultTab from './tabs/PromptVaultTab';
import SettingsTab from './tabs/SettingsTab';
import UpgradesTab from './tabs/UpgradesTab';
import SelfUpgradeTab from './tabs/SelfUpgradeTab';
import SecurityTab from './tabs/SecurityTab';
import CommandPalette from './components/CommandPalette';
import StatusBar from './components/StatusBar';
import OnboardingWizard, { shouldShowOnboarding } from './components/OnboardingWizard';

type TabDef = readonly [key: string, icon: string, label: string, hint: string];

const TABS: readonly TabDef[] = [
  ['chat',      '💬', 'Chat',           'Talk to your local LLM. Auto-routes to chat / vision / reasoning. Streaming + tokens/sec.'],
  ['assistant', '🤖', 'Assistant',      'Ask Claw to plan and execute a multi-step task (install a model, set up MCP, etc.).'],
  ['library',   '📚', 'Library',        'One-click installs: popular Ollama models, MCP servers, system tools.'],
  ['cli',       '🐚', 'Run a CLI',      'Spawn OpenClaw or Claude Code as a subprocess with live stdout streaming.'],
  ['terminal',  '⌨️', 'Terminal',       'General-purpose shell — PowerShell / cmd / Git Bash / WSL / custom. Supports UAC elevation.'],
  ['history',   '📜', 'History',        'Searchable log of every chat turn. Click ↳ to branch a prior prompt back into Chat.'],
  ['prompts',   '📋', 'Prompts',        'Reusable prompt templates with {{variable}} substitution.'],
  ['settings',  '⚙️', 'Settings',       'Configure Ollama URL, models, CLI paths, signing keys, MCP servers.'],
  ['upgrades',  '⬆️', 'OpenClaw',       'Install/update OpenClaw through the hardened gate (allowlist → hash → signature → AV+YARA → VirusTotal).'],
  ['self',      '🔄', 'Update Claw Deck','Check for Claw Deck updates from your configured GitHub release feed.'],
  ['security',  '🛡️', 'Security',       'Append-only, hash-chained ledger of every install / scan decision.']
] as const;

export default function App() {
  const { tab, setTab, paletteOpen, togglePalette } = useUI();
  const { data: s, load, loaded } = useSettings();
  const [wizardOpen, setWizardOpen] = useState(false);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (loaded && shouldShowOnboarding()) setWizardOpen(true);
  }, [loaded]);

  // Push close-to-tray pref to backend whenever it changes (default: on).
  useEffect(() => {
    if (!loaded) return;
    const enabled = s.closeToTray !== false;
    window.api.app.setCloseToTray(enabled).catch(() => { /* ignore */ });
  }, [loaded, s.closeToTray]);

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

  // Show a red dot on Settings if Ollama URL or default chat model is empty.
  const settingsNeedsAttention = !s.ollamaUrl || !s.chatModel;

  return (
    <div className="app">
      <aside className="sidebar">
        <h1>Claw Deck</h1>
        {TABS.map(([k, ico, label, hint]) => (
          <button
            key={k}
            className={`tab-btn ${tab === k ? 'active' : ''}`}
            onClick={() => setTab(k as any)}
            title={hint}
          >
            <span className="ico">{ico}</span>
            <span>{label}</span>
            {k === 'settings' && settingsNeedsAttention && <span className="dot" title="Required settings are blank" />}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <button
          className="tab-btn"
          onClick={() => setWizardOpen(true)}
          title="Re-run the first-launch tour"
          style={{ fontSize: 12, opacity: .85 }}
        >
          <span className="ico">❓</span>
          <span>Show tour</span>
        </button>
      </aside>
      <main className="main">
        {tab === 'chat' && <ChatTab />}
        {tab === 'assistant' && <AssistantTab />}
        {tab === 'library' && <LibraryTab />}
        {tab === 'cli' && <CliConsoleTab />}
        {tab === 'terminal' && <TerminalTab />}
        {tab === 'history' && <HistoryTab />}
        {tab === 'prompts' && <PromptVaultTab />}
        {tab === 'settings' && <SettingsTab />}
        {tab === 'upgrades' && <UpgradesTab kind="openclaw" title="OpenClaw Upgrades" />}
        {tab === 'self' && <SelfUpgradeTab />}
        {tab === 'security' && <SecurityTab />}
      </main>
      <StatusBar />
      {paletteOpen && <CommandPalette onClose={togglePalette} />}
      {wizardOpen && <OnboardingWizard onClose={() => setWizardOpen(false)} />}
    </div>
  );
}
