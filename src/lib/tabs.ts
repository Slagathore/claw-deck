/** The sidebar tabs, in order. Kept as plain data so the app guide handed to the
 *  chat model is generated from the same list the UI renders. */
export type TabDef = readonly [key: string, icon: string, label: string, hint: string];

export const TABS: readonly TabDef[] = [
  ['chat',      '💬', 'Chat',           'Talk to your local LLM. Auto-routes to chat / vision / reasoning. Flip on Agent mode to plan & execute multi-step tasks. Chats are saved as you go.'],
  ['library',   '📚', 'Library',        'One-click installs: popular Ollama models, real MCP servers, OpenClaw plugins, system tools.'],
  ['console',   '🐚', 'Console',        'Run OpenClaw / Claude Code or any shell (PowerShell / cmd / Git Bash / WSL / custom) with live streaming + UAC elevation.'],
  ['brain',     '🧠', 'Project Brain',  'Atlas: a queryable map of a target codebase — symbols, call/reference edges, and active/orphaned/deprecated/superseded status tags. Powers the code-brain MCP server.'],
  ['council',   '⚖️', 'Council',        'Multi-workspace agent council: assign panelists/judge/QA from the roster, run a debate protocol, watch the theater, and approve/reject the diff in-tab.'],
  ['skills',    '🧩', 'Skills',         'Create, organize, search, install, and publish OpenClaw SKILL.md skills via ClawHub.'],
  ['history',   '📜', 'History',        'Every conversation, saved in full. Search by keyword or meaning, reopen a thread to keep going, or branch it.'],
  ['prompts',   '📋', 'Prompts',        'Reusable prompt templates with {{variable}} substitution.'],
  ['settings',  '⚙️', 'Settings',       'Configure Ollama URL, models, CLI paths, signing keys, MCP servers.'],
  ['upgrades',  '⬆️', 'OpenClaw',       'Install/update OpenClaw through the hardened gate (allowlist → hash → signature → AV+YARA → VirusTotal).'],
  ['self',      '🔄', 'Update Claw Deck', 'Check for Claw Deck updates from your configured GitHub release feed.'],
  ['security',  '🛡️', 'Security',       'Append-only, hash-chained ledger of every install / scan decision.']
] as const;
