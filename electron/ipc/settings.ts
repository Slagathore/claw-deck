import { ipcMain } from 'electron';
import { getDb } from './db';

export const DEFAULTS = {
  ollamaUrl: 'http://localhost:11434',
  openaiCompatUrl: 'http://localhost:11434/v1',
  openaiCompatKey: 'ollama',
  visionModel: 'gemini-flash-3-preview',
  chatModel: 'llama3.2',
  reasoningModel: 'deepseek-r1',
  embedModel: 'nomic-embed-text',          // Atlas embeddings (768-dim, locked)
  openclawPath: '',
  claudeCodePath: 'claude',
  codexPath: 'codex',                          // Fusion QA-gate actor (Cole is installing the CLI)
  claudeUseApiKey: false,                      // false = drop ANTHROPIC_API_KEY when spawning claude → use the claude-login subscription (not API credits)
  clawhubPath: 'clawhub',
  ollamaCloudUrl: '',                          // blank = use local Ollama (it serves *:cloud models itself); set only for a remote OpenAI-compat endpoint
  ollamaCloudKey: '',                          // usually blank — local Ollama needs no key
  clawBridgePort: 39217,                       // localhost port the claw-bridge VS Code extension listens on
  skillsDir: '',
  scanBeforeInstall: true,     // fetch + security-scan skills/plugins before installing
  blockRiskyInstalls: true,    // hard-block installs with critical/high findings (else just warn)
  scanAllowlist: [] as string[], // ignored finding fingerprints (scope::rule::file::snippet) — known false-positives
  ruleOverrides: {} as Record<string, { severity: 'info' | 'low' | 'medium' | 'high' | 'critical' | 'off'; note?: string }>, // global per-rule severity overrides
  scanSummaries: {} as Record<string, { counts: { info: number; low: number; medium: number; high: number; critical: number }; ignored: number; at: number }>, // cached per-scope risk snapshot for at-a-glance row badges
  theme: 'dark',
  showThinking: true,
  policy: { allowlist: ['github.com', 'releases.openclaw.org', 'objects.githubusercontent.com'], requireSignature: false, autoScan: true, signingKeys: [] as { name: string; format: 'pem' | 'hex'; key: string }[] },
  feeds: { openclaw: [] as string[], self: ['Slagathore/claw-deck'] },
  githubToken: '',
  virusTotalApiKey: '',
  yaraRulesPath: '',
  yaraBinary: '',
  mcpServers: [] as { name: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled?: boolean }[],
  // Fusion Council global agent roster (§4.5) — per-tab CouncilSettings assigns
  // positions from this pool. Seeded with the chosen *:cloud panelists + actors.
  fusionRoster: [
    { id: 'kimi-k2', displayName: 'Kimi K2.7 Code', transport: 'ollama-cloud', model: 'kimi-k2.7-code:cloud', capabilities: { canEdit: false, canRunTools: false, costTier: 'cheap' } },
    { id: 'qwen3-5', displayName: 'Qwen3.5 397B', transport: 'ollama-cloud', model: 'qwen3.5:397b-cloud', capabilities: { canEdit: false, canRunTools: false, costTier: 'mid' } },
    { id: 'gemini3-flash', displayName: 'Gemini 3 Flash', transport: 'ollama-cloud', model: 'gemini-3-flash-preview:cloud', capabilities: { canEdit: false, canRunTools: false, costTier: 'cheap' } },
    { id: 'qwen3-coder', displayName: 'Qwen3 Coder 480B', transport: 'ollama-cloud', model: 'qwen3-coder:480b-cloud', capabilities: { canEdit: true, canRunTools: false, costTier: 'mid' } },
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
