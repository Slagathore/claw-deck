import { ipcMain } from 'electron';
import { getDb } from './db';

export const DEFAULTS = {
  ollamaUrl: 'http://localhost:11434',
  openaiCompatUrl: 'http://localhost:11434/v1',
  openaiCompatKey: 'ollama',
  visionModel: 'kimi-k2.7-code:cloud',
  chatModel: 'llama3.2',
  reasoningModel: 'deepseek-r1',
  embedModel: 'nomic-embed-text',          // Atlas embeddings (768-dim, locked)
  summaryModel: 'qwen2.5:3b',              // Atlas symbol summaries — fast + terse (≈4× quicker than llama3.2 at comparable quality)
  openclawPath: '',
  claudeCodePath: 'claude',
  codexPath: 'codex',                          // Fusion QA-gate actor (Cole is installing the CLI)
  claudeUseApiKey: false,                      // false = drop ANTHROPIC_API_KEY when spawning claude → use the claude-login subscription (not API credits)
  actorTimeoutMs: 600000,                      // per-call timeout for agentic CLI actors (claude/codex/openclaw); they do full turns and can take minutes
  actorExtraDirs: [] as string[],              // extra dirs granted to claude via --add-dir (e.g. a Blender project folder)
  panelistTools: true,                         // give cloud panelists READ-ONLY MCP tools (Atlas code-brain + Context7) so they can look up real APIs
  toolCallCap: 12,                             // max tool-call rounds before a cloud agent is told to answer with what it has
  // Council personalities — system-prompt flavors assignable per panelist (editable; grows).
  fusionPersonas: [
    { id: 'pragmatist', name: 'The Pragmatist', prompt: 'Favor the simplest thing that ships and works. Push back on gold-plating, premature abstraction, and scope creep.' },
    { id: 'security', name: 'The Security Hawk', prompt: 'Hunt for security holes above all: unsafe input handling, injection, secrets, unsafe defaults, auth gaps.' },
    { id: 'perf', name: 'The Performance Engineer', prompt: 'Scrutinize hot paths, allocations, N+1s, and complexity. Call out anything that will not scale.' },
    { id: 'minimalist', name: 'The Minimalist', prompt: 'Delete code. Prefer fewer moving parts, fewer dependencies, less surface area. Question every addition.' },
    { id: 'architect', name: 'The Architect', prompt: 'Think about boundaries, coupling, and long-term maintainability. Flag designs that will rot.' },
    { id: 'tester', name: 'The Tester', prompt: 'Demand test coverage and concrete repro/verification. Distrust any claim that is not demonstrated.' },
    { id: 'ux', name: 'The UX Advocate', prompt: 'Champion the end-user experience, clarity, and error handling. Flag confusing or fragile UX.' },
    { id: 'skeptic', name: 'The Skeptic', prompt: 'Assume it is wrong until proven. Stress assumptions, edge cases, and "works on my machine".' },
    { id: 'shipper', name: 'The Shipper', prompt: 'Bias to action. Find the fastest correct path to done; call out blockers and bikeshedding.' },
    { id: 'historian', name: 'The Codebase Historian', prompt: 'Ground every claim in what the codebase actually does today; distrust greenfield rewrites and deprecated APIs.' },
    { id: 'visionary', name: 'The Visionary', prompt: 'Think big and ambitious. Propose the version that would be genuinely incredible, not just adequate. What would make people say "whoa"?' },
    { id: 'bleeding-edge', name: 'The Bleeding-Edge Hacker', prompt: 'Reach for the newest, most powerful techniques and libraries — even experimental ones — when they could be dramatically better. Champion the future.' },
    { id: 'mad-scientist', name: 'The Mad Scientist', prompt: 'Propose unconventional, experimental approaches nobody else would try. Weird ideas that just might work — and be amazing. Embrace the risk.' },
    { id: 'artist', name: 'The Artist', prompt: 'Care about elegance, beauty, feel, and delight. Push for the solution that is a joy to use and to read, not merely correct.' },
    { id: 'contrarian', name: 'The Contrarian', prompt: 'Challenge the obvious answer. Argue the opposite of the consensus and see if it is actually better. Question every "we have to do it this way".' },
    { id: 'futurist', name: 'The Futurist', prompt: 'Design for where this is going in 5 years, not just today. Favor approaches that compound and open doors over ones that paint into corners.' },
    { id: 'game-designer', name: 'The Game Designer', prompt: 'Obsess over feel, responsiveness, juice, and fun. The boring-but-correct version is a failure if it feels lifeless.' },
    { id: 'demoscener', name: 'The Demoscener', prompt: 'Do the seemingly impossible in tiny space with clever tricks. Find the elegant hack that makes everyone else wonder how it even works.' },
    { id: 'optimist', name: 'The Tech Optimist', prompt: 'Yes-and the wild ideas. Assume the ambitious thing is possible and find the path. Bias hard toward "what if this just works?"' },
    { id: 'first-principles', name: 'The First-Principles Thinker', prompt: 'Tear the problem down to fundamentals and rebuild. Ignore "how it is usually done"; derive the right answer from scratch.' },
  ] as { id: string; name: string; prompt: string }[],
  councilEnvByWorkspace: {} as Record<string, string>, // persisted "environment / ground truth" facts per workspace
  clawhubPath: 'clawhub',
  ollamaCloudUrl: '',                          // blank = use local Ollama (it serves *:cloud models itself); set only for a direct remote Ollama endpoint (native API, e.g. https://ollama.com)
  ollamaCloudKey: '',                          // usually blank — local Ollama needs no key
  clawBridgePort: 39217,                       // localhost port the claw-bridge VS Code extension listens on
  skillsDir: '',
  scanBeforeInstall: true,     // fetch + security-scan skills/plugins before installing
  blockRiskyInstalls: true,    // hard-block installs with critical/high findings (else just warn)
  scanAllowlist: [] as string[], // ignored finding fingerprints (scope::rule::file::snippet) — known false-positives
  ruleOverrides: {} as Record<string, { severity: 'info' | 'low' | 'medium' | 'high' | 'critical' | 'off'; note?: string }>, // global per-rule severity overrides
  scanSummaries: {} as Record<string, { counts: { info: number; low: number; medium: number; high: number; critical: number }; ignored: number; at: number }>, // cached per-scope risk snapshot for at-a-glance row badges
  theme: 'dark',
  // Thinking knobs: `think` asks thinking-capable models (e.g. kimi-k2.7-code) for a reasoning
  // pass (false = leave the model default); `showThinking` controls whether the separate
  // message.thinking pane is displayed — thinking is never mixed into content, hidden by default.
  think: false as boolean | 'low' | 'medium' | 'high',
  showThinking: false,
  policy: { allowlist: ['github.com', 'releases.openclaw.org', 'objects.githubusercontent.com'], requireSignature: false, autoScan: true, signingKeys: [] as { name: string; format: 'pem' | 'hex'; key: string }[] },
  feeds: { openclaw: [] as string[], self: ['Slagathore/claw-deck'] },
  githubToken: '',
  virusTotalApiKey: '',
  yaraRulesPath: '',
  yaraBinary: '',
  mcpServers: [] as { name: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled?: boolean }[],
  // Fusion Council global agent roster (§4.5) — per-tab CouncilSettings assigns
  // positions from this pool. Seeded with the chosen *:cloud panelists + actors.
  // (2026-07: the Gemini 3 Flash preview + Qwen3 Coder 480B cloud models were retired by
  // Ollama; kimi-k2.7-code:cloud is the default coding panelist and took the edit slot.)
  fusionRoster: [
    { id: 'kimi-k2', displayName: 'Kimi K2.7 Code', transport: 'ollama-cloud', model: 'kimi-k2.7-code:cloud', capabilities: { canEdit: true, canRunTools: false, costTier: 'cheap' } },
    { id: 'qwen3-5', displayName: 'Qwen3.5 397B', transport: 'ollama-cloud', model: 'qwen3.5:397b-cloud', capabilities: { canEdit: false, canRunTools: false, costTier: 'mid' } },
    { id: 'claude-code', displayName: 'Claude Code', transport: 'claude-code', binary: 'claude', capabilities: { canEdit: true, canRunTools: true, costTier: 'expensive' } },
    { id: 'codex', displayName: 'Codex', transport: 'codex', binary: 'codex', capabilities: { canEdit: true, canRunTools: true, costTier: 'mid' } },
    { id: 'openclaw', displayName: 'OpenClaw', transport: 'openclaw', binary: 'openclaw', capabilities: { canEdit: true, canRunTools: true, costTier: 'cheap' } },
  ] as { id: string; displayName: string; transport: string; model?: string; binary?: string; capabilities: { canEdit: boolean; canRunTools: boolean; costTier: string } }[],
  quietMode: false,
  airgapped: false,
  selfUpgrade: {
    backend: 'local' as 'local' | 'remote' | 'openclaw',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'llama3.2',
    remoteUrl: 'https://api.openai.com/v1',
    remoteKey: '',
    remoteModel: 'gpt-4o-mini',
    autoApply: false,
    sandboxHighRisk: true,
    launchProbe: true,
    probeChecks: ['boot', 'db', 'tray', 'ollama', 'render', 'scan'] as string[],
    goal: 'propose a small, safe improvement to code quality or test coverage'
  }
};

/**
 * Read a single setting from the DB, falling back to DEFAULTS then `fallback`.
 * IMPORTANT: the `settings:get` IPC merges DEFAULTS, but main-process code that
 * reads the raw `settings` table must use THIS so seeded defaults (e.g.
 * fusionRoster) are visible even before the user has saved settings once.
 */
export function getSetting<T = any>(key: string, fallback?: T): T {
  try {
    const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    if (row) return JSON.parse(row.value) as T;
  } catch { /* fall through to defaults */ }
  if (key in DEFAULTS) return (DEFAULTS as Record<string, any>)[key] as T;
  return fallback as T;
}

export function registerSettingsHandlers() {
  ipcMain.handle('settings:get', () => {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const stored: Record<string, any> = {};
    for (const r of rows) {
      try { stored[r.key] = JSON.parse(r.value); } catch { stored[r.key] = r.value; }
    }
    return { ...DEFAULTS, ...stored };
  });

  ipcMain.handle('settings:set', (_e, patch: Record<string, any>) => {
    const db = getDb();
    const stmt = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const tx = db.transaction((entries: [string, any][]) => {
      for (const [k, v] of entries) stmt.run(k, JSON.stringify(v));
    });
    tx(Object.entries(patch));
    return true;
  });
}
