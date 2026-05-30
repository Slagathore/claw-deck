/**
 * Curated catalog of common things a Claw Deck user might want to install.
 * Pure data — no IPC, no DOM. Used by LibraryTab and the planner.
 *
 * Sizes/descriptions verified against ollama.com/library as of 2026-05.
 * Sizes are approximate (default tag) — users see the dropdown for variants.
 */

export interface ModelEntry {
  name: string;             // canonical Ollama tag (e.g. "llama3.2")
  family: string;           // grouping for filtering ("llama", "qwen", "mistral", ...)
  description: string;
  sizeGb: number;           // default-tag size, GB
  paramsB: number;          // billion params
  capabilities: ('chat' | 'vision' | 'reasoning' | 'code' | 'embed')[];
  recommended?: ('chat' | 'vision' | 'reasoning' | 'code')[]; // what to suggest for which slot
  variants?: string[];      // alternative tags worth showing
}

export const MODEL_CATALOG: readonly ModelEntry[] = [
  // ---- General chat ----
  { name: 'llama3.2',       family: 'llama',  description: 'Meta Llama 3.2 — small, fast, strong general chat. Great default.', sizeGb: 2.0, paramsB: 3, capabilities: ['chat'], recommended: ['chat'], variants: ['llama3.2:1b', 'llama3.2:3b'] },
  { name: 'llama3.1',       family: 'llama',  description: 'Meta Llama 3.1 — bigger, better for harder prompts.',               sizeGb: 4.7, paramsB: 8, capabilities: ['chat', 'reasoning'], variants: ['llama3.1:8b', 'llama3.1:70b'] },
  { name: 'llama3.3',       family: 'llama',  description: 'Meta Llama 3.3 — 70B-class quality at 70B size.',                   sizeGb: 43,  paramsB: 70, capabilities: ['chat', 'reasoning'] },
  { name: 'qwen2.5',        family: 'qwen',   description: 'Alibaba Qwen 2.5 — strong multilingual chat, good at code.',        sizeGb: 4.7, paramsB: 7, capabilities: ['chat', 'code'], variants: ['qwen2.5:1.5b', 'qwen2.5:7b', 'qwen2.5:14b', 'qwen2.5:32b'] },
  { name: 'qwen2.5-coder',  family: 'qwen',   description: 'Qwen 2.5 fine-tuned for code — fill-in-the-middle support.',        sizeGb: 4.7, paramsB: 7, capabilities: ['code', 'chat'], recommended: ['code'], variants: ['qwen2.5-coder:1.5b', 'qwen2.5-coder:7b', 'qwen2.5-coder:32b'] },
  { name: 'mistral',        family: 'mistral',description: 'Mistral 7B — fast, capable instruction-tuned chat.',                sizeGb: 4.1, paramsB: 7, capabilities: ['chat'] },
  { name: 'mistral-nemo',   family: 'mistral',description: 'Mistral NeMo 12B — strong general-purpose, long context.',          sizeGb: 7.1, paramsB: 12, capabilities: ['chat'] },
  { name: 'phi3',           family: 'phi',    description: 'Microsoft Phi-3 — tiny but punches above its weight.',              sizeGb: 2.3, paramsB: 4, capabilities: ['chat'] },
  { name: 'phi3.5',         family: 'phi',    description: 'Microsoft Phi-3.5 — 3.8B mini, multimodal variants available.',     sizeGb: 2.3, paramsB: 4, capabilities: ['chat'] },
  { name: 'gemma2',         family: 'gemma',  description: 'Google Gemma 2 — open-weights from the Gemini team.',               sizeGb: 5.4, paramsB: 9, capabilities: ['chat'], variants: ['gemma2:2b', 'gemma2:9b', 'gemma2:27b'] },
  // ---- Reasoning ----
  { name: 'deepseek-r1',    family: 'deepseek', description: 'DeepSeek R1 — chain-of-thought reasoning, emits <think> blocks.', sizeGb: 4.7, paramsB: 7, capabilities: ['reasoning', 'chat'], recommended: ['reasoning'], variants: ['deepseek-r1:1.5b', 'deepseek-r1:7b', 'deepseek-r1:14b', 'deepseek-r1:32b', 'deepseek-r1:70b'] },
  { name: 'qwq',            family: 'qwen',     description: 'Qwen QwQ — explicit reasoning model with <think> traces.',         sizeGb: 20,  paramsB: 32, capabilities: ['reasoning', 'chat'] },
  // ---- Vision ----
  { name: 'llava',          family: 'llava',  description: 'LLaVA — open multimodal, can read images.',                         sizeGb: 4.7, paramsB: 7, capabilities: ['vision', 'chat'], recommended: ['vision'], variants: ['llava:7b', 'llava:13b', 'llava:34b'] },
  { name: 'llama3.2-vision', family: 'llama', description: 'Llama 3.2 with vision encoder — handles screenshots & charts.',     sizeGb: 7.9, paramsB: 11, capabilities: ['vision', 'chat'], recommended: ['vision'], variants: ['llama3.2-vision:11b', 'llama3.2-vision:90b'] },
  { name: 'minicpm-v',      family: 'minicpm',description: 'MiniCPM-V — small, fast vision model.',                              sizeGb: 5.5, paramsB: 8, capabilities: ['vision', 'chat'] },
  { name: 'moondream',      family: 'moondream',description: 'Moondream — tiny (1.8B) vision model for quick image Q&A.',        sizeGb: 1.7, paramsB: 1.8, capabilities: ['vision'] },
  // ---- Code ----
  { name: 'codellama',      family: 'llama',  description: 'Meta CodeLlama — code completion + chat.',                          sizeGb: 3.8, paramsB: 7, capabilities: ['code'], variants: ['codellama:7b', 'codellama:13b', 'codellama:34b', 'codellama:70b'] },
  { name: 'starcoder2',     family: 'starcoder', description: 'BigCode StarCoder2 — wide language coverage.',                    sizeGb: 4.0, paramsB: 7, capabilities: ['code'] },
  { name: 'deepseek-coder-v2', family: 'deepseek', description: 'DeepSeek Coder v2 — competitive code generation.',              sizeGb: 8.9, paramsB: 16, capabilities: ['code'] },
  // ---- Embeddings ----
  { name: 'nomic-embed-text', family: 'nomic', description: 'Nomic — high-quality 768-dim text embeddings.',                    sizeGb: 0.3, paramsB: 0.14, capabilities: ['embed'] },
  { name: 'mxbai-embed-large', family: 'mxbai', description: 'mxbai — 1024-dim embeddings, strong retrieval scores.',           sizeGb: 0.7, paramsB: 0.33, capabilities: ['embed'] }
];

