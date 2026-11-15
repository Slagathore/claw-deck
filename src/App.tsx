import React, { useEffect, useState } from 'react';
import { useSettings, useUI } from './store/ui';
import { useConsole } from './store/console';
import { useChat } from './store/chat';
import { TABS } from './lib/tabs';
import ChatTab from './tabs/ChatTab';
import LibraryTab from './tabs/LibraryTab';
import ConsoleTab from './tabs/ConsoleTab';
import SkillsTab from './tabs/SkillsTab';
import HistoryTab from './tabs/HistoryTab';
import PromptVaultTab from './tabs/PromptVaultTab';
import SettingsTab from './tabs/SettingsTab';
import UpgradesTab from './tabs/UpgradesTab';
import SelfUpgradeTab from './tabs/SelfUpgradeTab';
import SecurityTab from './tabs/SecurityTab';
import ProjectBrainTab from './tabs/ProjectBrainTab';
import CouncilTab from './tabs/CouncilTab';
import CommandPalette from './components/CommandPalette';
import StatusBar from './components/StatusBar';
import OnboardingWizard, { shouldShowOnboarding } from './components/OnboardingWizard';
import UpdateNotice from './components/UpdateNotice';
import ErrorBoundary from './components/ErrorBoundary';

const KOFI_URL = 'https://ko-fi.com/sparklemuffin';

export default function App() {
  const { tab, setTab, paletteOpen, togglePalette } = useUI();
  const { data: s, load, loaded } = useSettings();
  const [wizardOpen, setWizardOpen] = useState(false);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (loaded && shouldShowOnboarding()) setWizardOpen(true);
  }, [loaded]);

  // Bring back the chat that was open last time (survives app and PC restarts).
  useEffect(() => {
    if (loaded) void useChat.getState().hydrate();
  }, [loaded]);

  // One global stream subscription feeds the chat store, so a reply keeps
  // arriving while another tab is showing.
  useEffect(() => {
    const off = window.api.ollama.onChunk((c: any) => useChat.getState().handleChunk(c));
    return off;
  }, []);

  // Push the close-window behavior to the backend whenever it changes.
  // Default 'tray'; migrate the old boolean closeToTray (false ⇒ 'quit').
  useEffect(() => {
    if (!loaded) return;
    const behavior = s.closeBehavior ?? (s.closeToTray === false ? 'quit' : 'tray');
    window.api.app.setCloseBehavior(behavior).catch(() => { /* ignore */ });
  }, [loaded, s.closeBehavior, s.closeToTray]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); togglePalette();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [togglePalette]);

  // One global runner-event subscription routes stdout/stderr/exit/error into
  // the Console store. Any tab can launch a session (Console, Library installs)
  // and it shows up in the Console with live output.
  useEffect(() => {
    const off = window.api.runner.onEvent((ev: any) => useConsole.getState().handleEvent(ev));
    return off;
  }, []);

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
        <div className="donate-box">
          If this helped you, consider donating to help keep me focused on making more useful free apps? Thanks!
          <button className="donate-btn" onClick={() => window.api.app.openExternal(KOFI_URL)}>
            ☕ Donate on Ko-fi
          </button>
        </div>
      </aside>
      <main className="main">
        <UpdateNotice />
        <ErrorBoundary key={tab} chat={tab === 'chat'}>
          {tab === 'chat' && <ChatTab />}
          {tab === 'library' && <LibraryTab />}
          {tab === 'console' && <ConsoleTab />}
          {tab === 'brain' && <ProjectBrainTab />}
          {tab === 'council' && <CouncilTab />}
          {tab === 'skills' && <SkillsTab />}
          {tab === 'history' && <HistoryTab />}
          {tab === 'prompts' && <PromptVaultTab />}
          {tab === 'settings' && <SettingsTab />}
          {tab === 'upgrades' && <UpgradesTab kind="openclaw" title="OpenClaw Upgrades" />}
          {tab === 'self' && <SelfUpgradeTab />}
          {tab === 'security' && <SecurityTab />}
        </ErrorBoundary>
      </main>
      <StatusBar />
      {paletteOpen && <CommandPalette onClose={togglePalette} />}
      {wizardOpen && <OnboardingWizard onClose={() => setWizardOpen(false)} />}
    </div>
  );
}
