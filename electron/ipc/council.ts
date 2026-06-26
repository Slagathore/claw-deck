// Council Orchestrator IPC (BOOTSTRAP §3 Phase 3).
//   council:start  → resolve roster + assignment, build transport + executor
//                    hooks, run the protocol in the background, stream
//                    council:event to the renderer, persist council_runs.
//   council:cancel → flip the run's abort signal.
//   council:list   → recent runs from council_runs.
// Gates auto-parse their verdict for now; interactive approveGate is a Phase-4
// refinement (the event stream already surfaces every verdict).

import { ipcMain, BrowserWindow } from 'electron';
import { randomUUID, createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getDb } from './db';
import { getSetting } from './settings';
import { appendAudit } from './security';
import { PROTOCOLS, Protocol } from '../council/protocol';
import { runProtocol, ExecutorHooks, CouncilEvent, ResumeState, RunResult } from '../council/run';
import { METHODS, runMethod, printMethodCard, buildForgeCycle, buildCharter } from '../council/methods';
import { runAutoloop } from '../council/autoloop';
import * as gdd from '../council/gdd';
import { makeTransport, TransportConfig } from '../council/transport';
import { buildToolSet, ToolSet, McpServerSpec, ToolDef } from '../council/mcpClient';
import { atlasDbPath, openAtlas, asQueryable } from '../atlas/db';
import { scanWorkspace, writeIndex } from '../atlas/index';
import { locate } from '../atlas/query';
import { advisorKey, ADVISOR_ELIGIBILITY, advisorTemp, FusionRole } from '../council/roles';
import { looksLikeProviderError } from '../council/providerError';
import { assetGuidance, rankEditors, ProbedCaps } from '../council/capabilities';
import { probeCapabilities } from '../council/capabilityProbe';
import { RosterAgent, SessionAssignment, validateAssignment, resolveAgents } from '../council/agents';
import { createWorktree, captureDiff, writeArtifacts, applyToLiveTree, removeWorktree, Worktree } from '../executor/worktree';
import { applyDiffToWorktree } from '../executor/applyDiff';
import { validateWorktree } from '../executor/validate';
import { parsePorcelain } from '../executor/gitStatus';
import { git } from '../executor/git';
import { createSnapshot } from '../selfUpgrade/snapshot';
import { runCaptured } from './runner';
import { trace } from './trace';

const signals = new Map<string, { aborted: boolean; controller: AbortController }>();

/** Abort every in-flight council (kills CLI children + disposes tool clients + aborts HTTP). Called on quit. */
export function cancelAllCouncils(): void {
  for (const s of signals.values()) { s.aborted = true; try { s.controller.abort(); } catch { /* already aborted */ } }
  signals.clear();
}

interface McpServerCfg { name: string; command: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }

/** Write claw-deck's configured MCP servers to a temp file claude can consume
 *  (--mcp-config). This is how an actor gets tools: code-brain (Atlas) + anything
 *  the user adds in Settings → MCP Servers (e.g. a Blender MCP). Returns null if none. */
function writeClaudeMcpConfig(): string | null {
  try {
    const servers = getSetting<McpServerCfg[]>('mcpServers', []).filter((s) => s && s.command && s.enabled !== false);
    if (!servers.length) return null;
    const cfg = { mcpServers: Object.fromEntries(servers.map((s) => [s.name, { command: s.command, args: s.args ?? [], env: s.env ?? {} }])) };
    const p = path.join(os.tmpdir(), `claw-mcp-${randomUUID().slice(0, 8)}.json`);
    fs.writeFileSync(p, JSON.stringify(cfg), 'utf8');
    return p;
  } catch { return null; }
}

/** Extra claude flags granting tool + filesystem reach: configured MCP servers,
 *  the repo root, and any user-listed extra dirs (e.g. a Blender project folder). */
function claudeExtraArgs(repo?: string): string[] {
  const args: string[] = [];
  const mcp = writeClaudeMcpConfig();
  if (mcp) args.push('--mcp-config', mcp);
  if (repo) args.push('--add-dir', repo);
  for (const d of getSetting<string[]>('actorExtraDirs', [])) if (d) args.push('--add-dir', d);
  return args;
}

/** Probe a repo for environment ground-truth (engine versions, plugins, stack)
 *  so the council is TOLD the facts it can't infer — e.g. "Godot 4.3+, don't use
 *  APIs removed before it." User edits the result before starting. */
function detectEnv(repo: string): string {
  const facts: string[] = [];
  const read = (rel: string) => { try { return fs.readFileSync(path.join(repo, rel), 'utf8'); } catch { return ''; } };
  const lsdir = (rel: string) => { try { return fs.readdirSync(path.join(repo, rel)); } catch { return [] as string[]; } };

  const projGodot = read('project.godot');
  if (projGodot) {
    const feat = projGodot.match(/config\/features\s*=\s*PackedStringArray\(([^)]*)\)/);
    const ver = feat?.[1].match(/"(\d+\.\d+)"/)?.[1];
    facts.push(ver
      ? `Engine: Godot ${ver} (detected from project.godot). Use ONLY GDScript/Godot APIs that exist in ${ver}; do NOT use APIs deprecated or removed before ${ver}.`
      : 'Engine: Godot (project.godot present; version not detected — set it here).');
    const addons = lsdir('addons');
    if (addons.length) facts.push(`Godot addons/plugins installed: ${addons.join(', ')}.`);
  }
  const pkg = read('package.json');
  if (pkg) { try { const j = JSON.parse(pkg); facts.push(`Node project. ${j.engines?.node ? `node ${j.engines.node}. ` : ''}Key deps: ${Object.keys(j.dependencies ?? {}).slice(0, 12).join(', ') || '(none)'}.`); } catch { /* ignore */ } }
  if (read('pyproject.toml') || read('requirements.txt')) facts.push('Python project (pyproject.toml / requirements.txt present).');
  if (read('Cargo.toml')) facts.push('Rust project (Cargo.toml).');
  if (read('go.mod')) facts.push('Go project (go.mod).');
  facts.push(`Host OS: ${process.platform} (${process.arch}).`);
  return facts.join('\n');
}

/** Prepend authoritative environment facts to the task so agents can't drift onto stale APIs. */
function withContext(task: string, context?: string): string {
  return context && context.trim()
    ? `[ENVIRONMENT — authoritative ground truth; do NOT contradict or assume otherwise]\n${context.trim()}\n\n---\n${task}`
    : task;
}

// ----------------------------- FORGE campaign helpers -----------------------------

const campaignDir = (repo: string) => path.join(repo, '.fusion', 'campaign');
const gddPath = (repo: string) => path.join(campaignDir(repo), 'GDD.md');

/** Working-tree paths that are dirty right now (untracked + modified). */
async function dirtyPaths(repo: string): Promise<string[]> {
  try { return parsePorcelain((await git(repo, ['status', '--porcelain', '--untracked-files=all'])).stdout); }
  catch { return []; }
}

/** Commit ONLY what the loop produced this iteration — everything dirty EXCEPT the user's
 *  pre-existing WIP (`protectedPaths`, captured at loop start). Never `git add -A` (which
 *  swept unrelated changes into forge commits), never an empty commit. Returns the file list
 *  + the staged diff so the run can SHOW exactly what it wrote and where. */
async function forgeCommit(repo: string, message: string, protectedPaths: Set<string>): Promise<{ files: string[]; diff: string; sha: string; committed: boolean }> {
  const sha0 = async () => { try { return (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim(); } catch { return ''; } };
  const toStage = (await dirtyPaths(repo)).filter((p) => !protectedPaths.has(p));
  if (!toStage.length) return { files: [], diff: '', sha: await sha0(), committed: false };
  try { await git(repo, ['add', '--', ...toStage]); } catch { /* best-effort */ }
  let diff = ''; try { diff = (await git(repo, ['diff', '--cached'])).stdout; } catch { /* none */ }
  try { await git(repo, ['commit', '-m', message, '--no-verify']); } catch { /* best-effort */ }
  return { files: toStage, diff, sha: await sha0(), committed: true };
}

/** (Re)build the Atlas symbol index for a repo so the design phases (diverge/steelman)
 *  ground in the accumulating code. Best-effort + synchronous; never throws. */
function indexRepo(repo: string): { ok: boolean; symbols?: number } {
  try {
    const db = asQueryable(openAtlas(repo));
    const { parse, fileMeta, entryFiles } = scanWorkspace(repo);
    const counts: any = writeIndex(db, { parse, fileMeta, entryFiles }, Date.now());
    return { ok: true, symbols: counts?.symbols ?? counts?.symbolCount };
  } catch { return { ok: false }; }
}

/** Read a capped concat of the repo's existing top-level + docs/ markdown (excluding the
 *  GDD itself) so the charter respects docs already present (§ brownfield). */
function readRepoMarkdown(repo: string): string {
  const parts: string[] = [];
  const seen = new Set([gddPath(repo)]);
  const scan = (dir: string, max: number) => {
    try {
      for (const f of fs.readdirSync(dir).filter((n) => /\.md$/i.test(n)).slice(0, max)) {
        const p = path.join(dir, f);
        if (seen.has(p)) continue; seen.add(p);
        try { const c = fs.readFileSync(p, 'utf8'); if (c.trim()) parts.push(`### ${path.relative(repo, p)}\n${c.slice(0, 4000)}`); } catch { /* skip */ }
      }
    } catch { /* no dir */ }
  };
  scan(repo, 6);
  scan(path.join(repo, 'docs'), 6);
  return parts.join('\n\n').slice(0, 12000);
}

/** Charter task: instruct the panel to author/refine a GDD ending in a strict `## Backlog`. */
function charterTask(concept: string, design: boolean, existingMd: string, otherMd: string): string {
  const spec = [
    'Author a complete Game Design Document (the "bible") for the game described below.',
    'Be concrete and exhaustive: vision, core loop, design pillars, EVERY system/subsystem, content, controls, UI, and win/lose conditions.',
    'END the document with a section titled EXACTLY "## Backlog": an ordered checklist of buildable items, one per line, in THIS exact grammar:',
    '    - [ ] [S-001] Short imperative title | deps: S-000 | rigor: full | slice | accept: criterion a; criterion b',
    'Backlog rules:',
    '  • Build items use ids [S-NNN].' + (design ? ' OPEN design questions still to decide use [Q-NNN] with the [?] marker, e.g. "- [?] [Q-001] Combat: real-time or turn-based?".' : ''),
    '  • The FIRST item MUST be a playable vertical slice, tagged `slice`, `rigor: full`.',
    '  • `deps:` = ids that must ship first (omit if none). `rigor: light` for trivial items, `full` for core/risky ones.',
    '  • `accept:` = 1–4 concrete, demonstrable checks separated by semicolons — these become the regression tests.',
    '  • Order so dependencies precede dependents and the game grows from a playable core outward.',
    design ? '  • Add a [?] [Q-NNN] question item for EVERY choice not yet settled (engine, art direction, combat model, progression, economy, …).' : '',
  ].filter(Boolean).join('\n');
  const material = [
    existingMd ? `An existing GDD is present — REFINE and EXTEND it; preserve prior decisions and any [x] done items verbatim:\n\n${existingMd.slice(0, 16000)}` : '',
    otherMd ? `Other reference docs already in the repo (respect them):\n\n${otherMd}` : '',
  ].filter(Boolean).join('\n\n---\n\n');
  return `${spec}\n\n=== GAME CONCEPT ===\n${concept}${material ? `\n\n=== EXISTING MATERIAL ===\n${material}` : ''}`;
}

/** One build iteration's task: implement just this batch, follow the bible, don't regress. */
function buildIterationTask(batch: gdd.GddItem[], gddMd: string, doneAccept: string): string {
  const items = batch.map((i) => `- [${i.id}] ${i.title}\n  Acceptance: ${i.accept || '(use your judgment, consistent with the GDD)'}`).join('\n');
  return [
    'You are building ONE increment of a game assembled across many iterations.',
    'Implement ONLY the backlog items listed below — do not start other items. Produce real, complete, runnable code (the build step writes it to the working tree).',
    'Follow the Game Design Document (the bible) below as the source of truth. You may PROPOSE new/split items by emitting lines beginning "GDD-AMENDMENT:" followed by a backlog line in the GDD grammar — do NOT renumber or rewrite existing items.',
    'GOLDEN GATE: an automated compile + test gate runs over the WHOLE project after you build. Add or extend an automated test that asserts each item\'s acceptance criteria (in the project\'s test runner — npm test / pytest / cargo test / go test; for vanilla web, ensure every script parses and wire a smoke test if one exists). Keep ALL existing tests green — if your change would break a prior test, fix it.',
    assetGuidance(),
    doneAccept ? `Do NOT regress already-shipped behavior. These criteria must STILL hold after your change:\n${doneAccept}` : '',
    '',
    '=== ITEMS TO BUILD THIS ITERATION ===',
    items,
    '',
    '=== GAME DESIGN DOCUMENT (the bible) ===',
    gddMd.slice(0, 18000),
  ].filter(Boolean).join('\n');
}

/** One design iteration's task: resolve these questions into decisions + implied items. */
function designIterationTask(batch: gdd.GddItem[], gddMd: string): string {
  const qs = batch.map((i) => `- [${i.id}] ${i.title}`).join('\n');
  return [
    'You are resolving open DESIGN QUESTIONS for a game and recording decisions in its design document (NO code).',
    'For EACH question below: decide it, justify briefly, and state the choice. Then emit the concrete build items the decision implies as lines beginning "GDD-AMENDMENT:" in the backlog grammar (e.g. "GDD-AMENDMENT: - [ ] [S-020] … | rigor: full | accept: …").',
    'Output a "## Design decisions" section with one subsection per question (decision + rationale), then the GDD-AMENDMENT lines.',
    '',
    '=== QUESTIONS TO RESOLVE ===',
    qs,
    '',
    '=== GAME DESIGN DOCUMENT (the bible) ===',
    gddMd.slice(0, 18000),
  ].join('\n');
}

// Prologue: a run that is paused after generating clarifying questions, waiting
// for the user's answers before the real protocol launches. Held in memory until
// answered (the prologue is interactive and resolved within the session).
interface ProloguePending { repo?: string; protocol: Protocol; roster: RosterAgent[]; assignment: SessionAssignment; task: string; agentOptions?: Record<string, { temperature?: number; top_p?: number }>; agentPersonas?: Record<string, string>; forceBlind?: boolean; groundInRepo?: boolean; questions: string[] }
const pendingPrologue = new Map<string, ProloguePending>();

/** Parse a consolidated questions reply into ≤6 clean question strings. */
function parseQuestions(text: string): string[] {
  const seen = new Set<string>();
  return (text || '').split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim())
    .filter((l) => l.length > 3 && !seen.has(l.toLowerCase()) && (seen.add(l.toLowerCase()), true))
    .slice(0, 6);
}

