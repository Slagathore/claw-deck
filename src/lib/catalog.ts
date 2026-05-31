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
// MCP server presets (Model Context Protocol).
//
// Every entry below points at a package that actually exists and was verified
// against the registry: `node` servers are npm packages run with `npx`,
// `python` servers are PyPI packages run with `uvx` (Astral's uv — see the
// Tools tab). `pkg` carries the npm ref so the Library can fetch + deep-scan the
// real source before you trust it (node servers only).

export type McpRuntime = 'node' | 'python';

export interface McpPreset {
  name: string;
  description: string;
  runtime: McpRuntime;
  command: string;       // 'npx' (node) or 'uvx' (python)
  args: string[];        // base arguments
  /** npm ref so the Library can fetch + deep-scan the real package (node only). */
  pkg?: { kind: 'npm'; ref: string };
  /** A value the user must supply: positional 'path'/'arg' (appended to args) or 'token' (set as env). */
  needsArg?: { label: string; key: 'path' | 'arg' | 'token'; placeholder: string; env?: string };
  /** Honest extra-config note (extra env vars, runtime requirement). */
  notes?: string;
  homepage?: string;
}

const MCP_SERVERS_HOME = 'https://github.com/modelcontextprotocol/servers';

export const MCP_CATALOG: readonly McpPreset[] = [
  // ---- Node (npx) — official reference servers ----
  {
    name: 'filesystem',
    description: 'Read/write files within a directory you allow. Required for code-editing agents.',
    runtime: 'node', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'],
    pkg: { kind: 'npm', ref: '@modelcontextprotocol/server-filesystem' },
    needsArg: { label: 'Allowed directory', key: 'path', placeholder: 'C:\\Users\\you\\projects' },
    homepage: MCP_SERVERS_HOME + '/tree/main/src/filesystem'
  },
  {
    name: 'memory',
    description: 'Persistent knowledge graph the model can store/recall across sessions.',
    runtime: 'node', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'],
    pkg: { kind: 'npm', ref: '@modelcontextprotocol/server-memory' },
    homepage: MCP_SERVERS_HOME + '/tree/main/src/memory'
  },
  {
    name: 'sequential-thinking',
    description: 'Structured step-by-step reasoning scratchpad the model can use mid-task.',
    runtime: 'node', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    pkg: { kind: 'npm', ref: '@modelcontextprotocol/server-sequential-thinking' },
    homepage: MCP_SERVERS_HOME + '/tree/main/src/sequentialthinking'
  },
  {
    name: 'everything',
    description: 'Reference/test server exercising every MCP feature (tools, prompts, resources). Good for smoke-testing.',
    runtime: 'node', command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'],
    pkg: { kind: 'npm', ref: '@modelcontextprotocol/server-everything' },
    homepage: MCP_SERVERS_HOME + '/tree/main/src/everything'
  },
  {
    name: 'github',
    description: 'Read repos, issues, PRs, and search GitHub via your token.',
    runtime: 'node', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
    pkg: { kind: 'npm', ref: '@modelcontextprotocol/server-github' },
    needsArg: { label: 'GitHub token', key: 'token', env: 'GITHUB_PERSONAL_ACCESS_TOKEN', placeholder: 'ghp_…' },
    homepage: 'https://www.npmjs.com/package/@modelcontextprotocol/server-github'
  },
  {
    name: 'gitlab',
    description: 'GitLab projects, issues, MRs via your token.',
    runtime: 'node', command: 'npx', args: ['-y', '@modelcontextprotocol/server-gitlab'],
    pkg: { kind: 'npm', ref: '@modelcontextprotocol/server-gitlab' },
    needsArg: { label: 'GitLab token', key: 'token', env: 'GITLAB_PERSONAL_ACCESS_TOKEN', placeholder: 'glpat-…' },
    notes: 'For self-hosted GitLab also set GITLAB_API_URL in the server env.',
    homepage: 'https://www.npmjs.com/package/@modelcontextprotocol/server-gitlab'
  },
  {
    name: 'brave-search',
    description: 'Web search via the Brave Search API (free tier available).',
    runtime: 'node', command: 'npx', args: ['-y', '@modelcontextprotocol/server-brave-search'],
    pkg: { kind: 'npm', ref: '@modelcontextprotocol/server-brave-search' },
    needsArg: { label: 'Brave API key', key: 'token', env: 'BRAVE_API_KEY', placeholder: 'your Brave API key' },
    homepage: 'https://www.npmjs.com/package/@modelcontextprotocol/server-brave-search'
  },
  {
    name: 'google-maps',
    description: 'Geocoding, places, directions via the Google Maps API.',
    runtime: 'node', command: 'npx', args: ['-y', '@modelcontextprotocol/server-google-maps'],
    pkg: { kind: 'npm', ref: '@modelcontextprotocol/server-google-maps' },
    needsArg: { label: 'Google Maps API key', key: 'token', env: 'GOOGLE_MAPS_API_KEY', placeholder: 'AIza…' },
    homepage: 'https://www.npmjs.com/package/@modelcontextprotocol/server-google-maps'
  },
  {
    name: 'postgres',
    description: 'Read-only SQL queries + schema inspection against a PostgreSQL database.',
    runtime: 'node', command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres'],
    pkg: { kind: 'npm', ref: '@modelcontextprotocol/server-postgres' },
    needsArg: { label: 'Connection URL', key: 'arg', placeholder: 'postgresql://user:pass@host:5432/db' },
    homepage: 'https://www.npmjs.com/package/@modelcontextprotocol/server-postgres'
  },
  {
    name: 'redis',
    description: 'Get/set/query keys against a Redis instance.',
    runtime: 'node', command: 'npx', args: ['-y', '@modelcontextprotocol/server-redis'],
    pkg: { kind: 'npm', ref: '@modelcontextprotocol/server-redis' },
    needsArg: { label: 'Redis URL', key: 'arg', placeholder: 'redis://localhost:6379' },
    homepage: 'https://www.npmjs.com/package/@modelcontextprotocol/server-redis'
  },
  {
    name: 'slack',
    description: 'Read channels and post messages to a Slack workspace.',
    runtime: 'node', command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'],
    pkg: { kind: 'npm', ref: '@modelcontextprotocol/server-slack' },
    needsArg: { label: 'Slack bot token', key: 'token', env: 'SLACK_BOT_TOKEN', placeholder: 'xoxb-…' },
    notes: 'Also set SLACK_TEAM_ID in the server env.',
    homepage: 'https://www.npmjs.com/package/@modelcontextprotocol/server-slack'
  },
  {
    name: 'puppeteer',
    description: 'Browser automation (legacy reference server) — navigate, click, screenshot, scrape.',
    runtime: 'node', command: 'npx', args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    pkg: { kind: 'npm', ref: '@modelcontextprotocol/server-puppeteer' },
    notes: 'Superseded upstream by Playwright MCP (below); kept for compatibility.',
    homepage: 'https://www.npmjs.com/package/@modelcontextprotocol/server-puppeteer'
  },
  // ---- Node (npx) — reputable third-party ----
  {
    name: 'playwright',
    description: "Microsoft's Playwright MCP — drive a real browser (navigate, fill, click, snapshot).",
    runtime: 'node', command: 'npx', args: ['-y', '@playwright/mcp@latest'],
    pkg: { kind: 'npm', ref: '@playwright/mcp' },
    homepage: 'https://github.com/microsoft/playwright-mcp'
  },
  {
    name: 'context7',
    description: 'Upstash Context7 — pulls up-to-date, version-specific library docs into context.',
    runtime: 'node', command: 'npx', args: ['-y', '@upstash/context7-mcp'],
    pkg: { kind: 'npm', ref: '@upstash/context7-mcp' },
    homepage: 'https://github.com/upstash/context7'
  },
  {
    name: 'firecrawl',
    description: 'Firecrawl — scrape/crawl websites and return clean markdown.',
    runtime: 'node', command: 'npx', args: ['-y', 'firecrawl-mcp'],
    pkg: { kind: 'npm', ref: 'firecrawl-mcp' },
    needsArg: { label: 'Firecrawl API key', key: 'token', env: 'FIRECRAWL_API_KEY', placeholder: 'fc-…' },
    homepage: 'https://github.com/mendableai/firecrawl-mcp-server'
  },
  {
    name: 'notion',
    description: 'Query and update Notion databases and pages via an integration token.',
    runtime: 'node', command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'],
    pkg: { kind: 'npm', ref: '@notionhq/notion-mcp-server' },
    needsArg: { label: 'Notion token', key: 'token', env: 'NOTION_TOKEN', placeholder: 'ntn_…' },
    homepage: 'https://github.com/makenotion/notion-mcp-server'
  },
  // ---- Python (uvx) — official reference servers (need `uv` from the Tools tab) ----
  {
    name: 'fetch',
    description: 'Fetch a URL and convert HTML to markdown for the model to read.',
    runtime: 'python', command: 'uvx', args: ['mcp-server-fetch'],
    notes: 'Python server — requires uv (install it from the Tools tab).',
    homepage: MCP_SERVERS_HOME + '/tree/main/src/fetch'
  },
  {
    name: 'git',
    description: 'Read/inspect git history, diffs, branches and run git operations in a repo.',
    runtime: 'python', command: 'uvx', args: ['mcp-server-git', '--repository'],
    needsArg: { label: 'Git repository path', key: 'path', placeholder: 'C:\\path\\to\\repo' },
    notes: 'Python server — requires uv (install it from the Tools tab).',
    homepage: MCP_SERVERS_HOME + '/tree/main/src/git'
  },
  {
    name: 'time',
    description: 'Current time and timezone conversions. Tiny but handy.',
    runtime: 'python', command: 'uvx', args: ['mcp-server-time'],
    notes: 'Python server — requires uv (install it from the Tools tab).',
    homepage: MCP_SERVERS_HOME + '/tree/main/src/time'
  },
  {
    name: 'sqlite',
    description: 'Query a SQLite database file (read + schema inspection).',
    runtime: 'python', command: 'uvx', args: ['mcp-server-sqlite', '--db-path'],
    needsArg: { label: 'SQLite database file', key: 'path', placeholder: 'C:\\path\\to\\db.sqlite' },
    notes: 'Python server — requires uv (install it from the Tools tab).',
    homepage: 'https://pypi.org/project/mcp-server-sqlite/'
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
    name: 'uv (Astral)',
    description: 'Fast Python package runner. Required for uvx-based MCP servers (fetch, git, time, sqlite).',
    installCheck: 'uv --version',
    install: { winget: 'astral-sh.uv', choco: 'uv', manualUrl: 'https://docs.astral.sh/uv/getting-started/installation/' }
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
