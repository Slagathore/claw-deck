import { ipcMain } from 'electron';
import { getDb } from './db';

const DEFAULTS = {
  ollamaUrl: 'http://localhost:11434',
  openaiCompatUrl: 'http://localhost:11434/v1',
  openaiCompatKey: 'ollama',
  visionModel: 'gemini-flash-3-preview',
  chatModel: 'llama3.2',
  reasoningModel: 'deepseek-r1',
  openclawPath: '',
  claudeCodePath: 'claude',
  theme: 'dark',
  showThinking: true,
  policy: { allowlist: ['github.com', 'releases.openclaw.org', 'objects.githubusercontent.com'], requireSignature: false, autoScan: true, signingKeys: [] as { name: string; format: 'pem' | 'hex'; key: string }[] },
  feeds: { openclaw: [] as string[], self: ['Slagathore/claw-deck'] },
  githubToken: '',
  virusTotalApiKey: '',
  yaraRulesPath: '',
  yaraBinary: '',
  mcpServers: [] as { name: string; command: string; args?: string[]; env?: Record<string, string>; cwd?: string; enabled?: boolean }[],
  quietMode: false,
  airgapped: false
};

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