/** Build a per-agent sampling map from a "run hot" selection (raised temperature). */
function buildAgentOptions(hot?: { agents?: string[]; temperature?: number; top_p?: number }, roster?: RosterAgent[]): Record<string, { temperature?: number; top_p?: number }> | undefined {
  const map: Record<string, { temperature?: number; top_p?: number }> = {};
  // base: each advisor's recommended sampling temperature (e.g. Gemini-hot @ 1.1 for its
  // diverger/wildcard/ideator roles). Applied wherever that model is called.
  for (const a of roster ?? []) { const t = advisorTemp(a); if (t != null) map[a.id] = { temperature: t }; }
  // override: the user's per-session "run hot" for the agents they picked.
  if (hot?.agents?.length) {
    const temperature = hot.temperature ?? 1.15;
    for (const id of hot.agents) map[id] = { temperature, ...(hot.top_p != null ? { top_p: hot.top_p } : {}) };
  }
  return Object.keys(map).length ? map : undefined;
}

/** The READ-ONLY MCP servers a cloud panelist may use: Context7 (docs) + this
 *  workspace's Atlas code-brain (code queries). Never the write/desktop servers. */
function scopedReadOnlyServers(repo?: string): McpServerSpec[] {
  const all = getSetting<McpServerCfg[]>('mcpServers', []);
  const out: McpServerSpec[] = [];
  const ctx7 = all.find((s) => s?.name === 'context7' && s.command && s.enabled !== false);
  if (ctx7) out.push({ name: 'context7', command: ctx7.command, args: ctx7.args, env: ctx7.env });
  if (repo) {
    const dbPath = atlasDbPath(repo);
    if (fs.existsSync(dbPath)) out.push({ name: 'code-brain', command: 'node', args: [path.join(__dirname, '..', 'atlas', 'codeBrainServer.js'), '--db', dbPath], cwd: repo });
  }
  return out;
}

/** Digest of the files changed in the latest commit (the iteration's checkpoint), with their
 *  contents capped, so the goal-checker can VERIFY what was actually produced — not just the
 *  proposal text. Returns '' when nothing changed or git is unavailable. */
async function changedFilesDigest(repo: string, maxFiles = 8, perFileChars = 12000, totalChars = 40000): Promise<string> {
  const safeGit = async (args: string[]) => { try { return (await git(repo, args)).stdout.trim(); } catch { return ''; } };
  let names = await safeGit(['diff', '--name-only', 'HEAD~1', 'HEAD']);
  if (!names) names = await safeGit(['show', '--name-only', '--pretty=format:', 'HEAD']);
  const files = names.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, maxFiles);
  let budget = totalChars;
  const parts: string[] = [];
  for (const f of files) {
    try {
      const abs = path.join(repo, f);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      const full = fs.readFileSync(abs, 'utf8');
      // CRITICAL: mark a display-clip explicitly, or the checker mistakes our clip for a
      // truncated file and never accepts the goal as met.
      const shown = full.length > perFileChars ? `${full.slice(0, perFileChars)}\n…[display-clipped here — file is ${full.length} chars total on disk, this is NOT a truncation]` : full;
      const block = `--- ${f} (${full.length} chars) ---\n${shown}`;
      if (block.length > budget && parts.length) break;
      budget -= block.length; parts.push(block);
    } catch { /* skip unreadable */ }
  }
  return parts.join('\n\n');
}

/** Optional method capabilities for a repo: Atlas query, file-read grounding, and build.
 *  autoApply=true (loop) applies a successful build to the live tree so iterations
 *  accumulate; false (one-shot) leaves the diff in the worktree for review. */
function methodCaps(repo: string | undefined, idBase: string, controller: AbortController, autoApply: boolean) {
  const atlasQuery = repo && fs.existsSync(atlasDbPath(repo))
    ? async (q: string) => { try { const hits = locate(asQueryable(openAtlas(repo!)), q, 15); return hits.length ? hits.map((h) => `${h.location} — ${h.name} (${h.kind}, ${h.status})`).join('\n') : null; } catch { return null; } }
    : undefined;
  const readFiles = repo
    ? async (paths: string[]) => { const out: Record<string, string> = {}; const root = path.resolve(repo); for (const rel of paths.slice(0, 8)) { try { const abs = path.resolve(root, rel); if (abs.startsWith(root) && fs.existsSync(abs) && fs.statSync(abs).isFile() && fs.statSync(abs).size < 200_000) out[rel] = fs.readFileSync(abs, 'utf8'); } catch { /* skip */ } } return out; }
    : undefined;
  const build = repo
    ? async (artifact: string, builder: RosterAgent) => {
        if (!builder.capabilities?.canEdit) return { ok: false, error: `${builder.displayName} cannot edit files` };
        const ex = makeExecutorHooks(repo, idBase, controller.signal);
        if (!ex.delegate) return { ok: false, error: 'no delegate capability' };
        const r = await ex.delegate(builder, `Implement the following into the working tree directly.\nFIRST write a CHANGE_PLAN.md mapping what you will change and why. THEN make the changes, keeping them focused. When done, summarize what changed.\n\n${artifact}`);
        if (r.ok && autoApply) { const v = await ex.validate(); if (v.ok) await ex.approve(); }
        return { ok: r.ok, diff: r.diff, error: r.error };
      }
    : undefined;
  const runDir = repo ? path.join(repo, '.fusion', `method-${idBase}`) : undefined;
  return { atlasQuery, readFiles, build, runDir };
}

function transportConfig(repo?: string, abortSignal?: AbortSignal, agentOptions?: Record<string, { temperature?: number; top_p?: number }>, toolset?: ToolSet, agentPersonas?: Record<string, string>): TransportConfig {
  // Local Ollama serves *:cloud models itself (no key). ollamaCloudUrl is an
  // OPTIONAL override for a genuinely remote OpenAI-compat endpoint; blank → local.
  const localV1 = getSetting('ollamaUrl', 'http://localhost:11434').replace(/\/$/, '') + '/v1';
  return {
    ollamaCloudUrl: getSetting('ollamaCloudUrl', '') || localV1,
    ollamaCloudKey: getSetting('ollamaCloudKey', '') || process.env.OLLAMA_API_KEY || undefined,
    ollamaLocalUrl: localV1,
    openaiCompatUrl: getSetting('openaiCompatUrl', 'http://localhost:11434/v1'),
    openaiCompatKey: getSetting('openaiCompatKey', '') || undefined,
    paths: { claude: getSetting('claudeCodePath', 'claude'), codex: getSetting('codexPath', 'codex'), openclaw: getSetting('openclawPath', 'openclaw') || 'openclaw' },
    bridgePort: getSetting('clawBridgePort', 39217),
    abortSignal,
    // default: use the claude-login subscription, not API credits → drop ANTHROPIC_API_KEY for claude spawns
    claudeUnsetEnv: getSetting('claudeUseApiKey', false) ? undefined : ['ANTHROPIC_API_KEY'],
    claudeExtraArgs: claudeExtraArgs(repo),
    actorTimeoutMs: getSetting('actorTimeoutMs', 600000),
    agentOptions,
    agentPersonas,
    tools: toolset?.tools,
    callTool: toolset?.call,
    toolCallCap: getSetting('toolCallCap', 12),
    cwd: repo,
  };
}

/** Map { agentId → personaId } to { agentId → persona prompt } using fusionPersonas. */
function buildAgentPersonas(personas?: Record<string, string>): Record<string, string> | undefined {
  if (!personas || !Object.keys(personas).length) return undefined;
  const defs = getSetting<{ id: string; name: string; prompt: string }[]>('fusionPersonas', []);
  const byId = new Map(defs.map((p) => [p.id, p]));
  const out: Record<string, string> = {};
  for (const [agentId, personaId] of Object.entries(personas)) { const p = byId.get(personaId); if (p) out[agentId] = `${p.name} — ${p.prompt}`; }
  return Object.keys(out).length ? out : undefined;
}

async function probeAgent(agent: RosterAgent, repo?: string): Promise<{ ok: boolean; detail: string }> {
  try {
    trace('council:probe:start', { agentId: agent.id, transport: agent.transport, model: agent.model, binary: agent.binary, repo });
    if (agent.transport === 'claude-code' || agent.transport === 'codex' || agent.transport === 'openclaw') {
      const cfg = transportConfig(repo);
      const binary = agent.transport === 'claude-code'
        ? (cfg.paths?.claude ?? agent.binary ?? 'claude')
        : agent.transport === 'codex'
          ? (cfg.paths?.codex ?? agent.binary ?? 'codex')
          : (cfg.paths?.openclaw ?? agent.binary ?? 'openclaw');
      const args = agent.transport === 'openclaw' ? ['--version'] : ['--help'];
      const r = await runCaptured({ binary, args, cwd: repo, timeoutMs: 8000 });
      const text = (r.stdout || r.stderr).trim().slice(0, 300);
      const out = r.code === 0 || text ? { ok: true, detail: text || `${binary} responded` } : { ok: false, detail: `${binary} exited ${r.code}` };
      trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: out.ok, detail: out.detail, binary });
      return out;
    }
    if (agent.transport === 'ollama-cloud' || agent.transport === 'ollama-local') {
      const base = getSetting<string>('ollamaUrl', 'http://localhost:11434').replace(/\/$/, '');
      const model = agent.model ?? '';
      const r = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return { ok: false, detail: `Ollama HTTP ${r.status}` };
      const j: any = await r.json();
      const models: any[] = j.models ?? [];
      const found = models.find((m: any) => m.name === model || m.model === model);
      if (agent.transport === 'ollama-cloud') {
        if (!model) {
          const out = { ok: false, detail: 'missing cloud model' };
          trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: false, detail: out.detail });
          return out;
        }
        if (!found) {
          const out = { ok: false, detail: `${model} not listed by local Ollama; run "ollama pull ${model}" to create the cloud stub` };
          trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: false, detail: out.detail });
          return out;
        }
        if (!found.remote_host) {
          const out = { ok: false, detail: `${model} is local-only; choose a model with remote_host / :cloud / -cloud for ollama-cloud` };
          trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: false, detail: out.detail });
          return out;
        }
        const out = { ok: true, detail: `${model} cloud via ${found.remote_host}${found.remote_model ? ` (${found.remote_model})` : ''}` };
        trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: true, detail: out.detail, remoteHost: found.remote_host, remoteModel: found.remote_model });
        return out;
      }
      const out = !model || found ? { ok: true, detail: model ? `${model} local model available` : `${models.length} models available` } : { ok: false, detail: `${model} not pulled in Ollama` };
      trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: out.ok, detail: out.detail });
      return out;
    }
    if (agent.transport === 'openai-compat') {
      return agent.model ? { ok: true, detail: 'configured; run starts will verify the endpoint' } : { ok: false, detail: 'missing model' };
    }
    if (agent.transport === 'vscode-lm') {
      const st = await (await import('../bridge/client')).bridgeStatus(getSetting('clawBridgePort', 39217));
      return st.connected ? { ok: true, detail: 'VS Code bridge connected' } : { ok: false, detail: 'VS Code bridge offline' };
    }
    const out = { ok: false, detail: `unknown transport ${agent.transport}` };
    trace('council:probe:finish', { agentId: agent.id, transport: agent.transport, ok: false, detail: out.detail });
    return out;
  } catch (e: any) {
    const out = { ok: false, detail: e?.message ?? String(e) };
    trace('council:probe:error', { agentId: agent.id, transport: agent.transport, detail: out.detail });
    return out;
  }
}

