import React, { useEffect, useState } from 'react';
import { useSettings, useUI } from './store/ui';
import { useConsole } from './store/console';
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

const KOFI_URL = 'https://ko-fi.com/sparklemuffin';

type TabDef = readonly [key: string, icon: string, label: string, hint: string];

const TABS: readonly TabDef[] = [
  ['chat',      '💬', 'Chat',           'Talk to your local LLM. Auto-routes to chat / vision / reasoning. Flip on Agent mode to plan & execute multi-step tasks.'],
  ['library',   '📚', 'Library',        'One-click installs: popular Ollama models, real MCP servers, OpenClaw plugins, system tools.'],
  ['console',   '🐚', 'Console',        'Run OpenClaw / Claude Code or any shell (PowerShell / cmd / Git Bash / WSL / custom) with live streaming + UAC elevation.'],
  ['brain',     '🧠', 'Project Brain',  'Atlas: a queryable map of a target codebase — symbols, call/reference edges, and active/orphaned/deprecated/superseded status tags. Powers the code-brain MCP server.'],
  ['council',   '⚖️', 'Council',        'Multi-workspace agent council: assign panelists/judge/QA from the roster, run a debate protocol, watch the theater, and approve/reject the diff in-tab.'],
  ['skills',    '🧩', 'Skills',         'Create, organize, search, install, and publish OpenClaw SKILL.md skills via ClawHub.'],
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
      </main>
      <StatusBar />
      {paletteOpen && <CommandPalette onClose={togglePalette} />}
      {wizardOpen && <OnboardingWizard onClose={() => setWizardOpen(false)} />}
    </div>
  );
}
