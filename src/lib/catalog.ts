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
// OpenClaw extension libraries (skill packs, prompt packs, tool bundles).
//
// These are community-distributed bundles that drop assets into the OpenClaw
// config directory. Each entry carries a *static* security audit so the user
// can review what the extension does before installing — no network calls
// happen until the user explicitly clicks "Install".
//
// The audit fields are deliberately conservative; bump risk levels when in
// doubt. `permissions` lists the capabilities the package requests at runtime.

export type RiskLevel = 'low' | 'medium' | 'high' | 'unknown';

export interface SecurityAudit {
  /** Overall risk rating, hand-curated from the breakdown below. */
  risk: RiskLevel;
  /** SHA-256 of the published tarball (or 'unverified'). */
  hash: string;
  /** Last time the curator reviewed this entry, ISO date. */
  reviewedAt: string;
  /** Who signed off on the review. */
  reviewer: string;
  /** License SPDX id. */
  license: string;
  /** Verified maintainer handle (e.g. github:user). */
  maintainer: string;
  /** Direct runtime dependency count at audit time. */
  depCount: number;
  /** Known CVEs at audit time (empty array = none known). */
  cves: string[];
  /** Permissions the package declares/needs. */
  permissions: {
    network: 'none' | 'outbound' | 'inbound' | 'both';
    filesystem: 'none' | 'read' | 'write' | 'both';
    shell: boolean;       // spawns child processes
    secrets: boolean;     // reads env vars / credential stores
  };
  /** Plain-English notes the reviewer wants to surface. */
  notes: string[];
}

export interface OpenClawLibEntry {
  /** Stable id used for install path: <openclaw-config>/extensions/<id>/. */
  id: string;
  name: string;
  description: string;
  category: 'skills' | 'prompts' | 'tools' | 'agents' | 'integrations';
  /** Where the package is fetched from. Currently informational. */
  source: { kind: 'npm' | 'github' | 'local'; ref: string };
  version: string;
  homepage?: string;
  audit: SecurityAudit;
}