function outputSnippet(r: { code: number | null; stdout: string; stderr: string }): string {
  const text = `${r.stdout}\n${r.stderr}`.trim();
  return text.slice(Math.max(0, text.length - 1500)) || `process exited ${r.code}`;
}

async function runEditingDelegate(agent: RosterAgent, prompt: string, wt: Worktree, cfg: TransportConfig): Promise<{ ok: boolean; output?: string; error?: string }> {
  trace('council:delegate:start', { agentId: agent.id, transport: agent.transport, worktree: wt.dir, promptBytes: prompt.length });
  if (agent.transport === 'claude-code') {
    const binary = cfg.paths?.claude ?? agent.binary ?? 'claude';
    const r = await runCaptured({
      binary,
      args: ['--print', '--input-format', 'text', '--permission-mode', 'bypassPermissions', '--no-session-persistence', ...(cfg.claudeExtraArgs ?? [])],
      input: prompt,
      cwd: wt.dir,
      timeoutMs: cfg.actorTimeoutMs ?? 600000,
      signal: cfg.abortSignal,
      unsetEnv: cfg.claudeUnsetEnv,
    });
    const out = r.code === 0 ? { ok: true, output: outputSnippet(r) } : { ok: false, error: outputSnippet(r) };
    trace('council:delegate:finish', { agentId: agent.id, transport: agent.transport, ok: out.ok, code: r.code, stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length });
    return out;
  }

  if (agent.transport === 'codex') {
    const binary = cfg.paths?.codex ?? agent.binary ?? 'codex';
    const r = await runCaptured({
      binary,
      args: ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '--color', 'never', '-'],
      input: prompt,
      cwd: wt.dir,
      timeoutMs: cfg.actorTimeoutMs ?? 600000,
      signal: cfg.abortSignal,
    });
    const out = r.code === 0 ? { ok: true, output: outputSnippet(r) } : { ok: false, error: outputSnippet(r) };
    trace('council:delegate:finish', { agentId: agent.id, transport: agent.transport, ok: out.ok, code: r.code, stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length });
    return out;
  }

  if (agent.transport === 'openclaw') {
    const binary = cfg.paths?.openclaw ?? agent.binary ?? 'openclaw';
    const args = ['agent', '--local', '--json', '--message', prompt];
    if (agent.model) args.push('--model', agent.model);
    const r = await runCaptured({ binary, args, cwd: wt.dir, timeoutMs: cfg.actorTimeoutMs ?? 600000, signal: cfg.abortSignal });
    const out = r.code === 0 ? { ok: true, output: outputSnippet(r) } : { ok: false, error: outputSnippet(r) };
    trace('council:delegate:finish', { agentId: agent.id, transport: agent.transport, ok: out.ok, code: r.code, stdoutBytes: r.stdout.length, stderrBytes: r.stderr.length });
    return out;
  }

  // Ollama / OpenAI-compatible cloud models: give them real file tools (scoped to the
  // worktree) and run an agentic write loop, so a tool-capable cloud model (e.g. Kimi)
  // can author/overwrite files directly — no Claude/Codex required.
  if (agent.transport === 'ollama-cloud' || agent.transport === 'ollama-local' || agent.transport === 'openai-compat') {
    if (!agent.capabilities?.canEdit) {
      const out = { ok: false, error: `${agent.displayName} is not marked as an editor — enable "edits" for it in the Agent Roster to let it write files.` };
      trace('council:delegate:finish', { agentId: agent.id, transport: agent.transport, ok: false, error: out.error });
      return out;
    }
    return runCloudEditingDelegate(agent, prompt, wt, cfg);
  }

  const out = { ok: false, error: `${agent.displayName} uses ${agent.transport}; direct file editing requires an editing-capable model.` };
  trace('council:delegate:finish', { agentId: agent.id, transport: agent.transport, ok: false, error: out.error });
  return out;
}

/** File tools scoped to a single worktree dir — given to a cloud model so it can write
 *  real files. Every path is resolved inside `root`; escapes are refused. */