// ----------------------------------------------------------------------------
// MCP server presets (Model Context Protocol)
// All are official @modelcontextprotocol/server-* npm packages — npx fetches on demand.

export interface McpPreset {
  name: string;
  description: string;
  command: string;       // usually 'npx'
  args: string[];        // arguments to pass
  needsArg?: { label: string; key: 'path' | 'token'; placeholder: string }; // user must supply one value
  homepage?: string;
}

export const MCP_CATALOG: readonly McpPreset[] = [
  {
    name: 'filesystem',
    description: 'Read/write files within a directory you allow. Required for code-editing agents.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem'],
    needsArg: { label: 'Allowed directory', key: 'path', placeholder: 'C:\\Users\\you\\projects' },
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem'
  },
  {
    name: 'github',
    description: 'Read repos, issues, PRs, and search GitHub via your token.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    needsArg: { label: 'GITHUB_PERSONAL_ACCESS_TOKEN (env)', key: 'token', placeholder: 'ghp_…' },
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/github'
  },
  {
    name: 'brave-search',
    description: 'Web search via the Brave Search API (free tier available).',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    needsArg: { label: 'BRAVE_API_KEY (env)', key: 'token', placeholder: 'your Brave API key' },
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/brave-search'
  },
  {
    name: 'fetch',
    description: 'Fetch URLs and convert HTML to markdown for the model to read.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch'
  },
  {
    name: 'memory',
    description: 'Persistent knowledge graph the model can store/recall across sessions.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory'
  },
  {
    name: 'sqlite',
    description: 'Query a SQLite database file. Read or read-write modes.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
    needsArg: { label: 'SQLite database file', key: 'path', placeholder: 'C:\\path\\to\\db.sqlite' },
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sqlite'
  },
  {
    name: 'git',
    description: 'Read git history, diffs, branches, and run git commands in a repo.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-git'],
    needsArg: { label: 'Git repository path', key: 'path', placeholder: 'C:\\path\\to\\repo' },
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/git'
  },
  {
    name: 'puppeteer',
    description: 'Browser automation — navigate pages, click, screenshot, scrape.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/puppeteer'
  },
  {
    name: 'time',
    description: 'Get current time / convert timezones. Tiny but surprisingly useful.',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-time'],
    homepage: 'https://github.com/modelcontextprotocol/servers/tree/main/src/time'
  }
];