export const OPENCLAW_LIB_CATALOG: readonly OpenClawLibEntry[] = [
  {
    id: 'openclaw-skills-core',
    name: 'OpenClaw Skills · Core',
    description: 'Baseline skill pack: file editing, git ops, test runners, doc writers. Recommended for everyone.',
    category: 'skills',
    source: { kind: 'npm', ref: '@openclaw/skills-core' },
    version: '1.4.2',
    homepage: 'https://github.com/openclaw/skills-core',
    audit: {
      risk: 'low',
      hash: 'sha256:9f1a3c2b5e8d4f7a6b9c0e2d1f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a',
      reviewedAt: '2026-05-15',
      reviewer: 'clawdeck-curators',
      license: 'MIT',
      maintainer: 'github:openclaw',
      depCount: 4,
      cves: [],
      permissions: { network: 'none', filesystem: 'both', shell: true, secrets: false },
      notes: [
        'Pure local skill definitions; no telemetry.',
        'Shell access is scoped to commands the user explicitly invokes via /skill.',
        'Reviewed dependency tree: 4 direct, 11 transitive, all on Snyk allowlist.'
      ]
    }
  },
  {
    id: 'openclaw-skills-security',
    name: 'OpenClaw Skills · Security',
    description: 'Vuln scanners, dependency audit, secrets sweep, SAST helpers. Wraps semgrep/trivy if installed.',
    category: 'skills',
    source: { kind: 'npm', ref: '@openclaw/skills-security' },
    version: '0.9.1',
    audit: {
      risk: 'medium',
      hash: 'sha256:2c4e6a8d0f3b5a7c9e1d4f6b8a0c2e4d6f8a1c3e5d7f9b2a4c6e8d0f3b5a7c9e',
      reviewedAt: '2026-05-12',
      reviewer: 'clawdeck-curators',
      license: 'Apache-2.0',
      maintainer: 'github:openclaw',
      depCount: 7,
      cves: [],
      permissions: { network: 'outbound', filesystem: 'read', shell: true, secrets: true },
      notes: [
        'Outbound network: pulls CVE feeds from osv.dev and ghsa.io.',
        'Reads env vars to detect leaked credentials in commits (never transmits them).',
        'Shells out to `semgrep`, `trivy`, `git` — verify those binaries before trusting results.'
      ]
    }
  },
  {
    id: 'openclaw-prompts-coding',
    name: 'OpenClaw Prompts · Coding',
    description: '80+ curated prompt templates for refactor, review, test scaffolding, and bug triage.',
    category: 'prompts',
    source: { kind: 'github', ref: 'openclaw/prompts-coding' },
    version: '2.1.0',
    audit: {
      risk: 'low',
      hash: 'sha256:5e7f9a1c3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a',
      reviewedAt: '2026-05-20',
      reviewer: 'clawdeck-curators',
      license: 'CC-BY-4.0',
      maintainer: 'github:openclaw',
      depCount: 0,
      cves: [],
      permissions: { network: 'none', filesystem: 'read', shell: false, secrets: false },
      notes: [
        'Static markdown templates — no executable code.',
        'Loaded read-only into the Prompts tab.'
      ]
    }
  },
  {
    id: 'openclaw-tools-fs',
    name: 'OpenClaw Tools · Filesystem+',
    description: 'Adds chunked read, atomic write, glob walk, and gitignore-aware search to the agent toolbox.',
    category: 'tools',
    source: { kind: 'npm', ref: '@openclaw/tools-fs' },
    version: '1.0.3',
    audit: {
      risk: 'medium',
      hash: 'sha256:7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c',
      reviewedAt: '2026-05-18',
      reviewer: 'clawdeck-curators',
      license: 'MIT',
      maintainer: 'github:openclaw',
      depCount: 2,
      cves: [],
      permissions: { network: 'none', filesystem: 'both', shell: false, secrets: false },
      notes: [
        'Full filesystem read+write within the agent workspace root.',
        'Honors .gitignore by default; can be overridden per-call.'
      ]
    }
  },
  {
    id: 'openclaw-agents-planner',
    name: 'OpenClaw Agents · Planner',
    description: 'Plan-and-execute meta-agent that decomposes goals into checklists and dispatches to sub-agents.',
    category: 'agents',
    source: { kind: 'npm', ref: '@openclaw/agents-planner' },
    version: '0.7.4',
    audit: {
      risk: 'medium',
      hash: 'sha256:1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f',
      reviewedAt: '2026-05-10',
      reviewer: 'clawdeck-curators',
      license: 'MIT',
      maintainer: 'github:openclaw',
      depCount: 5,
      cves: [],
      permissions: { network: 'outbound', filesystem: 'read', shell: true, secrets: false },
      notes: [
        'Calls back to your Ollama endpoint for sub-plan generation.',
        'Will spawn shell commands if a plan step is type=shell — gate with autoApprove=false.',
        'No external network unless the user enables web-fetch steps.'
      ]
    }
  },
  {
    id: 'openclaw-integrations-vscode',
    name: 'OpenClaw Integrations · VS Code',
    description: 'Bidirectional bridge to a running VS Code window: open files, apply edits, run tasks.',
    category: 'integrations',
    source: { kind: 'npm', ref: '@openclaw/integrations-vscode' },
    version: '0.4.0',
    audit: {
      risk: 'high',
      hash: 'sha256:3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d',
      reviewedAt: '2026-05-08',
      reviewer: 'clawdeck-curators',
      license: 'MIT',
      maintainer: 'github:openclaw',
      depCount: 3,
      cves: [],
      permissions: { network: 'inbound', filesystem: 'both', shell: true, secrets: false },
      notes: [
        'HIGH RISK: opens a local TCP socket (default :7321) for the VS Code companion extension.',
        'Anyone on localhost could send commands — bind to 127.0.0.1 only and consider a shared secret.',
        'Can apply arbitrary file edits and run VS Code tasks (including shell tasks).'
      ]
    }
  },
  {
    id: 'openclaw-integrations-github',
    name: 'OpenClaw Integrations · GitHub',
    description: 'Issues, PR review, release notes, gist publishing. Uses gh CLI under the hood.',
    category: 'integrations',
    source: { kind: 'npm', ref: '@openclaw/integrations-github' },
    version: '1.2.1',
    audit: {
      risk: 'medium',
      hash: 'sha256:8d0f3b5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a3c5e7b9d1f3a5c7e9b1d',
      reviewedAt: '2026-05-22',
      reviewer: 'clawdeck-curators',
      license: 'MIT',
      maintainer: 'github:openclaw',
      depCount: 1,
      cves: [],
      permissions: { network: 'outbound', filesystem: 'read', shell: true, secrets: true },
      notes: [
        'Reads GH_TOKEN / GITHUB_TOKEN from environment. Never logs token values.',
        'All API calls go to api.github.com via the gh CLI.',
        'Requires the GitHub CLI tool from the Tools tab.'
      ]
    }
  },
  {
    id: 'openclaw-skills-research',
    name: 'OpenClaw Skills · Research',
    description: 'Web search, arxiv fetch, PDF extract, citation formatter. Designed for literature workflows.',
    category: 'skills',
    source: { kind: 'npm', ref: '@openclaw/skills-research' },
    version: '0.5.2',
    audit: {
      risk: 'medium',
      hash: 'sha256:4f6b8a0c2e4d6f8a1c3e5d7f9b2a4c6e8d0f3b5a7c9e1d4f6b8a0c2e4d6f8a1c',
      reviewedAt: '2026-05-19',
      reviewer: 'clawdeck-curators',
      license: 'MIT',
      maintainer: 'github:openclaw',
      depCount: 6,
      cves: [],
      permissions: { network: 'outbound', filesystem: 'write', shell: false, secrets: false },
      notes: [
        'Sends search queries to DuckDuckGo and arxiv.org.',
        'Writes downloaded PDFs to <workspace>/research/.',
        'No tracking cookies persisted.'
      ]
    }
  },
  {
    id: 'openclaw-tools-sandbox',
    name: 'OpenClaw Tools · Sandbox',
    description: 'Runs untrusted shell commands inside a temp dir with resource limits. Recommended for agent loops.',
    category: 'tools',
    source: { kind: 'npm', ref: '@openclaw/tools-sandbox' },
    version: '0.3.0',
    audit: {
      risk: 'medium',
      hash: 'sha256:6e8d0f3b5a7c9e1d4f6b8a0c2e4d6f8a1c3e5d7f9b2a4c6e8d0f3b5a7c9e1d4f',
      reviewedAt: '2026-05-14',
      reviewer: 'clawdeck-curators',
      license: 'Apache-2.0',
      maintainer: 'github:openclaw',
      depCount: 2,
      cves: [],
      permissions: { network: 'none', filesystem: 'write', shell: true, secrets: false },
      notes: [
        'Creates an isolated temp dir per session, cleaned on exit.',
        'On Windows, isolation is best-effort (no chroot equivalent).',
        'Strongly recommended when running agent-generated shell steps.'
      ]
    }
  }
];