function worktreeFileTools(root: string): { tools: ToolDef[]; call: (name: string, args: any) => Promise<string> } {
  const rootAbs = path.resolve(root);
  const safe = (p: string) => { const abs = path.resolve(rootAbs, p ?? '.'); if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new Error('path escapes the worktree'); return abs; };
  const tools: ToolDef[] = [
    { type: 'function', function: { name: 'write_file', description: 'Create or OVERWRITE a file with full content (parent dirs auto-created). Call once per file you author or change.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'repo-relative path' }, content: { type: 'string', description: 'the COMPLETE file contents' } }, required: ['path', 'content'] } } },
    { type: 'function', function: { name: 'read_file', description: 'Read a file (repo-relative).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
    { type: 'function', function: { name: 'list_dir', description: 'List a directory (repo-relative; "" or "." = repo root).', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: [] } } },
  ];
  const call = async (name: string, args: any): Promise<string> => {
    try {
      if (name === 'write_file') { const abs = safe(args?.path); fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, String(args?.content ?? '')); return `wrote ${args?.path} (${String(args?.content ?? '').length} bytes)`; }
      if (name === 'read_file') { return fs.readFileSync(safe(args?.path), 'utf8').slice(0, 20000); }
      if (name === 'list_dir') { const abs = safe(args?.path ?? '.'); return fs.readdirSync(abs, { withFileTypes: true }).map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).join('\n') || '(empty)'; }
      return `unknown tool: ${name}`;
    } catch (e: any) { return `error: ${String(e?.message ?? e)}`; }
  };
  return { tools, call };
}

async function runCloudEditingDelegate(agent: RosterAgent, prompt: string, wt: Worktree, cfg: TransportConfig): Promise<{ ok: boolean; output?: string; error?: string }> {
  const { tools, call } = worktreeFileTools(wt.dir);
  // reuse the caller's transport routing (same endpoint the panelists use) + add file tools
  const editTransport = makeTransport({ ...cfg, tools, callTool: call, toolCallCap: Math.max(cfg.toolCallCap ?? 12, 40), cwd: wt.dir });
  const sys = 'You are an autonomous coding agent in a real git worktree. You have file tools — write_file (create/OVERWRITE a complete file), read_file, list_dir. Implement the request by WRITING REAL, COMPLETE, RUNNABLE FILES via write_file (one call per file); inspect existing code with list_dir/read_file first. Do NOT paste code in chat — put it in files. Keep going until the task is fully implemented, then reply "DONE" with a one-paragraph summary of the files you wrote.';
  trace('council:delegate:start', { agentId: agent.id, transport: agent.transport, worktree: wt.dir, promptBytes: prompt.length, tooled: true });
  try {
    const out = await editTransport(agent, [{ role: 'system', content: sys }, { role: 'user', content: prompt }]);
    trace('council:delegate:finish', { agentId: agent.id, transport: agent.transport, ok: true, tooled: true, outputBytes: (out ?? '').length });
    return { ok: true, output: out };
  } catch (e: any) {
    const err = String(e?.message ?? e);
    trace('council:delegate:finish', { agentId: agent.id, transport: agent.transport, ok: false, tooled: true, error: err.slice(0, 300) });
    return { ok: false, error: err };
  }
}

/** Executor hooks for the execute phase: a lazily-created worktree run on `repo`. */
function makeExecutorHooks(repo: string, runId: string, abortSignal?: AbortSignal): ExecutorHooks {
  let wt: Worktree | null = null;
  let lastDiff = '';
  const started = Date.now();
  const cfg = transportConfig(repo, abortSignal);
  const ensureWorktree = async (): Promise<{ ok: boolean; wt?: Worktree; error?: string }> => {
    if (wt) return { ok: true, wt };
    const c = await createWorktree(repo, `council-${runId}`);
    if (!c.ok) return { ok: false, error: c.error };
    wt = c.wt;
    return { ok: true, wt };
  };
  const persist = (status: string, extra: Record<string, unknown> = {}) => {
    if (!wt) return;
    getDb().prepare(`
      INSERT INTO executor_runs(run_id, repo, mode, status, wt_dir, branch, plan_path, diff_path, diff_bytes, validation_ok, snapshot_id, started, updated, error)
      VALUES(@runId, @repo, 'council', @status, @wtDir, @branch, @planPath, @diffPath, @diffBytes, @validationOk, @snapshotId, @started, @updated, @error)
      ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, plan_path=COALESCE(excluded.plan_path, executor_runs.plan_path),
      diff_path=COALESCE(excluded.diff_path, executor_runs.diff_path), diff_bytes=excluded.diff_bytes,
      validation_ok=excluded.validation_ok, snapshot_id=COALESCE(excluded.snapshot_id, executor_runs.snapshot_id), updated=excluded.updated, error=excluded.error
    `).run({
      runId: `council-${runId}`,
      repo,
      status,
      wtDir: wt.dir,
      branch: wt.branch,
      planPath: extra.planPath ?? null,
      diffPath: extra.diffPath ?? null,
      diffBytes: lastDiff.length,
      validationOk: extra.validationOk ?? null,
      snapshotId: extra.snapshotId ?? null,
      started,
      updated: Date.now(),
      error: extra.error ?? null,
    });
  };
  // Hash the captured diff + re-read the written artifact to confirm the transfer
  // round-tripped (no truncation) before any verdict trusts it. Writes a .sha256
  // sidecar next to changes.diff.
  const sealArtifact = (diffPath: string, diff: string): { sha: string; bytes: number; roundTrip: boolean } => {
    const sha = createHash('sha256').update(diff, 'utf8').digest('hex');
    let roundTrip = false;
    try { roundTrip = createHash('sha256').update(fs.readFileSync(diffPath, 'utf8'), 'utf8').digest('hex') === sha; } catch { roundTrip = false; }
    try { fs.writeFileSync(`${diffPath}.sha256`, `sha256=${sha}\nbytes=${diff.length}\nroundTrip=${roundTrip}\n`); } catch { /* best-effort */ }
    return { sha, bytes: diff.length, roundTrip };
  };
  return {
    propose: async (plan, diff) => {
      if (!diff || !diff.trim()) return { ok: false, error: 'no diff to apply' };
      const c = await ensureWorktree();
      if (!c.ok || !c.wt) return { ok: false, error: c.error };
      const a = await applyDiffToWorktree(c.wt, diff);
      if (!a.ok) return { ok: false, error: a.error };
      lastDiff = await captureDiff(c.wt);
      const paths = writeArtifacts(c.wt, plan, lastDiff);
      const seal = sealArtifact(paths.diffPath, lastDiff);
      persist('proposed', paths);
      appendAudit('council:proposal', { runId, diffBytes: seal.bytes, diffSha: seal.sha, roundTrip: seal.roundTrip });
      if (!seal.roundTrip) return { ok: false, error: `diff failed integrity round-trip (sha ${seal.sha.slice(0, 12)}, ${seal.bytes} bytes) — refusing to trust a truncated transfer` };
      return { ok: true, diff: lastDiff };
    },
    delegate: async (agent, prompt) => {
      const c = await ensureWorktree();
      if (!c.ok || !c.wt) return { ok: false, error: c.error };
      const r = await runEditingDelegate(agent, prompt, c.wt, cfg);
      // Quarantine a provider error: a usage-limit/auth reply must NEVER pass as a build.
      if (looksLikeProviderError(r.output ?? '') || looksLikeProviderError(r.error ?? '')) {
        persist('delegate-failed', { error: 'provider error (usage limit / auth)' });
        appendAudit('council:delegateProviderError', { runId, agentId: agent.id });
        return { ok: false, error: `provider error from ${agent.displayName} (usage limit / auth) — not a build` };
      }
      if (!r.ok) {
        persist('delegate-failed', { error: r.error ?? 'delegate failed' });
        appendAudit('council:delegateFailed', { runId, agentId: agent.id, error: (r.error ?? '').slice(0, 300) });
        return { ok: false, error: r.error };
      }
      lastDiff = await captureDiff(c.wt);
      if (!lastDiff.trim()) {
        persist('no-changes', { error: 'delegate completed without modifying files' });
        appendAudit('council:delegateNoChanges', { runId, agentId: agent.id });
        return { ok: false, error: `${agent.displayName} completed without modifying files` };
      }
      const paths = writeArtifacts(c.wt, `${prompt}\n\n## Delegate output\n\n${r.output ?? ''}`, lastDiff);
      const seal = sealArtifact(paths.diffPath, lastDiff);
      persist('proposed', paths);
      appendAudit('council:delegate', { runId, agentId: agent.id, diffBytes: seal.bytes, diffSha: seal.sha, roundTrip: seal.roundTrip });
      if (!seal.roundTrip) return { ok: false, error: `delegate diff failed integrity round-trip (sha ${seal.sha.slice(0, 12)}, ${seal.bytes} bytes) — refusing to trust a truncated transfer` };
      return { ok: true, diff: lastDiff };
    },
    validate: async () => {
      if (!wt) return { ok: false, reason: 'no worktree' };
      const result = await validateWorktree(wt);
      persist(result.ok ? 'validated' : 'invalid', { validationOk: result.ok ? 1 : 0, error: result.ok ? null : `${result.reason ?? 'validation failed'}: ${(result.output ?? '').slice(0, 400)}` });
      return { ok: result.ok, reason: result.reason, output: result.output };
    },
    approve: async () => {
      if (!wt) return { ok: false, error: 'no worktree' };
      const snap = await createSnapshot(wt.repo, `fusion council pre-approve ${runId}`);
      const ap = await applyToLiveTree(wt, lastDiff);
      if (ap.ok) { appendAudit('council:approved', { runId, diffBytes: lastDiff.length, snapshotId: snap.id }); persist('approved', { snapshotId: snap.id, validationOk: 1 }); await removeWorktree(wt); }
      else persist('apply-failed', { snapshotId: snap.id, error: ap.error ?? 'apply failed' });
      return ap;
    },
  };
}

export function registerCouncilHandlers(getWindow: () => BrowserWindow | null) {
  // Boot reconciliation: any run still marked running/prologue/awaiting-answers belongs to
  // a PREVIOUS app process that is now dead (its CLI children were killed and its HTTP
  // requests abandoned when the app exited). Mark them interrupted so they aren't falsely
  // "running" and become re-runnable/resumable. No tokens are in use — nothing auto-resumes.
  try {
    const r = getDb().prepare("UPDATE council_runs SET status='interrupted', finished=COALESCE(finished, ?) WHERE status IN ('running','prologue','awaiting-answers')").run(Date.now());
    if (r.changes) { appendAudit('council:bootReconcile', { interrupted: r.changes }); trace('council:bootReconcile', { interrupted: r.changes }); }
  } catch { /* best-effort */ }

  // Buffer the event stream per run so a past session can be replayed in the theater.
  // Persisted to council_runs.events on terminal events; pruned to the last 10 per repo.
  const eventLog = new Map<string, CouncilEvent[]>();
  const persistEvents = (runId: string) => {
    const buf = eventLog.get(runId);
    if (!buf) return;
    try {
      const db = getDb();
      db.prepare('UPDATE council_runs SET events=? WHERE run_id=?').run(JSON.stringify(buf), runId);
      const row = db.prepare('SELECT repo FROM council_runs WHERE run_id=?').get(runId) as { repo: string | null } | undefined;
      if (row) db.prepare('UPDATE council_runs SET events=NULL WHERE events IS NOT NULL AND repo IS ? AND run_id NOT IN (SELECT run_id FROM council_runs WHERE repo IS ? ORDER BY started DESC LIMIT 10)').run(row.repo, row.repo);
    } catch { /* best-effort */ }
    eventLog.delete(runId);
  };
  const send = (runId: string, ev: CouncilEvent) => {
    try { getWindow()?.webContents.send('council:event', { runId, ...ev }); } catch { /* gone */ }
    let buf = eventLog.get(runId); if (!buf) { buf = []; eventLog.set(runId, buf); }
    if (buf.length < 5000) buf.push({ ...ev });
    if (ev.type === 'finished' || ev.type === 'error' || ev.type === 'loop:done') persistEvents(runId);
  };

  // ── live-bible coordination (FORGE) ──
  // A campaign's workers re-read the GDD at every rotation. If the user has the Bible
  // tab open and is editing, we "force-save then pull": before a worker reads the GDD
  // we ask the live editor to flush its in-progress buffer and wait for its ack (or a
  // short timeout) so the worker gets the freshest version. No live editor → read disk.
  const bibleActive = new Map<string, boolean>();          // runId → Bible tab mounted+editing
  const pendingFlush = new Map<string, () => void>();      // runId → resolver awaiting a flush ack
  const requestGddFlush = (runId: string): Promise<void> => new Promise((resolve) => {
    if (!bibleActive.get(runId)) { resolve(); return; }    // disk is current (editor autosaves + flushes on unmount)
    const fin = () => { pendingFlush.delete(runId); resolve(); };
    const timer = setTimeout(fin, 1500);
    pendingFlush.set(runId, () => { clearTimeout(timer); fin(); });
    send(runId, { type: 'gdd-flush' });                    // → the editor saves now, then calls campaignFlushAck
  });
  ipcMain.handle('council:campaignFlushAck', (_e, opts: { runId: string }) => { pendingFlush.get(opts.runId)?.(); return { ok: true }; });
  ipcMain.handle('council:campaignBibleActive', (_e, opts: { runId: string; active: boolean }) => {
    if (opts.active) bibleActive.set(opts.runId, true);
    else { bibleActive.delete(opts.runId); pendingFlush.get(opts.runId)?.(); }
    return { ok: true };
  });
  ipcMain.handle('council:campaignReadGdd', (_e, opts: { repo: string }) => {
    try { const content = fs.readFileSync(gddPath(opts.repo), 'utf8'); return { ok: true, content, stats: gdd.backlogStats(gdd.parseBacklog(content)) }; }
    catch { return { ok: false, content: '', stats: null }; }
  });
  ipcMain.handle('council:campaignWriteGdd', (_e, opts: { repo: string; content: string }) => {
    try { fs.mkdirSync(campaignDir(opts.repo), { recursive: true }); fs.writeFileSync(gddPath(opts.repo), opts.content ?? '', 'utf8'); return { ok: true, stats: gdd.backlogStats(gdd.parseBacklog(opts.content ?? '')) }; }
    catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
  });
  // Is this run a FORGE campaign? (drives the Bible tab in the theater.)
  ipcMain.handle('council:campaignInfo', (_e, opts: { runId: string }) => {
    const row = getDb().prepare('SELECT protocol, repo, status, result FROM council_runs WHERE run_id=?').get(opts.runId) as { protocol?: string; repo?: string; status?: string; result?: string } | undefined;
    if (!row) return { ok: false, isCampaign: false };
    const isCampaign = row.protocol === 'forge' || row.protocol === 'forge-design';
    let result: any = null; try { result = row.result ? JSON.parse(row.result) : null; } catch { /* none */ }
    return { ok: true, isCampaign, design: row.protocol === 'forge-design', repo: row.repo ?? null, status: row.status, result };
  });
  // Probe the roster's reachable models for asset capabilities (SVG / GDScript / chiptune / SFX),
  // store the results, and let the director route builds to capable agents. (Standalone parity:
  // CodeStuff/dependencies/capability-probe.)
  ipcMain.handle('council:probeCapabilities', async (_e, opts?: { caps?: string[] }) => {
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    const base = getSetting<string>('ollamaUrl', 'http://localhost:11434');
    const models = roster.filter((a) => ['ollama-cloud', 'ollama-local', 'openai-compat'].includes(a.transport) && a.model).map((a) => ({ id: a.id, model: a.model! }));
    if (!models.length) return { ok: false, error: 'no Ollama models in the roster to probe' };
    try {
      const probed = await probeCapabilities(models, { base, caps: opts?.caps });
      getDb().prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('agentCapabilities', JSON.stringify(probed));
      appendAudit('council:probeCapabilities', { models: models.length });
      return { ok: true, probed };
    } catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
  });

  // Shared launcher for a fresh start AND a resume (resumeFrom set). Persists a
  // checkpoint after every phase so an aborted/errored run can be continued.
  function launchCouncilRun(runId: string, opts: { repo?: string; protocol: Protocol; roster: RosterAgent[]; assignment: SessionAssignment; task: string; resumeFrom?: ResumeState; agentOptions?: Record<string, { temperature?: number; top_p?: number }>; agentPersonas?: Record<string, string>; forceBlind?: boolean; groundInRepo?: boolean }) {
    const db = getDb();
    const controller = new AbortController();
    const signal = { aborted: false, controller };
    signals.set(runId, signal);
    const execId = opts.resumeFrom ? `${runId}-r${Date.now().toString(36)}` : runId; // fresh worktree per resume attempt
    const executor = opts.repo ? makeExecutorHooks(opts.repo, execId, controller.signal) : undefined;
    const caps = methodCaps(opts.repo, runId, controller, false);   // Atlas query + file-read for the 'ingest' phase
    // §1 (opt-in): prepend an ingest phase so the panel is grounded in the real code.
    const protocol = opts.groundInRepo && !opts.protocol.phases.some((p) => p.kind === 'ingest')
      ? { ...opts.protocol, phases: [{ kind: 'ingest' as const, label: 'Ingest (repo grounding)' }, ...opts.protocol.phases] }
      : opts.protocol;
    const snaps: { phaseIndex: number; label: string; artifact: string }[] = []; // replay timeline

    void (async () => {
      // scoped read-only toolset (Atlas code-brain + Context7) for cloud panelists
      let toolset: ToolSet | undefined;
      try {
        if (getSetting('panelistTools', true)) {
          const servers = scopedReadOnlyServers(opts.repo);
          if (servers.length) { toolset = await buildToolSet(servers, controller.signal); if (toolset.tools.length) send(runId, { type: 'tools', content: toolset.tools.map((t) => t.function.name).join(', ') } as any); }
        }
      } catch { /* run without tools */ }
      const transport = makeTransport(transportConfig(opts.repo, controller.signal, opts.agentOptions, toolset, opts.agentPersonas));
      try {
        const res = await runProtocol(protocol, {
          roster: opts.roster, assignment: opts.assignment, task: opts.task, transport, executor, signal,
          resumeFrom: opts.resumeFrom, forceBlind: opts.forceBlind, atlasQuery: caps.atlasQuery, readFiles: caps.readFiles,
          emit: (ev) => send(runId, ev),
          onCheckpoint: (cp) => {
            try {
              snaps.push({ phaseIndex: cp.phaseIndex, label: protocol.phases[cp.phaseIndex - 1]?.label ?? `phase ${cp.phaseIndex}`, artifact: cp.artifact.slice(0, 20000) });
              db.prepare('UPDATE council_runs SET phase_index=?, artifact=?, transcript=?, verdicts=?, approved=?, snapshots=?, resumable=1 WHERE run_id=?')
                .run(cp.phaseIndex, cp.artifact, JSON.stringify(cp.transcript), JSON.stringify(cp.verdicts), cp.approved ? 1 : 0, JSON.stringify(snaps), runId);
            } catch { /* checkpoint is best-effort */ }
          },
        });
        const resumable = res.status === 'aborted' ? 1 : 0; // completed/bounced → not resumable
        db.prepare('UPDATE council_runs SET status=?, approved=?, finished=?, result=?, resumable=? WHERE run_id=?')
          .run(res.status, res.approved ? 1 : 0, Date.now(), JSON.stringify({ phasesRun: res.phasesRun, verdicts: res.verdicts, transcriptLen: res.transcript.length }), resumable, runId);
        appendAudit('council:finish', { runId, status: res.status, approved: res.approved });
        trace('council:finish', { runId, status: res.status, approved: res.approved, phasesRun: res.phasesRun });
        send(runId, { type: 'finished', status: res.status, ok: res.approved });
      } catch (err: any) {
        db.prepare('UPDATE council_runs SET status=?, finished=?, resumable=1 WHERE run_id=?').run('error', Date.now(), runId);
        trace('council:error', { runId, error: String(err?.message ?? err), stack: err?.stack });
        send(runId, { type: 'error', content: String(err?.message ?? err) });
      } finally {
        signals.delete(runId);
        toolset?.dispose();
      }
    })();
  }

  // Prologue: panel proposes clarifying questions, consolidates to ≤6, then the
  // run PAUSES (status awaiting-answers) until the user answers. Does NOT skip the
  // chosen protocol's round 1 — answers are injected and the full protocol runs.
  function startPrologue(runId: string, ctx: Omit<ProloguePending, 'questions'>) {
    const controller = new AbortController();
    const signal = { aborted: false, controller };
    signals.set(runId, signal);
    const transport = makeTransport(transportConfig(ctx.repo, controller.signal, ctx.agentOptions, undefined, ctx.agentPersonas));
    send(runId, { type: 'phase', phase: 'Prologue — clarifying questions', kind: 'prologue' });
    const askEmit = async (agent: RosterAgent, system: string, user: string): Promise<string | null> => {
      try {
        send(runId, { type: 'agent-start', phase: 'Prologue', agentId: agent.id });
        const out = await transport(agent, [{ role: 'system', content: system }, { role: 'user', content: user }], (d) => send(runId, { type: 'agent-delta', phase: 'Prologue', agentId: agent.id, content: d }));
        send(runId, { type: 'agent', phase: 'Prologue', agentId: agent.id, content: out });
        return out;
      } catch (e: any) { send(runId, { type: 'agent-error', phase: 'Prologue', agentId: agent.id, content: String(e?.message ?? e) }); return null; }
    };
    void (async () => {
      try {
        const panelists = resolveAgents(ctx.roster, ['@panelists'], ctx.assignment);
        const qsys = 'You are about to start work. Propose up to 6 SPECIFIC clarifying questions whose answers would most change how you approach this task — consider the environment facts already given. One question per line. Ask only what genuinely matters; do not pad.';
        const proposals = await Promise.allSettled(panelists.map((a) => askEmit(a, qsys, `Task:\n${ctx.task}`)));
        if (signal.aborted) { getDb().prepare('UPDATE council_runs SET status=?, finished=? WHERE run_id=?').run('aborted', Date.now(), runId); send(runId, { type: 'finished', status: 'aborted' }); return; }
        const pooled = proposals.filter((p) => p.status === 'fulfilled' && p.value).map((p: any) => p.value).join('\n');
        const consolidator = resolveAgents(ctx.roster, ['@scribe'], ctx.assignment)[0] ?? panelists[0];
        const csys = 'Consolidate the panel\'s proposed questions into the single most useful set of AT MOST 6 distinct questions to ask the user before starting. Output ONLY the questions, one per line, numbered 1-6. No preamble.';
        const consolidated = consolidator ? await askEmit(consolidator, csys, `Proposed questions:\n${pooled}`) : pooled;
        const questions = parseQuestions(consolidated ?? pooled);
        if (!questions.length) { // nothing to ask → just run
          launchCouncilRun(runId, { ...ctx });
          return;
        }
        pendingPrologue.set(runId, { ...ctx, questions });
        getDb().prepare('UPDATE council_runs SET status=?, result=? WHERE run_id=?').run('awaiting-answers', JSON.stringify({ questions }), runId);
        appendAudit('council:prologue', { runId, questionCount: questions.length });
        send(runId, { type: 'questions', questions });
      } catch (err: any) {
        getDb().prepare('UPDATE council_runs SET status=?, finished=? WHERE run_id=?').run('error', Date.now(), runId);
        send(runId, { type: 'error', content: String(err?.message ?? err) });
      } finally { signals.delete(runId); }
    })();
  }

  ipcMain.handle('council:answerQuestions', (_e, opts: { runId: string; answers: string[] }) => {
    const p = pendingPrologue.get(opts.runId);
    if (!p) return { ok: false, error: 'no pending prologue for this run' };
    const qa = p.questions.map((q, i) => `Q${i + 1}: ${q}\nA${i + 1}: ${(opts.answers?.[i] ?? '').trim() || '(no answer given)'}`).join('\n\n');
    const task = `${p.task}\n\n[CLARIFYING ANSWERS FROM THE USER — authoritative]\n${qa}`;
    pendingPrologue.delete(opts.runId);
    getDb().prepare('UPDATE council_runs SET status=?, task=? WHERE run_id=?').run('running', task, opts.runId);
    appendAudit('council:answers', { runId: opts.runId, answered: (opts.answers ?? []).filter(Boolean).length });
    trace('council:answers', { runId: opts.runId, questions: p.questions.length });
    launchCouncilRun(opts.runId, { repo: p.repo, protocol: p.protocol, roster: p.roster, assignment: p.assignment, task, agentOptions: p.agentOptions, agentPersonas: p.agentPersonas, forceBlind: p.forceBlind, groundInRepo: p.groundInRepo });
    return { ok: true, runId: opts.runId };
  });

  ipcMain.handle('council:detectEnv', (_e, opts: { repo: string }) => {
    if (!opts?.repo) return { ok: false, facts: '' };
    try { return { ok: true, facts: detectEnv(opts.repo) }; } catch (e: any) { return { ok: false, facts: '', error: e?.message }; }
  });

  ipcMain.handle('council:start', (_e, opts: { repo?: string; protocolId: string; assignment: SessionAssignment; task: string; context?: string; hot?: { agents?: string[]; temperature?: number; top_p?: number }; prologue?: boolean; personas?: Record<string, string>; forceBlind?: boolean; groundInRepo?: boolean }) => {
    const protocol = PROTOCOLS[opts.protocolId];
    if (!protocol) return { ok: false, error: `unknown protocol: ${opts.protocolId}` };
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    const va = validateAssignment(roster, opts.assignment);
    if (!va.ok) return { ok: false, error: `invalid assignment${va.missing.length ? ` (unknown ids: ${va.missing.join(', ')})` : ' (need ≥1 panelist + judge + qa-gate)'}` };

    const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const task = withContext(opts.task, opts.context);
    const agentOptions = buildAgentOptions(opts.hot, roster);
    const agentPersonas = buildAgentPersonas(opts.personas);
    getDb().prepare('INSERT INTO council_runs(run_id, repo, protocol, task, assignment, status, started) VALUES(?,?,?,?,?,?,?)')
      .run(runId, opts.repo ?? null, protocol.id, task, JSON.stringify(opts.assignment), opts.prologue ? 'prologue' : 'running', Date.now());
    appendAudit('council:start', { runId, protocol: protocol.id, repo: opts.repo ?? null, prologue: !!opts.prologue });
    trace('council:start', { runId, protocol: protocol.id, repo: opts.repo ?? null, assignment: opts.assignment, taskBytes: task.length, hot: opts.hot?.agents, prologue: !!opts.prologue });

    if (opts.prologue) {
      startPrologue(runId, { repo: opts.repo, protocol, roster, assignment: opts.assignment, task, agentOptions, agentPersonas, forceBlind: opts.forceBlind, groundInRepo: opts.groundInRepo });
      return { ok: true, runId, awaiting: true };
    }
    launchCouncilRun(runId, { repo: opts.repo, protocol, roster, assignment: opts.assignment, task, agentOptions, agentPersonas, forceBlind: opts.forceBlind, groundInRepo: opts.groundInRepo });
    return { ok: true, runId };
  });

  // Autonomous goal loop (Phase 5): branch → run protocol → checkpoint → goal-check → repeat.
  ipcMain.handle('council:startLoop', (_e, opts: { repo: string; protocolId: string; assignment: SessionAssignment; goal: string; maxIterations?: number; costCeiling?: number; context?: string; hot?: { agents?: string[]; temperature?: number; top_p?: number }; personas?: Record<string, string>; forceBlind?: boolean; methodId?: string; groundInRepo?: boolean }) => {
    if (!opts?.repo) return { ok: false, error: 'autonomous loop needs a workspace (for checkpoints)' };
    const protocol = PROTOCOLS[opts.protocolId];
    if (!protocol) return { ok: false, error: `unknown protocol: ${opts.protocolId}` };
    const method = opts.methodId ? METHODS[opts.methodId] : undefined;   // loop a fusion method instead of the protocol
    if (opts.methodId && !method) return { ok: false, error: `unknown method: ${opts.methodId}` };
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    const va = validateAssignment(roster, opts.assignment);
    if (!va.ok) return { ok: false, error: `invalid assignment${va.missing.length ? ` (unknown ids: ${va.missing.join(', ')})` : ''}` };

    const runId = `loop-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const goal = withContext(opts.goal, opts.context);
    const controller = new AbortController();
    const signal = { aborted: false, controller };
    signals.set(runId, signal);
    const checker = resolveAgents(roster, ['@judge'], opts.assignment)[0];
    const db = getDb();
    db.prepare('INSERT INTO council_runs(run_id, repo, protocol, task, assignment, status, started) VALUES(?,?,?,?,?,?,?)')
      .run(runId, opts.repo, protocol.id, goal, JSON.stringify(opts.assignment), 'running', Date.now());
    appendAudit('council:loopStart', { runId, protocol: protocol.id, repo: opts.repo, maxIterations: opts.maxIterations ?? 5 });

    const CHECKER_SYS = 'You verify whether a coding goal is satisfied. Reply MET only with concrete evidence; otherwise reply NOT MET and the single most useful next step. Default to NOT MET when uncertain.';
    const loopCaps = methodCaps(opts.repo, runId, controller, false);   // Atlas/file-read for protocol-loop ingest
    const loopProtocol = opts.groundInRepo && !protocol.phases.some((p) => p.kind === 'ingest')
      ? { ...protocol, phases: [{ kind: 'ingest' as const, label: 'Ingest (repo grounding)' }, ...protocol.phases] }
      : protocol;

    void (async () => {
      let toolset: ToolSet | undefined;
      try {
        if (getSetting('panelistTools', true)) { const servers = scopedReadOnlyServers(opts.repo); if (servers.length) { toolset = await buildToolSet(servers, controller.signal); if (toolset.tools.length) send(runId, { type: 'tools', content: toolset.tools.map((t) => t.function.name).join(', ') } as any); } }
      } catch { /* run without tools */ }
      const transport = makeTransport(transportConfig(opts.repo, controller.signal, buildAgentOptions(opts.hot, roster), toolset, buildAgentPersonas(opts.personas)));
      try {
        const protectedPaths = new Set(await dirtyPaths(opts.repo));
        if (protectedPaths.size) send(runId, { type: 'warn', phase: 'Pre-flight', content: `⚠ ${protectedPaths.size} pre-existing uncommitted file(s) will be left alone — the loop commits only what it writes (no more blanket git add -A).`, ok: true });
        const res = await runAutoloop({
          goal,
          maxIterations: opts.maxIterations ?? 5,
          costCeiling: opts.costCeiling,
          signal,
          emit: (ev) => send(runId, { ...ev, type: `loop:${ev.type}` } as any),
          runIteration: method
            // Method-driven loop: run the fusion method each iteration; its build step auto-applies
            // to the live tree so iterations accumulate. Adapt MethodResult → RunResult for the loop.
            ? async (task, iter) => {
                const c = methodCaps(opts.repo, `${runId}-i${iter}`, controller, true);
                const m = await runMethod(method, { task, roster, transport, signal, emit: (ev) => send(runId, ev), ...c, groundInRepo: opts.groundInRepo });
                return { status: 'completed', phasesRun: [method.name], transcript: [], artifact: m.artifact, verdicts: [], approved: !!m.diff } as RunResult;
              }
            : (task, iter) => runProtocol(loopProtocol, { roster, assignment: opts.assignment, task, transport, executor: makeExecutorHooks(opts.repo, `${runId}-i${iter}`, controller.signal), signal, forceBlind: opts.forceBlind, atlasQuery: loopCaps.atlasQuery, readFiles: loopCaps.readFiles, emit: (ev) => send(runId, ev) }),
          checkpoint: async (iter) => {
            const c = await forgeCommit(opts.repo, `fusion autoloop ${runId} iter ${iter}`, protectedPaths);
            send(runId, { type: 'agent', phase: `iter ${iter}`, kind: 'files', content: c.committed ? `committed ${c.files.length} file(s) → ${c.sha.slice(0, 8)}: ${c.files.slice(0, 12).join(', ')}${c.files.length > 12 ? ` +${c.files.length - 12} more` : ''}` : 'no new files this iteration' });
            let t = ''; try { t = (await git(opts.repo, ['rev-parse', 'HEAD^{tree}'])).stdout.trim(); } catch { /* none */ }
            return { signature: t || `iter-${iter}` };
          },
          checkGoal: async (g, _iter, last) => {
            if (!checker) return { met: false, reason: 'no checker agent' };
            // Read the files this iteration actually produced (committed at HEAD) so the checker
            // verifies real output, not just the proposal text.
            const produced = await changedFilesDigest(opts.repo).catch(() => '');
            const body = `Goal:\n${g}\n\nLatest proposal (approved=${last.approved}):\n${last.artifact.slice(0, 2000)}${produced ? `\n\nFiles produced/changed this iteration — INSPECT THESE to verify the goal is actually met:\n${produced}` : ''}`;
            const reply = await transport(checker, [{ role: 'system', content: CHECKER_SYS }, { role: 'user', content: body }]).catch(() => 'NOT MET');
            const met = /\bmet\b/i.test(reply) && !/not\s*met/i.test(reply);
            return { met, reason: reply.slice(0, 300), nextSubtask: met ? undefined : reply.slice(0, 600) };
          },
        });
        db.prepare('UPDATE council_runs SET status=?, approved=?, finished=?, result=? WHERE run_id=?')
          .run(res.status, res.status === 'met' ? 1 : 0, Date.now(), JSON.stringify({ iterations: res.iterations, signatures: res.signatures }), runId);
        appendAudit('council:loopFinish', { runId, status: res.status, iterations: res.iterations });
        send(runId, { type: 'loop:done', status: res.status, ok: res.status === 'met' });
      } catch (err: any) {
        db.prepare('UPDATE council_runs SET status=?, finished=? WHERE run_id=?').run('error', Date.now(), runId);
        send(runId, { type: 'error', content: String(err?.message ?? err) });
      } finally { signals.delete(runId); toolset?.dispose(); }
    })();

    return { ok: true, runId };
  });

  // A bounced final is not a dead end: send it back to the group (re-debate) or
  // the QA/judge (re-evaluate), optionally with an open-ended user clarification.
  ipcMain.handle('council:continueBounced', (_e, opts: { runId: string; target: 'group' | 'qa'; note?: string }) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM council_runs WHERE run_id=?').get(opts.runId) as any;
    if (!row) return { ok: false, error: 'unknown run' };
    if (row.status === 'running') return { ok: false, error: 'session is already running' };
    const protocol = PROTOCOLS[row.protocol];
    if (!protocol) return { ok: false, error: `unknown protocol: ${row.protocol}` };
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    let assignment: SessionAssignment;
    try { assignment = JSON.parse(row.assignment); } catch { return { ok: false, error: 'corrupt assignment' }; }
    const gateIndex = Math.min(row.phase_index ?? protocol.phases.length, protocol.phases.length);
    let resumeIndex = gateIndex; // 'qa' → re-run the gate that bounced
    if (opts.target === 'group') {
      const divergent = new Set(['independent', 'debate', 'gauntlet', 'steelman']);
      for (let i = gateIndex - 1; i >= 0; i--) if (divergent.has(protocol.phases[i].kind)) { resumeIndex = i; break; }
    }
    const note = opts.note?.trim();
    const task = note ? `${row.task}\n\n[USER FOLLOW-UP after the previous bounce — address this directly]:\n${note}` : row.task;
    const resumeFrom: ResumeState = {
      phaseIndex: resumeIndex,
      artifact: row.artifact ?? '',
      transcript: row.transcript ? JSON.parse(row.transcript) : [],
      verdicts: [],        // fresh evaluation
      approved: false,
    };
    db.prepare('UPDATE council_runs SET status=?, task=?, finished=NULL WHERE run_id=?').run('running', task, opts.runId);
    appendAudit('council:continueBounced', { runId: opts.runId, target: opts.target, fromPhase: resumeIndex, hasNote: !!note });
    trace('council:continueBounced', { runId: opts.runId, target: opts.target, fromPhase: resumeIndex });
    launchCouncilRun(opts.runId, { repo: row.repo ?? undefined, protocol, roster, assignment, task, resumeFrom });
    return { ok: true, runId: opts.runId, fromPhase: resumeIndex };
  });

  ipcMain.handle('council:cancel', (_e, opts: { runId: string }) => {
    const s = signals.get(opts.runId);
    if (s) {
      s.aborted = true;
      try { s.controller.abort(); } catch { /* already aborted */ }     // aborts in-flight HTTP + kills CLI children
      appendAudit('council:cancel', { runId: opts.runId });
      trace('council:cancel', { runId: opts.runId });
    }
    return { ok: !!s };
  });

  // Continue an aborted/errored session from its last checkpointed phase (reuses
  // the same runId so it stays one session). Mid-protocol resume — not re-run.
  ipcMain.handle('council:resume', (_e, opts: { runId: string }) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM council_runs WHERE run_id=?').get(opts.runId) as any;
    if (!row) return { ok: false, error: 'unknown run' };
    if (!row.resumable || row.phase_index == null) return { ok: false, error: 'this session has no resume checkpoint' };
    if (row.status === 'running') return { ok: false, error: 'session is already running' };
    const protocol = PROTOCOLS[row.protocol];
    if (!protocol) return { ok: false, error: `unknown protocol: ${row.protocol}` };
    if (row.phase_index >= protocol.phases.length) return { ok: false, error: 'session already finished every phase' };
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    let assignment: SessionAssignment;
    try { assignment = JSON.parse(row.assignment); } catch { return { ok: false, error: 'corrupt assignment' }; }
    const va = validateAssignment(roster, assignment);
    if (!va.ok) return { ok: false, error: `invalid assignment${va.missing.length ? ` (unknown ids: ${va.missing.join(', ')})` : ''}` };

    const resumeFrom: ResumeState = {
      phaseIndex: row.phase_index,
      artifact: row.artifact ?? '',
      transcript: row.transcript ? JSON.parse(row.transcript) : [],
      verdicts: row.verdicts ? JSON.parse(row.verdicts) : [],
      approved: !!row.approved,
    };
    db.prepare('UPDATE council_runs SET status=?, finished=NULL WHERE run_id=?').run('running', opts.runId);
    appendAudit('council:resume', { runId: opts.runId, fromPhase: row.phase_index });
    trace('council:resume', { runId: opts.runId, fromPhase: row.phase_index, protocol: protocol.id });
    launchCouncilRun(opts.runId, { repo: row.repo ?? undefined, protocol, roster, assignment, task: row.task, resumeFrom });
    return { ok: true, runId: opts.runId, fromPhase: row.phase_index };
  });

  ipcMain.handle('council:list', () => {
    const rows = getDb().prepare('SELECT run_id AS runId, repo, protocol, task, assignment, status, approved, phase_index AS phaseIndex, resumable, (events IS NOT NULL) AS hasEvents, started, finished FROM council_runs ORDER BY started DESC LIMIT 50').all();
    return { ok: true, runs: rows };
  });

  // Ask a specific agent a follow-up question about the session it took part in.
  ipcMain.handle('council:ask', async (_e, opts: { runId: string; agentId: string; question: string }) => {
    const row = getDb().prepare('SELECT * FROM council_runs WHERE run_id=?').get(opts.runId) as any;
    if (!row) return { ok: false, error: 'unknown run' };
    const agent = getSetting<RosterAgent[]>('fusionRoster', []).find((a) => a.id === opts.agentId);
    if (!agent) return { ok: false, error: 'agent not in roster' };
    let transcript: { agentId?: string; content: string }[] = [];
    try { transcript = row.transcript ? JSON.parse(row.transcript) : []; } catch { /* none */ }
    const mine = transcript.filter((t) => t.agentId === opts.agentId).map((t) => t.content).join('\n\n---\n\n').slice(0, 7000);
    const others = transcript.map((t) => `${t.agentId}: ${String(t.content).slice(0, 600)}`).join('\n').slice(0, 6000);
    const transport = makeTransport(transportConfig(row.repo ?? undefined));
    const sys = `You are ${agent.displayName}, a member of a code-review council. The user is asking a follow-up question about the session you took part in. Answer directly and specifically, grounded in what was actually discussed.`;
    const user = `Council discussion (abridged):\n${others}\n\nYour own statements in that session:\n${mine || '(you did not speak)'}\n\nFinal proposal:\n${(row.artifact ?? '').slice(0, 4000)}\n\nThe user's question for you:\n${opts.question}`;
    try { const answer = await transport(agent, [{ role: 'system', content: sys }, { role: 'user', content: user }]); appendAudit('council:ask', { runId: opts.runId, agentId: opts.agentId }); return { ok: true, answer }; }
    catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
  });

  // PR-mode: generate a PR title/body/test-evidence/risk/checklist from the run + executor ledger.
  ipcMain.handle('council:prDescription', async (_e, opts: { runId: string }) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM council_runs WHERE run_id=?').get(opts.runId) as any;
    if (!row) return { ok: false, error: 'unknown run' };
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    let assignment: SessionAssignment; try { assignment = JSON.parse(row.assignment); } catch { return { ok: false, error: 'corrupt assignment' }; }
    const author = resolveAgents(roster, ['@judge'], assignment)[0] ?? roster[0];
    if (!author) return { ok: false, error: 'no agent available to author the PR' };
    const ex = db.prepare('SELECT * FROM executor_runs WHERE run_id=? ORDER BY updated DESC LIMIT 1').get(`council-${opts.runId}`) as any;
    let diff = '';
    try { if (ex?.diff_path && fs.existsSync(ex.diff_path)) diff = fs.readFileSync(ex.diff_path, 'utf8').slice(0, 12000); } catch { /* no diff */ }
    const transport = makeTransport(transportConfig(row.repo ?? undefined));
    const sys = 'You write excellent pull-request descriptions. Output GitHub-flavored markdown with EXACTLY these sections: a first line "# <title>", then ## Summary, ## Changes, ## Test evidence, ## Risk, ## Reviewer checklist (a markdown "- [ ]" task list). Be concrete and grounded ONLY in what is provided; do not invent.';
    const user = `Task:\n${row.task}\n\nOutcome / final proposal:\n${(row.artifact ?? '').slice(0, 8000)}\n\nValidation: ${ex ? (ex.validation_ok == null ? 'not validated' : ex.validation_ok ? 'tests passed' : 'tests FAILED') : 'not run'}\n\nDiff:\n${diff || '(no diff captured)'}`;
    try { const markdown = await transport(author, [{ role: 'system', content: sys }, { role: 'user', content: user }]); appendAudit('council:prDescription', { runId: opts.runId }); return { ok: true, markdown }; }
    catch (e: any) { return { ok: false, error: String(e?.message ?? e) }; }
  });

  // §3/§4 — list the registered fusion methods + their printed cards (for the launcher).
  ipcMain.handle('council:methods', () => ({
    ok: true,
    methods: Object.values(METHODS).map((m) => ({ id: m.id, name: m.name, use: m.use, endPrompt: m.endPrompt, budget: m.budget, card: printMethodCard(m) })),
  }));

  // The stored result of a finished method run (report / scores / seed / end-prompt) + whether
  // it was a method (for the chaining panel). Returns isMethod=false for plain council runs.
  ipcMain.handle('council:methodResult', (_e, opts: { runId: string }) => {
    const row = getDb().prepare('SELECT protocol, status, result FROM council_runs WHERE run_id=?').get(opts.runId) as { protocol?: string; status?: string; result?: string } | undefined;
    if (!row) return { ok: false, isMethod: false };
    const isMethod = !!row.protocol && row.protocol in METHODS;
    let result: any = null;
    try { result = row.result ? JSON.parse(row.result) : null; } catch { /* none */ }
    return { ok: true, isMethod, methodId: row.protocol, status: row.status, result };
  });

  // §1.1 — read-only view of the role-eligibility table for the CURRENT roster (the GUI).
  ipcMain.handle('council:roleEligibility', () => {
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    return {
      ok: true,
      rows: roster.map((a) => { const e = ADVISOR_ELIGIBILITY[advisorKey(a)]; return { id: a.id, displayName: a.displayName, key: advisorKey(a), eligible: e.eligible, notEligible: e.notEligible, context: e.context, maxCalls: e.maxCalls, optional: !!e.optional }; }),
    };
  });

  // §3 — run a fusion method (foundry / foundry-design / assay / prospect / relay / scatter).
  ipcMain.handle('council:runMethod', (_e, opts: { repo?: string; methodId: string; task: string; focus?: string; context?: string; seed?: { contract?: string; artifacts?: string[]; focus?: string }; groundInRepo?: boolean }) => {
    const method = METHODS[opts.methodId];
    if (!method) return { ok: false, error: `unknown method: ${opts.methodId}` };
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    const runId = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const task = withContext(opts.task, opts.context);
    const db = getDb();
    db.prepare('INSERT INTO council_runs(run_id, repo, protocol, task, assignment, status, started) VALUES(?,?,?,?,?,?,?)')
      .run(runId, opts.repo ?? null, method.id, task, '{}', 'running', Date.now());
    appendAudit('council:runMethod', { runId, method: method.id, repo: opts.repo ?? null, seeded: !!opts.seed });
    trace('council:runMethod', { runId, method: method.id, repo: opts.repo ?? null, focus: opts.focus, seeded: !!opts.seed });

    const controller = new AbortController();
    const signal = { aborted: false, controller };
    signals.set(runId, signal);

    void (async () => {
      send(runId, { type: 'phase', phase: method.name, kind: 'method' });
      send(runId, { type: 'agent', phase: method.name, content: printMethodCard(method) });
      // scoped read-only toolset (Atlas code-brain + Context7) so method agents can navigate
      // the real code on demand — same surface the council panelists get.
      let toolset: ToolSet | undefined;
      try {
        if (getSetting('panelistTools', true)) {
          const servers = scopedReadOnlyServers(opts.repo);
          if (servers.length) { toolset = await buildToolSet(servers, controller.signal); if (toolset.tools.length) send(runId, { type: 'tools', content: toolset.tools.map((t) => t.function.name).join(', ') } as any); }
        }
      } catch { /* run without tools */ }
      const transport = makeTransport(transportConfig(opts.repo, controller.signal, buildAgentOptions(undefined, roster), toolset));
      // Atlas-first ingest + file-read grounding + build (one-shot: build is NOT auto-applied;
      // it lands in a worktree the user can review/apply from the Run ledger).
      const { atlasQuery, readFiles, build, runDir } = methodCaps(opts.repo, `method-${runId}`, controller, false);
      try {
        const res = await runMethod(method, { task, focus: opts.focus ?? opts.seed?.focus, roster, transport, signal, emit: (ev) => send(runId, ev), build, atlasQuery, readFiles, runDir, seed: opts.seed, groundInRepo: opts.groundInRepo });
        const status = res.degraded ? 'completed-degraded' : 'completed';
        db.prepare('UPDATE council_runs SET status=?, finished=?, artifact=?, result=? WHERE run_id=?')
          .run(status, Date.now(), res.artifact, JSON.stringify({ report: res.report, scores: res.scores, warnings: res.warnings, findings: res.findings, seed: res.seed, endPrompt: method.endPrompt, confidence: res.confidence, humanDecision: res.humanDecision }), runId);
        appendAudit('council:methodFinish', { runId, method: method.id, degraded: res.degraded });
        send(runId, { type: 'finished', status, ok: !res.degraded });
      } catch (err: any) {
        db.prepare('UPDATE council_runs SET status=?, finished=? WHERE run_id=?').run('error', Date.now(), runId);
        send(runId, { type: 'error', content: String(err?.message ?? err) });
      } finally { signals.delete(runId); toolset?.dispose(); }
    })();
    return { ok: true, runId };
  });

  // FORGE campaign (loop-only): author a Game Design Document (the "bible") ONCE, then
  // loop — select the next dependency-ready batch from the backlog → run the inner crucible
  // cycle (forge-cycle) → build & validate → flip backlog status deterministically → commit →
  // repeat until no actionable items remain. Brownfield: an existing GDD.md is loaded &
  // continued (free resume). design=true writes only the GDD (resolves [?] questions, no code).
  ipcMain.handle('council:startCampaign', (_e, opts: {
    repo: string; concept: string; design?: boolean; maxIterations?: number; batchSize?: number;
    consolidatorId?: string; builderId?: string; lean?: boolean; cycles?: number; context?: string;
    disableProviders?: string[]; retryLimit?: number;
  }) => {
    if (!opts?.repo) return { ok: false, error: 'FORGE needs a workspace (for the GDD + git checkpoints)' };
    if (!opts?.concept?.trim()) return { ok: false, error: 'describe the game concept first' };
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    if (!roster.length) return { ok: false, error: 'no agents configured in the roster' };
    const design = !!opts.design;
    // Capability-aware default builder: pick the strongest edit-capable asset/code emitter
    // (refined by any probe results) so a build job is never defaulted to a weak/incapable agent.
    const probedCaps = getSetting<ProbedCaps | undefined>('agentCapabilities', undefined);
    const builder = opts.builderId ? roster.find((a) => a.id === opts.builderId) : rankEditors(roster, probedCaps)[0];
    if (!design && !builder) return { ok: false, error: 'FORGE build needs an edit-capable agent (Claude/Codex/OpenClaw, or a cloud model with "edits" on) — none in the roster' };

    const runId = `forge-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const concept = withContext(opts.concept, opts.context);
    const controller = new AbortController();
    const signal = { aborted: false, controller };
    signals.set(runId, signal);
    const db = getDb();
    const protocolId = design ? 'forge-design' : 'forge';
    db.prepare('INSERT INTO council_runs(run_id, repo, protocol, task, assignment, status, started) VALUES(?,?,?,?,?,?,?)')
      .run(runId, opts.repo, protocolId, concept, '{}', 'running', Date.now());
    appendAudit('council:forgeStart', { runId, design, repo: opts.repo, maxIterations: opts.maxIterations ?? 12 });
    trace('council:forgeStart', { runId, design, repo: opts.repo });

    const batchSize = Math.max(1, Math.min(5, opts.batchSize ?? (design ? 3 : 2)));
    const maxIterations = Math.max(1, Math.min(50, opts.maxIterations ?? 12));
    const preferAgents: Partial<Record<FusionRole, string>> = {};
    if (opts.consolidatorId) preferAgents.consolidator = opts.consolidatorId;
    if (builder) preferAgents.builder = builder.id;
    const disableProviders = opts.disableProviders ?? [];   // e.g. ['claude'] when Claude is out of tokens
    const retryLimit = Math.max(0, Math.min(5, opts.retryLimit ?? 2));
    const retry = new Map<string, number>();                // per-item retry counter (slice/root recovery)

    const ensureDir = () => { try { fs.mkdirSync(campaignDir(opts.repo), { recursive: true }); } catch { /* best-effort */ } };
    const readGdd = () => { try { return fs.readFileSync(gddPath(opts.repo), 'utf8'); } catch { return ''; } };
    const writeGdd = (md: string) => { ensureDir(); try { fs.writeFileSync(gddPath(opts.repo), md, 'utf8'); } catch { /* best-effort */ } };
    const appendFile = (name: string, text: string) => { ensureDir(); try { fs.appendFileSync(path.join(campaignDir(opts.repo), name), `${text}\n`, 'utf8'); } catch { /* best-effort */ } };
    // force-save-then-pull: flush any live in-editor edits before a worker reads the bible.
    const pullGdd = async () => { await requestGddFlush(runId); return readGdd(); };

    void (async () => {
      let toolset: ToolSet | undefined;
      try { if (getSetting('panelistTools', true)) { const servers = scopedReadOnlyServers(opts.repo); if (servers.length) { toolset = await buildToolSet(servers, controller.signal); if (toolset.tools.length) send(runId, { type: 'tools', content: toolset.tools.map((t) => t.function.name).join(', ') } as any); } } } catch { /* run without tools */ }
      const transport = makeTransport(transportConfig(opts.repo, controller.signal, buildAgentOptions(undefined, roster), toolset));
      const caps = methodCaps(opts.repo, `forge-${runId}`, controller, true);  // atlas + file-read grounding

      try {
        send(runId, { type: 'phase', phase: design ? 'FORGE-DESIGN — campaign' : 'FORGE — campaign', kind: 'method' });

        // Pre-flight: snapshot the user's existing uncommitted work so the loop NEVER stages or
        // commits it. Each iteration commits only the files IT produced (no more `git add -A`).
        const protectedPaths = new Set(await dirtyPaths(opts.repo));
        if (protectedPaths.size) send(runId, { type: 'warn', phase: 'Pre-flight', content: `⚠ ${protectedPaths.size} pre-existing uncommitted file(s) detected — they will be LEFT ALONE (the loop commits only what it writes): ${[...protectedPaths].slice(0, 8).join(', ')}${protectedPaths.size > 8 ? '…' : ''}`, ok: true });

        // ── Charter (once): load an existing bible, else author one ──
        let gddMd = readGdd();
        if (gdd.hasBacklog(gddMd)) {
          send(runId, { type: 'agent', phase: 'Charter', kind: 'seed', content: `Loaded existing bible (${gdd.parseBacklog(gddMd).length} backlog items) — continuing from where it left off.` });
        } else {
          send(runId, { type: 'phase', phase: 'Charter — author the bible', kind: 'frame' });
          const m = await runMethod(buildCharter(), { task: charterTask(concept, design, gddMd, readRepoMarkdown(opts.repo)), roster, transport, signal, emit: (ev) => send(runId, ev), atlasQuery: caps.atlasQuery, readFiles: caps.readFiles, runDir: caps.runDir, groundInRepo: true, preferAgents, disableProviders });
          gddMd = m.artifact || '';
          if (!gdd.hasBacklog(gddMd)) { gddMd += '\n\n## Backlog\n- [ ] [S-001] Implement the core playable loop | rigor: full | slice | accept: the game runs and is playable\n'; send(runId, { type: 'warn', phase: 'Charter', content: 'charter produced no parseable backlog — seeded a single core-loop item; edit .fusion/campaign/GDD.md to refine.', ok: true }); }
          writeGdd(gddMd);
          send(runId, { type: 'agent', phase: 'Charter ✓', kind: 'frame', content: `Wrote the bible → ${path.relative(opts.repo, gddPath(opts.repo))} (${gdd.parseBacklog(gddMd).length} items).` });
        }

        // Index the (possibly brownfield) repo so iteration 1's design phases ground in real code.
        { const ix = indexRepo(opts.repo); if (ix.ok) send(runId, { type: 'agent', phase: 'Index', kind: 'ingest', content: `Atlas indexed${ix.symbols != null ? ` (${ix.symbols} symbols)` : ''} — design phases ground in the code.` }); }

        // ── Loop ──
        const res = await runAutoloop({
          goal: concept, maxIterations, signal,
          emit: (ev) => send(runId, { ...ev, type: `loop:${ev.type}` } as any),
          runIteration: async (_task, iter) => {
            const md = await pullGdd();
            let items = gdd.parseBacklog(md);
            let batch = gdd.selectBatch(items, { maxSize: batchSize, mode: design ? 'design' : 'build' });
            // Stall recovery: nothing ready but a blocked item's deps are all done → it failed on
            // its own (e.g. a blocked vertical slice stranding the backlog). Retry it up to retryLimit
            // before giving up, so one bad build doesn't kill the whole campaign.
            if (!batch.length && !design) {
              const recoverable = gdd.blockedWithSatisfiedDeps(items).filter((i) => (retry.get(i.id) ?? 0) < retryLimit);
              if (recoverable.length) {
                let md2 = await pullGdd();
                for (const it of recoverable) { md2 = gdd.setStatus(md2, it.id, 'todo', `retry ${(retry.get(it.id) ?? 0) + 1}/${retryLimit}`); retry.set(it.id, (retry.get(it.id) ?? 0) + 1); }
                writeGdd(md2);
                send(runId, { type: 'agent', phase: `Iteration ${iter}`, kind: 'retry', content: `stalled — retrying ${recoverable.length} blocked item(s): ${recoverable.map((i) => `${i.id} (try ${retry.get(i.id)})`).join(', ')}` });
                items = gdd.parseBacklog(md2);
                batch = gdd.selectBatch(items, { maxSize: batchSize, mode: 'build' });
              }
            }
            const stats = gdd.backlogStats(items);
            send(runId, { type: 'agent', phase: `Iteration ${iter}`, kind: 'scope', content: `backlog ${stats.done}/${stats.total} done · ${stats.blocked} blocked · this batch: [${batch.map((b) => b.id).join(', ') || '—'}]` });
            if (!batch.length) return { status: 'completed', phasesRun: ['(idle)'], transcript: [], artifact: '', verdicts: [], approved: true } as RunResult;

            const rigor = batch.some((b) => b.rigor === 'full') ? 'full' : 'light';
            const cycle = buildForgeCycle({ rigor, lean: !!opts.lean, cycles: opts.cycles, design });
            const task = design ? designIterationTask(batch, md) : buildIterationTask(batch, md, gdd.acceptanceOfDone(items));

            // per-iteration build capture (build mode): delegate → validate → apply, recording outcome
            const outcome = { ok: false, validated: false, applied: false, error: '' };
            const build = design ? undefined : async (artifact: string, b: RosterAgent) => {
              if (!b.capabilities?.canEdit) { outcome.error = `${b.displayName} cannot edit files`; return { ok: false, error: outcome.error }; }
              const ex = makeExecutorHooks(opts.repo, `forge-${runId}-i${iter}`, controller.signal);
              if (!ex.delegate) { outcome.error = 'no delegate capability'; return { ok: false, error: outcome.error }; }
              const r = await ex.delegate(b, `Implement the following into the working tree directly. FIRST write/append a CHANGE_PLAN.md mapping what you change and why, THEN make focused changes. When done, summarize what changed.\n\n${artifact}`);
              outcome.ok = r.ok; if (!r.ok) { outcome.error = r.error ?? 'delegate failed'; return r; }
              // Golden regression gate: validate runs the per-stack compile/test over the
              // ACCUMULATED worktree (prior batches + this one) — a failing suite blocks the apply.
              const v = await ex.validate(); outcome.validated = v.ok;
              send(runId, { type: 'validate', phase: `Iteration ${iter} · gate`, ok: v.ok, content: v.ok ? '' : `${v.reason ?? 'stack gate'}: ${(v.output ?? '').replace(/\s+/g, ' ').slice(0, 300)}` });
              if (v.ok) { const ap = await ex.approve(); outcome.applied = ap.ok; if (!ap.ok) outcome.error = ap.error ?? 'apply failed'; }
              else outcome.error = `regression gate failed (${v.reason ?? 'stack gate'}): ${(v.output ?? '').replace(/\s+/g, ' ').slice(0, 160)}`;
              return { ok: r.ok, diff: r.diff, error: r.error };
            };

            const m = await runMethod(cycle, { task, roster, transport, signal, emit: (ev) => send(runId, ev), atlasQuery: caps.atlasQuery, readFiles: caps.readFiles, runDir: caps.runDir, groundInRepo: true, build, preferAgents, disableProviders });

            // ── deterministic bookkeeping (status flips by code, never by an agent) ──
            let nextMd = await pullGdd();   // pull again so edits made during the build aren't clobbered
            const amendments = gdd.parseAmendments(m.artifact, gdd.parseBacklog(nextMd));
            if (amendments.length) { nextMd = gdd.appendItems(nextMd, amendments); send(runId, { type: 'agent', phase: `Iteration ${iter}`, kind: 'amend', content: `+${amendments.length} backlog item(s) proposed by the panel` }); }

            const gated = m.humanDecision.length > 0;
            let approved = false;
            if (design) {
              appendFile('decisions.md', `\n<!-- iteration ${iter} -->\n${m.artifact}`);
              for (const q of batch) nextMd = gdd.setStatus(nextMd, q.id, 'done', 'resolved');
              approved = true;
            } else if (gated) {   // autonomous: log TODO(gate), block the item, keep going
              const note = `GATE: ${m.humanDecision.join(' / ').replace(/\s+/g, ' ').slice(0, 200)}`;
              for (const it of batch) nextMd = gdd.setStatus(nextMd, it.id, 'blocked', note);
              appendFile('gates.md', `## Iteration ${iter} — ${batch.map((b) => b.id).join(', ')}\nTODO(gate): an invariant blocker survived auto-repair; resolve before shipping.\n${m.humanDecision.join('\n')}\n`);
              send(runId, { type: 'warn', phase: `Iteration ${iter}`, content: `[GATE] survived → logged TODO(gate), blocked ${batch.map((b) => b.id).join(', ')}, continuing (autonomous).`, ok: true });
            } else if (outcome.applied) {
              for (const it of batch) nextMd = gdd.setStatus(nextMd, it.id, 'done');
              approved = true;
            } else {
              for (const it of batch) nextMd = gdd.setStatus(nextMd, it.id, 'blocked', (outcome.error || 'build did not apply').slice(0, 200));
              send(runId, { type: 'warn', phase: `Iteration ${iter}`, content: `build not applied (${outcome.error || 'unknown'}) → blocked ${batch.map((b) => b.id).join(', ')}, continuing.`, ok: true });
            }
            writeGdd(nextMd);
            // re-index after applied code changes so the NEXT iteration's design phases see them.
            if (!design && outcome.applied) { const ix = indexRepo(opts.repo); if (ix.ok) send(runId, { type: 'agent', phase: `Iteration ${iter}`, kind: 'ingest', content: 're-indexed (Atlas) for the next iteration' }); }
            appendFile('log.md', `## Iteration ${iter}\nbatch: ${batch.map((b) => b.id).join(', ')}\noutcome: ${design ? 'design' : gated ? 'gated' : outcome.applied ? 'applied' : 'blocked'}${outcome.error ? ` (${outcome.error})` : ''}\nscores: ${m.scores.map((s) => s.verdict).join(', ') || '—'}`);
            return { status: 'completed', phasesRun: [cycle.name], transcript: [], artifact: m.artifact, verdicts: [], approved } as RunResult;
          },
          checkpoint: async (iter) => {
            const c = await forgeCommit(opts.repo, `forge ${runId} iter ${iter}`, protectedPaths);
            if (c.committed) {
              send(runId, { type: 'agent', phase: `Iteration ${iter}`, kind: 'files', content: `committed ${c.files.length} file(s) → ${c.sha.slice(0, 8)}: ${c.files.slice(0, 12).join(', ')}${c.files.length > 12 ? ` +${c.files.length - 12} more` : ''}` });
              try { fs.mkdirSync(path.join(campaignDir(opts.repo), 'iterations'), { recursive: true }); fs.writeFileSync(path.join(campaignDir(opts.repo), 'iterations', `iter-${iter}.diff`), c.diff.slice(0, 800000), 'utf8'); } catch { /* best-effort */ }
              appendFile('log.md', `  files: ${c.files.join(', ')}\n  commit: ${c.sha.slice(0, 8)}`);
            } else {
              send(runId, { type: 'agent', phase: `Iteration ${iter}`, kind: 'files', content: 'no new files this iteration' });
            }
            let tree = ''; try { tree = (await git(opts.repo, ['rev-parse', 'HEAD^{tree}'])).stdout.trim(); } catch { /* none */ }
            return { signature: tree || `iter-${iter}` };
          },
          checkGoal: async () => {
            const items = gdd.parseBacklog(await pullGdd());
            const s = gdd.backlogStats(items);
            // not done while a blocked item can still be retried (else the loop would quit on a
            // transient build failure of the slice and report a false completion).
            const recoverable = design ? 0 : gdd.blockedWithSatisfiedDeps(items).filter((i) => (retry.get(i.id) ?? 0) < retryLimit).length;
            const met = gdd.isComplete(items, design ? 'design' : 'build') && recoverable === 0;
            return { met, reason: `${s.done}/${s.total} done · ${s.blocked} blocked · ${s.ready} ready${recoverable ? ` · ${recoverable} retryable` : ''}${met ? ' — backlog complete' : ''}` };
          },
        });

        // Honest final status: a backlog that ends with 0 done but blocked items is STALLED,
        // not "completed"; any remaining work is PARTIAL. Never report a do-nothing run as success.
        const finalStats = gdd.backlogStats(gdd.parseBacklog(readGdd()));
        const finalStatus = res.status === 'met'
          ? (finalStats.done === 0 ? 'stalled' : (finalStats.todo + finalStats.blocked > 0 ? 'partial' : 'completed'))
          : res.status;   // cap / oscillation / cost / aborted
        const ok = finalStatus === 'completed';
        db.prepare('UPDATE council_runs SET status=?, approved=?, finished=?, result=? WHERE run_id=?')
          .run(finalStatus, ok ? 1 : 0, Date.now(), JSON.stringify({ loop: res.status, status: finalStatus, iterations: res.iterations, stats: finalStats, gdd: path.relative(opts.repo, gddPath(opts.repo)) }), runId);
        appendAudit('council:forgeFinish', { runId, status: finalStatus, loop: res.status, iterations: res.iterations, stats: finalStats });
        trace('council:forgeFinish', { runId, status: finalStatus, iterations: res.iterations });
        send(runId, { type: 'loop:done', status: finalStatus, ok });
      } catch (err: any) {
        db.prepare('UPDATE council_runs SET status=?, finished=? WHERE run_id=?').run('error', Date.now(), runId);
        send(runId, { type: 'error', content: String(err?.message ?? err) });
      } finally { signals.delete(runId); toolset?.dispose(); }
    })();

    return { ok: true, runId };
  });

  // Full event stream of a past run → replay it in the debate theater.
  ipcMain.handle('council:events', (_e, opts: { runId: string }) => {
    const row = getDb().prepare('SELECT events FROM council_runs WHERE run_id=?').get(opts.runId) as { events?: string } | undefined;
    let events: CouncilEvent[] = [];
    try { events = row?.events ? JSON.parse(row.events) : []; } catch { /* none */ }
    return { ok: true, events };
  });

  // Per-phase artifact snapshots for the replay timeline.
  ipcMain.handle('council:snapshots', (_e, opts: { runId: string }) => {
    const row = getDb().prepare('SELECT snapshots FROM council_runs WHERE run_id=?').get(opts.runId) as { snapshots?: string } | undefined;
    if (!row) return { ok: false, snapshots: [] };
    try { return { ok: true, snapshots: row.snapshots ? JSON.parse(row.snapshots) : [] }; } catch { return { ok: true, snapshots: [] }; }
  });

  // Ask the whole room a follow-up — every agent that spoke answers in parallel.
  ipcMain.handle('council:askRoom', async (_e, opts: { runId: string; question: string }) => {
    const row = getDb().prepare('SELECT * FROM council_runs WHERE run_id=?').get(opts.runId) as any;
    if (!row) return { ok: false, error: 'unknown run', answers: [] };
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    let transcript: { agentId?: string; content: string }[] = [];
    try { transcript = row.transcript ? JSON.parse(row.transcript) : []; } catch { /* none */ }
    const spoke = [...new Set(transcript.map((t) => t.agentId).filter(Boolean) as string[])];
    let agents = spoke.map((id) => roster.find((a) => a.id === id)).filter(Boolean) as RosterAgent[];
    if (!agents.length) { try { agents = resolveAgents(roster, ['@panelists'], JSON.parse(row.assignment)); } catch { /* none */ } }
    if (!agents.length) return { ok: false, error: 'no participants to ask', answers: [] };
    const others = transcript.map((t) => `${t.agentId}: ${String(t.content).slice(0, 500)}`).join('\n').slice(0, 6000);
    const transport = makeTransport(transportConfig(row.repo ?? undefined));
    const answers = await Promise.all(agents.map(async (agent) => {
      const mine = transcript.filter((t) => t.agentId === agent.id).map((t) => t.content).join('\n\n').slice(0, 5000);
      const sys = `You are ${agent.displayName}, a member of a code-review council answering a follow-up question about the session you took part in. Be concise and specific.`;
      const user = `Council discussion (abridged):\n${others}\n\nYour own statements:\n${mine || '(you did not speak directly)'}\n\nThe user's question for the room:\n${opts.question}`;
      try { const answer = await transport(agent, [{ role: 'system', content: sys }, { role: 'user', content: user }]); return { agentId: agent.id, answer }; }
      catch (e: any) { return { agentId: agent.id, answer: `error: ${String(e?.message ?? e)}` }; }
    }));
    appendAudit('council:askRoom', { runId: opts.runId, participants: answers.length });
    return { ok: true, answers };
  });

  // Salvage a bounced proposal: accept it as-is, write an extensively-commented doc
  // on what's good/bad and the full why, code up the good parts, and leave the bad
  // parts as labeled TODOs. Runs the editing actor in a worktree, then auto-applies
  // if the build stays green (else leaves the diff for manual review).
  ipcMain.handle('council:salvageBounced', (_e, opts: { runId: string; note?: string }) => {
    const db = getDb();
    const row = db.prepare('SELECT * FROM council_runs WHERE run_id=?').get(opts.runId) as any;
    if (!row) return { ok: false, error: 'unknown run' };
    if (!row.repo) return { ok: false, error: 'salvage needs a repo (this was a dry run)' };
    const roster = getSetting<RosterAgent[]>('fusionRoster', []);
    let assignment: SessionAssignment; try { assignment = JSON.parse(row.assignment); } catch { return { ok: false, error: 'corrupt assignment' }; }
    const actor = resolveAgents(roster, ['@judge'], assignment)[0];
    if (!actor) return { ok: false, error: 'no actor to salvage' };
    if (!actor.capabilities?.canEdit) return { ok: false, error: `${actor.displayName} cannot edit files — assign an editing actor (claude/codex) as the judge` };

    const runId = opts.runId;
    const controller = new AbortController();
    const signal = { aborted: false, controller };
    signals.set(runId, signal);
    const executor = makeExecutorHooks(row.repo, `salvage-${runId}-${Date.now().toString(36)}`, controller.signal);
    db.prepare('UPDATE council_runs SET status=?, resumable=0, finished=NULL WHERE run_id=?').run('running', runId);

    void (async () => {
      send(runId, { type: 'phase', phase: 'Salvage — accept & document', kind: 'execute' });
      const prompt = `A council proposal was BOUNCED by the judge, but the user has chosen to ACCEPT IT AS-IS and salvage the work.\n\nOriginal task:\n${row.task}\n\nThe bounced proposal:\n${(row.artifact ?? '').slice(0, 12000)}\n${opts.note ? `\nUser's note:\n${opts.note}\n` : ''}\nDo ALL of the following by editing the working tree directly:\n1. Write thorough documentation (a new markdown doc under docs/, plus inline comments at the relevant code) that comments EXTENSIVELY and elaborately on exactly what is GOOD and what is BAD about this proposal, and the ENTIRE reasoning WHY for each — be concrete and specific, not vague.\n2. Implement the GOOD, sound portions as real working code.\n3. For the BAD or unsafe portions, do NOT implement them blindly — leave clearly-labeled \`TODO(salvage):\` comments at the exact spots, each explaining what is wrong and what must be fixed before it is safe.\nKeep the build green. When done, summarize what you implemented vs. what you left as TODOs.`;
      try {
        const p = await executor.delegate!(actor, prompt);
        send(runId, { type: 'propose', phase: 'Salvage', ok: p.ok, agentId: actor.id });
        let approved = false;
        if (p.ok) {
          const v = await executor.validate();
          send(runId, { type: 'validate', phase: 'Salvage', ok: v.ok });
          if (v.ok) { const ap = await executor.approve(); approved = ap.ok; send(runId, { type: 'execute', phase: 'Salvage', ok: ap.ok }); }
        }
        const status = !p.ok ? 'error' : approved ? 'completed' : 'salvaged';
        db.prepare('UPDATE council_runs SET status=?, approved=?, finished=? WHERE run_id=?').run(status, approved ? 1 : 0, Date.now(), runId);
        appendAudit('council:salvage', { runId, ok: p.ok, approved });
        send(runId, { type: 'finished', status, ok: approved });
      } catch (err: any) {
        db.prepare('UPDATE council_runs SET status=?, finished=? WHERE run_id=?').run('error', Date.now(), runId);
        send(runId, { type: 'error', content: String(err?.message ?? err) });
      } finally { signals.delete(runId); }
    })();
    return { ok: true, runId };
  });

  ipcMain.handle('council:probeAgent', async (_e, opts: { agent: RosterAgent; repo?: string }) => {
    if (!opts?.agent) return { ok: false, detail: 'missing agent' };
    return probeAgent(opts.agent, opts.repo);
  });
}