// ----------------------------------------------------------------------------
// External CLI tools the user might want to install.

export interface ToolPreset {
  name: string;
  description: string;
  installCheck: string;          // `command --version` style probe
  install: { winget?: string; choco?: string; manualUrl: string };
}

export const TOOL_CATALOG: readonly ToolPreset[] = [
  {
    name: 'Ollama',
    description: 'Local LLM runtime. Required for Chat / vision / reasoning.',
    installCheck: 'ollama --version',
    install: { winget: 'Ollama.Ollama', manualUrl: 'https://ollama.com/download' }
  },
  {
    name: 'Git',
    description: 'Version control. Needed for git MCP server and many workflows.',
    installCheck: 'git --version',
    install: { winget: 'Git.Git', manualUrl: 'https://git-scm.com/downloads' }
  },
  {
    name: 'GitHub CLI',
    description: 'gh command — auth, repos, releases, gists.',
    installCheck: 'gh --version',
    install: { winget: 'GitHub.cli', manualUrl: 'https://cli.github.com/' }
  },
  {
    name: 'Node.js LTS',
    description: 'Required to run MCP servers via npx.',
    installCheck: 'node --version',
    install: { winget: 'OpenJS.NodeJS.LTS', manualUrl: 'https://nodejs.org/' }
  },
  {
    name: 'Python 3.12',
    description: 'For Python-based MCP servers and tooling.',
    installCheck: 'python --version',
    install: { winget: 'Python.Python.3.12', manualUrl: 'https://www.python.org/downloads/' }
  },
  {
    name: 'Claude Code',
    description: 'Anthropic CLI for agentic coding sessions.',
    installCheck: 'claude --version',
    install: { manualUrl: 'https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview' }
  },
  {
    name: 'PowerShell 7',
    description: 'Modern cross-platform PowerShell. Used by the Terminal tab.',
    installCheck: 'pwsh --version',
    install: { winget: 'Microsoft.PowerShell', manualUrl: 'https://github.com/PowerShell/PowerShell/releases' }
  },
  {
    name: 'YARA',
    description: 'Pattern-matching engine used by the upgrade-scan gate.',
    installCheck: 'yara --version',
    install: { choco: 'yara', manualUrl: 'https://github.com/VirusTotal/yara/releases' }
  }
];

// ----------------------------------------------------------------------------
// Pure search helpers (used by LibraryTab + tests).

export function searchModels(query: string, models: readonly ModelEntry[] = MODEL_CATALOG): ModelEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...models];
  return models.filter(m =>
    m.name.toLowerCase().includes(q) ||
    m.family.toLowerCase().includes(q) ||
    m.description.toLowerCase().includes(q) ||
    m.capabilities.some(c => c.includes(q))
  );
}

export function searchMcp(query: string, presets: readonly McpPreset[] = MCP_CATALOG): McpPreset[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...presets];
  return presets.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
}

export function searchTools(query: string, presets: readonly ToolPreset[] = TOOL_CATALOG): ToolPreset[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...presets];
  return presets.filter(p => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
}