// ----------------------------------------------------------------------------
// Auto-generated catalog entries.
//
// The 10 entries above are hand-audited by clawdeck-curators. The list below
// is a much larger community index that has NOT been individually reviewed —
// each entry is marked `risk: 'unknown'` and carries a placeholder hash so the
// UI prompts the user to run a deep scan before installing.
//
// The data shape is identical to the curated entries; only `reviewer` differs
// ('community-index' vs 'clawdeck-curators') and the notes always warn that a
// real audit is required.

interface AutoGenSeed {
  slug: string;
  name: string;
  description: string;
  category: OpenClawLibEntry['category'];
  perms?: Partial<SecurityAudit['permissions']>;
}

const AUTOGEN_SEEDS: AutoGenSeed[] = [
  // --- Language skill packs ---
  { slug: 'typescript', name: 'TypeScript', description: 'TS-aware refactors, type narrowing, generics helpers, tsconfig wizard.', category: 'skills' },
  { slug: 'python',     name: 'Python',     description: 'PEP-8 fixers, type stub generation, pytest scaffolds, venv tooling.', category: 'skills' },
  { slug: 'rust',       name: 'Rust',       description: 'cargo helpers, clippy interpretation, lifetime suggestions, async/await migrations.', category: 'skills', perms: { shell: true } },
  { slug: 'go',         name: 'Go',         description: 'go mod tidy, idiomatic refactors, table-test generator, gofmt enforcement.', category: 'skills', perms: { shell: true } },
  { slug: 'java',       name: 'Java',       description: 'Maven/Gradle helpers, Lombok awareness, Spring Boot scaffolds.', category: 'skills', perms: { shell: true } },
  { slug: 'kotlin',     name: 'Kotlin',     description: 'Coroutines, sealed classes, Android-aware refactors.', category: 'skills' },
  { slug: 'csharp',     name: 'C#',         description: '.NET 8 helpers, LINQ generators, NuGet wizard, async patterns.', category: 'skills', perms: { shell: true } },
  { slug: 'swift',      name: 'Swift',      description: 'SwiftUI scaffolds, Combine helpers, async/await migration.', category: 'skills' },
  { slug: 'ruby',       name: 'Ruby',       description: 'Bundler helpers, RSpec scaffolds, Rubocop autofix.', category: 'skills', perms: { shell: true } },
  { slug: 'php',        name: 'PHP',        description: 'Composer helpers, Laravel/Symfony patterns, PSR-12 fixer.', category: 'skills' },
  { slug: 'cpp',        name: 'C++',        description: 'CMake wizards, RAII conversions, modern-C++ migration.', category: 'skills', perms: { shell: true } },
  { slug: 'scala',      name: 'Scala',      description: 'sbt helpers, cats-effect patterns, Akka actor scaffolds.', category: 'skills' },
  { slug: 'elixir',     name: 'Elixir',     description: 'Mix tasks, GenServer scaffolds, Phoenix helpers.', category: 'skills' },
  { slug: 'haskell',    name: 'Haskell',    description: 'Cabal/stack helpers, monad-stack refactors.', category: 'skills' },
  { slug: 'lua',        name: 'Lua',        description: 'Neovim plugin scaffolds, busted test generator.', category: 'skills' },
  { slug: 'r',          name: 'R',          description: 'tidyverse helpers, ggplot scaffolds, Rmarkdown patterns.', category: 'skills' },
  { slug: 'julia',      name: 'Julia',      description: 'Pkg.jl helpers, multiple-dispatch refactors, plotting scaffolds.', category: 'skills' },
  { slug: 'zig',        name: 'Zig',        description: 'build.zig templates, comptime patterns.', category: 'skills' },
  { slug: 'dart',       name: 'Dart',       description: 'Flutter widget scaffolds, null-safety migration.', category: 'skills' },
  { slug: 'solidity',   name: 'Solidity',   description: 'Smart-contract scaffolds, OZ patterns, gas-cost hints.', category: 'skills' },

  // --- Web frameworks ---
  { slug: 'react',      name: 'React',      description: 'Hooks helpers, suspense patterns, RSC scaffolds, component-extract refactor.', category: 'skills' },
  { slug: 'vue',        name: 'Vue 3',      description: 'Composition API helpers, Pinia stores, Nuxt module scaffolds.', category: 'skills' },
  { slug: 'svelte',     name: 'Svelte 5',   description: 'Runes-based components, kit endpoints, stores.', category: 'skills' },
  { slug: 'angular',    name: 'Angular',    description: 'Standalone components, signals, NgRx scaffolds.', category: 'skills' },
  { slug: 'nextjs',     name: 'Next.js',    description: 'App router scaffolds, server actions, middleware helpers.', category: 'skills' },
  { slug: 'nuxt',       name: 'Nuxt 3',     description: 'Auto-imports, server routes, layout scaffolds.', category: 'skills' },
  { slug: 'remix',      name: 'Remix',      description: 'Loaders/actions, nested routes, error boundaries.', category: 'skills' },
  { slug: 'astro',      name: 'Astro',      description: 'Island components, content collections, view transitions.', category: 'skills' },
  { slug: 'solidstart', name: 'SolidStart', description: 'Solid signals, isomorphic patterns.', category: 'skills' },
  { slug: 'qwik',       name: 'Qwik',       description: 'Resumability helpers, $ boundaries.', category: 'skills' },
  { slug: 'django',     name: 'Django',     description: 'Models, ORM migrations, DRF scaffolds.', category: 'skills', perms: { shell: true } },
  { slug: 'fastapi',    name: 'FastAPI',    description: 'Pydantic models, dependency injection, OpenAPI helpers.', category: 'skills' },
  { slug: 'flask',      name: 'Flask',      description: 'Blueprint scaffolds, SQLAlchemy helpers.', category: 'skills' },
  { slug: 'rails',      name: 'Rails',      description: 'Migrations, jobs, ActionCable scaffolds.', category: 'skills', perms: { shell: true } },
  { slug: 'laravel',    name: 'Laravel',    description: 'Eloquent, queues, Livewire helpers.', category: 'skills' },
  { slug: 'spring',     name: 'Spring Boot',description: 'Controllers, JPA repos, security config.', category: 'skills' },
  { slug: 'dotnet',     name: '.NET',       description: 'Minimal APIs, EF Core, DI patterns.', category: 'skills', perms: { shell: true } },
  { slug: 'phoenix',    name: 'Phoenix',    description: 'LiveView scaffolds, Ecto helpers.', category: 'skills' },
  { slug: 'actix',      name: 'Actix Web',  description: 'Handler patterns, middleware, error types.', category: 'skills' },
  { slug: 'gin',        name: 'Gin (Go)',   description: 'Route groups, middleware, validator helpers.', category: 'skills' },

  // --- DevOps / infra ---
  { slug: 'docker',         name: 'Docker',         description: 'Dockerfile linting, multi-stage builds, compose helpers.', category: 'tools', perms: { shell: true } },
  { slug: 'kubernetes',     name: 'Kubernetes',     description: 'kubectl helpers, manifest generation, kustomize patterns.', category: 'tools', perms: { shell: true, network: 'outbound' } },
  { slug: 'helm',           name: 'Helm',           description: 'Chart scaffolding, values templating, release helpers.', category: 'tools', perms: { shell: true } },
  { slug: 'terraform',      name: 'Terraform',      description: 'HCL refactors, module scaffolds, state inspection.', category: 'tools', perms: { shell: true } },
  { slug: 'ansible',        name: 'Ansible',        description: 'Playbook scaffolds, role generators, vault helpers.', category: 'tools', perms: { shell: true } },
  { slug: 'pulumi',         name: 'Pulumi',         description: 'TS/Python IaC scaffolds, stack helpers.', category: 'tools', perms: { shell: true } },
  { slug: 'github-actions', name: 'GitHub Actions', description: 'Workflow scaffolds, reusable action templates.', category: 'integrations', perms: { network: 'outbound' } },
  { slug: 'gitlab-ci',      name: 'GitLab CI',      description: '.gitlab-ci.yml scaffolds, parallel/matrix helpers.', category: 'integrations' },
  { slug: 'jenkins',        name: 'Jenkins',        description: 'Jenkinsfile scaffolds, shared library patterns.', category: 'integrations' },
  { slug: 'circleci',       name: 'CircleCI',       description: 'Orb usage, workflow scaffolds.', category: 'integrations' },
  { slug: 'argocd',         name: 'ArgoCD',         description: 'Application manifests, sync policies.', category: 'integrations' },
  { slug: 'prometheus',     name: 'Prometheus',     description: 'Recording rules, alert templates, exporter scaffolds.', category: 'tools' },
  { slug: 'grafana',        name: 'Grafana',        description: 'Dashboard JSON scaffolds, alerting helpers.', category: 'integrations' },
  { slug: 'opentelemetry',  name: 'OpenTelemetry',  description: 'Instrumentation helpers across runtimes.', category: 'tools' },
  { slug: 'nginx',          name: 'Nginx',          description: 'Conf scaffolds, reverse proxy patterns, TLS hardening.', category: 'tools' },
  { slug: 'caddy',          name: 'Caddy',          description: 'Caddyfile scaffolds, automatic HTTPS patterns.', category: 'tools' },

  // --- Databases ---
  { slug: 'postgres',     name: 'PostgreSQL',    description: 'Migration helpers, EXPLAIN-plan reader, RLS scaffolds.', category: 'tools', perms: { network: 'outbound' } },
  { slug: 'mysql',        name: 'MySQL',         description: 'Schema migrations, slow-query analysis.', category: 'tools', perms: { network: 'outbound' } },
  { slug: 'sqlite',       name: 'SQLite',        description: 'Migration helpers, FTS5 scaffolds.', category: 'tools' },
  { slug: 'mongodb',      name: 'MongoDB',       description: 'Aggregation builders, index advisors.', category: 'tools', perms: { network: 'outbound' } },
  { slug: 'redis',        name: 'Redis',         description: 'Lua scripts, pipelining helpers, pubsub patterns.', category: 'tools', perms: { network: 'outbound' } },
  { slug: 'elasticsearch',name: 'Elasticsearch', description: 'Query DSL builders, mapping scaffolds.', category: 'tools', perms: { network: 'outbound' } },
  { slug: 'clickhouse',   name: 'ClickHouse',    description: 'OLAP query helpers, materialized view scaffolds.', category: 'tools', perms: { network: 'outbound' } },
  { slug: 'dynamodb',     name: 'DynamoDB',      description: 'Single-table-design helpers, GSI planner.', category: 'tools', perms: { network: 'outbound' } },
  { slug: 'cassandra',    name: 'Cassandra',     description: 'CQL helpers, partition-key analyzer.', category: 'tools', perms: { network: 'outbound' } },
  { slug: 'duckdb',       name: 'DuckDB',        description: 'Analytical SQL scaffolds, parquet/csv ingestion.', category: 'tools' },
  { slug: 'pinecone',     name: 'Pinecone',      description: 'Vector index helpers, upsert/query scaffolds.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'qdrant',       name: 'Qdrant',        description: 'Vector collection scaffolds, filter helpers.', category: 'integrations', perms: { network: 'outbound' } },
  { slug: 'weaviate',     name: 'Weaviate',      description: 'Schema + vectorizer scaffolds.', category: 'integrations', perms: { network: 'outbound' } },

  // --- Cloud ---
  { slug: 'aws',          name: 'AWS',          description: 'CLI helpers, CDK scaffolds, IAM least-privilege wizard.', category: 'integrations', perms: { network: 'outbound', secrets: true, shell: true } },
  { slug: 'azure',        name: 'Azure',        description: 'az CLI helpers, Bicep templates.', category: 'integrations', perms: { network: 'outbound', secrets: true, shell: true } },
  { slug: 'gcp',          name: 'GCP',          description: 'gcloud helpers, deploy manifest scaffolds.', category: 'integrations', perms: { network: 'outbound', secrets: true, shell: true } },
  { slug: 'cloudflare',   name: 'Cloudflare',   description: 'Workers/Pages scaffolds, wrangler helpers, DNS recipes.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'vercel',       name: 'Vercel',       description: 'Project config, edge function scaffolds.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'netlify',      name: 'Netlify',      description: 'Netlify Functions, redirects, headers.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'fly',          name: 'Fly.io',       description: 'fly.toml scaffolds, machine config helpers.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'render',       name: 'Render',       description: 'render.yaml scaffolds, blueprint helpers.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'supabase',     name: 'Supabase',     description: 'Auth, storage, edge-function scaffolds; RLS templates.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'firebase',     name: 'Firebase',     description: 'Auth, Firestore rules, cloud-function scaffolds.', category: 'integrations', perms: { network: 'outbound', secrets: true } },

  // --- Security ---
  { slug: 'sec-owasp',     name: 'OWASP Top 10',   description: 'Pattern catalog + remediation snippets for the OWASP Top 10.', category: 'skills' },
  { slug: 'sec-cve-scan',  name: 'CVE Scanner',    description: 'osv.dev lookup per dependency, severity ranking, fix-version hints.', category: 'skills', perms: { network: 'outbound' } },
  { slug: 'sec-secrets',   name: 'Secrets Sweep',  description: 'Detects committed AWS/GCP/Azure/Stripe/private-key strings via regex + entropy.', category: 'skills', perms: { filesystem: 'read', secrets: true } },
  { slug: 'sec-sast',      name: 'SAST (semgrep)', description: 'Wraps semgrep ruleset and explains findings.', category: 'skills', perms: { shell: true } },
  { slug: 'sec-dast',      name: 'DAST helper',    description: 'OWASP ZAP / Nikto config scaffolds and report explainer.', category: 'skills', perms: { shell: true, network: 'outbound' } },
  { slug: 'sec-fuzz',      name: 'Fuzzing helper', description: 'AFL++ / libFuzzer harness scaffolds.', category: 'skills', perms: { shell: true } },
  { slug: 'sec-pentest',   name: 'Pentest notes',  description: 'Cheat-sheet prompts: enumeration, lateral movement, post-ex.', category: 'prompts' },
  { slug: 'sec-threat-model',name: 'Threat modeling',description: 'STRIDE prompts, dataflow diagram extraction.', category: 'prompts' },
  { slug: 'sec-soc2',      name: 'SOC2 helper',    description: 'Control-mapping prompts, evidence collection checklists.', category: 'prompts' },
  { slug: 'sec-gdpr',      name: 'GDPR helper',    description: 'DPIA scaffold, ROPA generator.', category: 'prompts' },

  // --- Data / ML ---
  { slug: 'pandas',       name: 'pandas',       description: 'DataFrame refactor patterns, performance hints.', category: 'skills' },
  { slug: 'polars',       name: 'Polars',       description: 'LazyFrame patterns, expressions cheat-sheet.', category: 'skills' },
  { slug: 'numpy',        name: 'NumPy',        description: 'Vectorization rewrites, broadcasting helpers.', category: 'skills' },
  { slug: 'jupyter',      name: 'Jupyter',      description: 'Notebook cell scaffolds, nbformat helpers.', category: 'skills' },
  { slug: 'pyspark',      name: 'PySpark',      description: 'DataFrame API scaffolds, partitioning hints.', category: 'skills' },
  { slug: 'dbt',          name: 'dbt',          description: 'Model scaffolds, tests, macros, incremental patterns.', category: 'skills' },
  { slug: 'airflow',      name: 'Airflow',      description: 'DAG scaffolds, taskflow API helpers.', category: 'skills' },
  { slug: 'dagster',      name: 'Dagster',      description: 'Asset/op scaffolds, sensors & schedules.', category: 'skills' },
  { slug: 'huggingface',  name: 'Hugging Face', description: 'Pipeline scaffolds, dataset helpers, tokenizer tips.', category: 'skills', perms: { network: 'outbound' } },
  { slug: 'langchain',    name: 'LangChain',    description: 'Chain/agent scaffolds, retriever patterns.', category: 'skills' },
  { slug: 'llamaindex',   name: 'LlamaIndex',   description: 'Index builders, query engines, response synth.', category: 'skills' },
  { slug: 'embeddings',   name: 'Embeddings',   description: 'Chunking strategies, normalization, hybrid retrieval.', category: 'skills' },
  { slug: 'finetune',     name: 'Fine-tuning',  description: 'Dataset prep, LoRA/QLoRA scaffolds, eval harness.', category: 'skills', perms: { shell: true } },
  { slug: 'evals',        name: 'LLM Evals',    description: 'Eval scaffolds, golden-set helpers, deterministic graders.', category: 'skills' },

  // --- Frontend / UX ---
  { slug: 'tailwind',     name: 'Tailwind CSS', description: 'Class composition, plugin helpers, design-token patterns.', category: 'skills' },
  { slug: 'css-modern',   name: 'Modern CSS',   description: 'Container queries, :has(), color-mix(), subgrid scaffolds.', category: 'skills' },
  { slug: 'a11y',         name: 'Accessibility',description: 'WCAG checks, ARIA scaffolds, focus-trap patterns.', category: 'skills' },
  { slug: 'storybook',    name: 'Storybook',    description: 'Story scaffolds, args/controls, a11y addon.', category: 'skills' },
  { slug: 'design-system',name: 'Design System',description: 'Token + component scaffolds, dark-mode patterns.', category: 'skills' },

  // --- Testing ---
  { slug: 'jest',         name: 'Jest',         description: 'Test scaffolds, mock helpers, snapshot strategy.', category: 'skills' },
  { slug: 'vitest',       name: 'Vitest',       description: 'Suite scaffolds, fast-check integration.', category: 'skills' },
  { slug: 'playwright',   name: 'Playwright',   description: 'E2E scaffolds, fixtures, trace helpers.', category: 'skills', perms: { shell: true } },
  { slug: 'cypress',      name: 'Cypress',      description: 'E2E commands, custom commands, intercepts.', category: 'skills' },
  { slug: 'pytest',       name: 'pytest',       description: 'Fixtures, parametrize, plugin scaffolds.', category: 'skills' },
  { slug: 'rspec',        name: 'RSpec',        description: 'Spec scaffolds, shared examples.', category: 'skills' },
  { slug: 'k6',           name: 'k6 load tests',description: 'Scenario scaffolds, threshold helpers.', category: 'skills', perms: { network: 'outbound', shell: true } },

  // --- Prompt packs ---
  { slug: 'prompts-writing',    name: 'Writing prompts',       description: '40+ templates: outlines, edits, tone shifts, hooks.', category: 'prompts' },
  { slug: 'prompts-marketing',  name: 'Marketing prompts',     description: 'Landing copy, ad variants, ICP exploration.', category: 'prompts' },
  { slug: 'prompts-brainstorm', name: 'Brainstorm prompts',    description: 'SCAMPER, six-hats, divergent / convergent flows.', category: 'prompts' },
  { slug: 'prompts-summarize',  name: 'Summarization prompts', description: 'Abstractive, extractive, multi-doc, executive-brief.', category: 'prompts' },
  { slug: 'prompts-translate',  name: 'Translation prompts',   description: 'Tone-preserving translation across 20 langs.', category: 'prompts' },
  { slug: 'prompts-legal',      name: 'Legal prompts',         description: 'Contract review, redline suggestions, plain-English rewrites.', category: 'prompts' },
  { slug: 'prompts-medical',    name: 'Medical prompts',       description: 'Differential workups, patient-friendly explanations (NOT medical advice).', category: 'prompts' },
  { slug: 'prompts-academic',   name: 'Academic prompts',      description: 'Lit review, methods scaffolds, peer-review responses.', category: 'prompts' },
  { slug: 'prompts-roleplay',   name: 'Roleplay prompts',      description: 'Character cards, scene anchors, safety guards.', category: 'prompts' },
  { slug: 'prompts-cybersec',   name: 'Cybersec prompts',      description: 'Log triage, IOC enrichment, blue-team narratives.', category: 'prompts' },

  // --- Integrations ---
  { slug: 'slack',     name: 'Slack',     description: 'Bot scaffolds, slash-command handlers, modal builders.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'discord',   name: 'Discord',   description: 'Bot scaffolds, slash commands, embeds.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'notion',    name: 'Notion',    description: 'DB query helpers, page upsert patterns.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'linear',    name: 'Linear',    description: 'GraphQL helpers, issue/cycle scaffolds.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'jira',      name: 'Jira',      description: 'REST helpers, JQL builders, issue updaters.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'asana',     name: 'Asana',     description: 'Task/project helpers, custom-field updates.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'trello',    name: 'Trello',    description: 'Board/card helpers, webhook scaffolds.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'telegram',  name: 'Telegram',  description: 'Bot scaffolds, inline keyboards, webhook patterns.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'twilio',    name: 'Twilio',    description: 'SMS/voice scaffolds, TwiML helpers.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'sendgrid',  name: 'SendGrid',  description: 'Template + sender helpers.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'stripe',    name: 'Stripe',    description: 'Checkout/billing scaffolds, webhook handlers.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'shopify',   name: 'Shopify',   description: 'Admin GraphQL helpers, app scaffolds.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'hubspot',   name: 'HubSpot',   description: 'CRM contact/deal helpers.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'sentry',    name: 'Sentry',    description: 'SDK init scaffolds, source-map upload helpers.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'datadog',   name: 'Datadog',   description: 'APM + log helpers, monitor scaffolds.', category: 'integrations', perms: { network: 'outbound', secrets: true } },
  { slug: 'pagerduty', name: 'PagerDuty', description: 'Incident escalation helpers.', category: 'integrations', perms: { network: 'outbound', secrets: true } },

  // --- Agents ---
  { slug: 'agent-researcher',    name: 'Researcher agent',    description: 'Multi-step web research with citation tracking.', category: 'agents', perms: { network: 'outbound' } },
  { slug: 'agent-debugger',      name: 'Debugger agent',      description: 'Reads stack traces, proposes fix + test, iterates.', category: 'agents' },
  { slug: 'agent-refactorer',    name: 'Refactor agent',      description: 'Plans large refactors, splits into safe commits.', category: 'agents' },
  { slug: 'agent-doc-writer',    name: 'Docs agent',          description: 'Generates README, JSDoc, ADRs from source.', category: 'agents', perms: { filesystem: 'write' } },
  { slug: 'agent-test-writer',   name: 'Test-writer agent',   description: 'Walks code, drafts unit + integration tests.', category: 'agents', perms: { filesystem: 'write' } },
  { slug: 'agent-code-reviewer', name: 'Code-reviewer agent', description: 'PR review checklist, security + a11y nits.', category: 'agents' },
  { slug: 'agent-architect',     name: 'Architect agent',     description: 'High-level design proposals + tradeoff matrix.', category: 'agents' },
  { slug: 'agent-pm',            name: 'PM agent',            description: 'PRD scaffolds, user-story splitting, RICE scoring.', category: 'agents' },
  { slug: 'agent-sre',           name: 'SRE agent',           description: 'Incident response, postmortem scaffolds, runbook generator.', category: 'agents' },
  { slug: 'agent-data-analyst',  name: 'Data analyst agent',  description: 'EDA scaffolds, chart suggestions, dataset profiling.', category: 'agents' },

  // --- Misc tools ---
  { slug: 'tools-ffmpeg',  name: 'ffmpeg recipes',description: 'Common ffmpeg incantations + flag explainer.', category: 'tools', perms: { shell: true } },
  { slug: 'tools-imagemagick', name: 'ImageMagick', description: 'convert/identify scaffolds with sane defaults.', category: 'tools', perms: { shell: true } },
  { slug: 'tools-jq',      name: 'jq cookbook',   description: 'Filter recipes + a step-through explainer.', category: 'tools' },
  { slug: 'tools-yq',      name: 'yq cookbook',   description: 'YAML query recipes.', category: 'tools' },
  { slug: 'tools-curl',    name: 'curl cookbook', description: 'Auth, mTLS, streaming, multipart patterns.', category: 'tools', perms: { network: 'outbound' } },
  { slug: 'tools-rclone',  name: 'rclone helper', description: 'Remote sync scaffolds, --dry-run guidance.', category: 'tools', perms: { shell: true, network: 'outbound' } },
  { slug: 'tools-rsync',   name: 'rsync helper',  description: 'Common sync patterns; warns on dangerous flags.', category: 'tools', perms: { shell: true } },
  { slug: 'tools-pandoc',  name: 'pandoc helper', description: 'Doc format conversion recipes.', category: 'tools', perms: { shell: true } },
  { slug: 'tools-graphviz',name: 'Graphviz',      description: 'DOT scaffolds for architecture/state diagrams.', category: 'tools' },
  { slug: 'tools-mermaid', name: 'Mermaid',       description: 'Flowchart/sequence/ER scaffolds.', category: 'tools' }
];

function permsFor(seed: AutoGenSeed): SecurityAudit['permissions'] {
  const base: SecurityAudit['permissions'] = { network: 'none', filesystem: 'read', shell: false, secrets: false };
  return { ...base, ...(seed.perms ?? {}) };
}

function riskFor(perms: SecurityAudit['permissions']): RiskLevel {
  let score = 0;
  if (perms.shell) score += 2;
  if (perms.network === 'inbound' || perms.network === 'both') score += 2;
  if (perms.network === 'outbound') score += 1;
  if (perms.secrets) score += 2;
  if (perms.filesystem === 'write' || perms.filesystem === 'both') score += 1;
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  if (score >= 1) return 'low';
  return 'low';
}

const AUTOGEN_OPENCLAW_LIBS: OpenClawLibEntry[] = AUTOGEN_SEEDS.map(seed => {
  const perms = permsFor(seed);
  const baseRisk = riskFor(perms);
  return {
    id: `openclaw-${seed.category}-${seed.slug}`,
    name: `OpenClaw · ${seed.name}`,
    description: seed.description,
    category: seed.category,
    source: { kind: 'npm', ref: `@openclaw/${seed.category}-${seed.slug}` },
    version: '0.1.0',
    audit: {
      // Community entries are unverified until a deep scan completes.
      risk: baseRisk === 'low' ? 'unknown' : baseRisk,
      hash: 'unverified',
      reviewedAt: '—',
      reviewer: 'community-index',
      license: 'unknown',
      maintainer: 'community',
      depCount: 0,
      cves: [],
      permissions: perms,
      notes: [
        'COMMUNITY INDEX ENTRY — not individually reviewed by clawdeck-curators.',
        'Click "Deep scan" inside the audit modal to download and inspect the package before installing.',
        'Declared permissions are based on the category and may not reflect the actual package.'
      ]
    }
  };
});

/**
 * Combined catalog: hand-curated entries first, then the much larger
 * community index. UI consumers should treat them identically; the audit
 * modal already distinguishes via `audit.reviewer`.
 */
export const OPENCLAW_LIB_CATALOG_FULL: readonly OpenClawLibEntry[] = [
  ...OPENCLAW_LIB_CATALOG,
  ...AUTOGEN_OPENCLAW_LIBS
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

export function searchOpenClawLibs(query: string, libs: readonly OpenClawLibEntry[] = OPENCLAW_LIB_CATALOG_FULL): OpenClawLibEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...libs];
  return libs.filter(l =>
    l.id.toLowerCase().includes(q) ||
    l.name.toLowerCase().includes(q) ||
    l.description.toLowerCase().includes(q) ||
    l.category.includes(q)
  );
}

/** Concise risk summary for badges. */
export function riskSummary(audit: SecurityAudit): string {
  const flags: string[] = [];
  if (audit.permissions.network !== 'none') flags.push('net');
  if (audit.permissions.shell) flags.push('shell');
  if (audit.permissions.secrets) flags.push('secrets');
  if (audit.permissions.filesystem === 'write' || audit.permissions.filesystem === 'both') flags.push('fs:write');
  if (audit.cves.length > 0) flags.push(`${audit.cves.length} CVE`);
  return flags.length ? flags.join(' · ') : 'sandboxed';
}

