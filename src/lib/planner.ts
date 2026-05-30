/**
 * Pure helpers for the Plan-and-Execute Assistant tab.
 *
 * The model is prompted to emit a JSON plan inside a fenced code block:
 *
 *   ```json
 *   {
 *     "summary": "Install qwen2.5-coder and add it as the code model.",
 *     "steps": [
 *       { "type": "pullModel", "model": "qwen2.5-coder:7b" },
 *       { "type": "setSetting", "key": "chatModel", "value": "qwen2.5-coder:7b" }
 *     ]
 *   }
 *   ```
 *
 * This module parses that, validates it, and provides the step-type registry.
 * Actual execution lives in AssistantTab so it can use the React + IPC layer.
 */

export type StepStatus = 'pending' | 'running' | 'ok' | 'error' | 'skipped';

export type PlanStep =
  | { type: 'pullModel'; model: string }
  | { type: 'setSetting'; key: string; value: any }
  | { type: 'addMcpServer'; name: string; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'shell'; command: string; args?: string[]; cwd?: string; description?: string }
  | { type: 'openTab'; tab: string }
  | { type: 'webFetch'; url: string; description?: string }
  | { type: 'note'; text: string };

export interface Plan {
  summary: string;
  steps: PlanStep[];
}

export interface ParsedPlan {
  ok: boolean;
  plan?: Plan;
  error?: string;
  raw?: string;     // the chunk we extracted (or full text)
}

const STEP_TYPES = new Set([
  'pullModel', 'setSetting', 'addMcpServer', 'shell', 'openTab', 'webFetch', 'note'
]);

/**
 * Extract the first JSON object that looks like a plan from arbitrary LLM
 * output. Tries (in order):
 *   1. A fenced ```json``` block
 *   2. A fenced ``` block whose content parses as JSON
 *   3. The first balanced { ... } substring that parses
 */
export function extractPlanJson(text: string): { json: string | null; raw: string } {
  if (!text) return { json: null, raw: '' };
  // 1. fenced json
  const jsonFence = /```json\s*([\s\S]*?)```/i.exec(text);
  if (jsonFence) return { json: jsonFence[1].trim(), raw: jsonFence[0] };
  // 2. any fenced block
  const anyFence = /```\s*([\s\S]*?)```/i.exec(text);
  if (anyFence) {
    const candidate = anyFence[1].trim();
    try { JSON.parse(candidate); return { json: candidate, raw: anyFence[0] }; } catch { /* fall through */ }
  }
  // 3. first balanced { ... }
  const start = text.indexOf('{');
  if (start < 0) return { json: null, raw: text };
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        try { JSON.parse(candidate); return { json: candidate, raw: candidate }; }
        catch { return { json: null, raw: text }; }
      }
    }
  }
  return { json: null, raw: text };
}

export function parsePlan(text: string): ParsedPlan {
  const { json, raw } = extractPlanJson(text);
  if (!json) return { ok: false, error: 'No JSON plan found in model output.', raw };
  let obj: any;
  try { obj = JSON.parse(json); }
  catch (e: any) { return { ok: false, error: `Invalid JSON: ${e.message}`, raw: json }; }
  if (typeof obj !== 'object' || obj === null) return { ok: false, error: 'Plan must be an object.', raw: json };
  if (typeof obj.summary !== 'string') return { ok: false, error: 'Plan.summary must be a string.', raw: json };
  if (!Array.isArray(obj.steps)) return { ok: false, error: 'Plan.steps must be an array.', raw: json };
  const steps: PlanStep[] = [];
  for (let i = 0; i < obj.steps.length; i++) {
    const s = obj.steps[i];
    if (typeof s !== 'object' || s === null) return { ok: false, error: `Step ${i} is not an object.`, raw: json };
    if (!STEP_TYPES.has(s.type)) return { ok: false, error: `Step ${i} has unknown type "${s.type}".`, raw: json };
    // Per-type field checks (minimal — we don't want to over-reject)
    switch (s.type) {
      case 'pullModel':    if (typeof s.model !== 'string' || !s.model) return { ok: false, error: `Step ${i} pullModel.model missing`, raw: json }; break;
      case 'setSetting':   if (typeof s.key !== 'string' || !s.key) return { ok: false, error: `Step ${i} setSetting.key missing`, raw: json }; break;
      case 'addMcpServer': if (typeof s.name !== 'string' || !s.name || typeof s.command !== 'string') return { ok: false, error: `Step ${i} addMcpServer missing name/command`, raw: json }; break;
      case 'shell':        if (typeof s.command !== 'string' || !s.command) return { ok: false, error: `Step ${i} shell.command missing`, raw: json }; break;
      case 'openTab':      if (typeof s.tab !== 'string' || !s.tab) return { ok: false, error: `Step ${i} openTab.tab missing`, raw: json }; break;
      case 'webFetch':     if (typeof s.url !== 'string' || !s.url) return { ok: false, error: `Step ${i} webFetch.url missing`, raw: json }; break;
      case 'note':         if (typeof s.text !== 'string') return { ok: false, error: `Step ${i} note.text missing`, raw: json }; break;
    }
    steps.push(s as PlanStep);
  }
  return { ok: true, plan: { summary: obj.summary, steps }, raw: json };
}

/**
 * One-line human label for a step, used in the plan preview UI.
 */
export function describeStep(s: PlanStep): string {
  switch (s.type) {
    case 'pullModel':    return `Pull Ollama model: ${s.model}`;
    case 'setSetting':   return `Set setting "${s.key}" → ${JSON.stringify(s.value)}`;
    case 'addMcpServer': return `Add MCP server "${s.name}" (${s.command} ${(s.args ?? []).join(' ')})`;
    case 'shell':        return `Run shell: ${s.command}${s.args && s.args.length ? ' ' + s.args.join(' ') : ''}${s.cwd ? ` (cwd: ${s.cwd})` : ''}`;
    case 'openTab':      return `Open tab: ${s.tab}`;
    case 'webFetch':     return `Fetch URL: ${s.url}`;
    case 'note':         return `Note: ${s.text}`;
  }
}

/**
 * Steps that change system state need explicit user approval before running.
 * Returning `false` means a step is informational / read-only.
 */
export function isDestructive(s: PlanStep): boolean {
  return s.type === 'shell' || s.type === 'pullModel' || s.type === 'setSetting' || s.type === 'addMcpServer';
}

/**
 * System prompt used to drive the planner. Kept here so tests can snapshot it.
 */
export const PLANNER_SYSTEM_PROMPT = `You are Claw, an assistant embedded in the Claw Deck desktop app.
The user will ask you to do something or to explain how to do something.

When the user asks you to DO something, respond with a brief plain-language
explanation followed by a single fenced \`\`\`json block containing a plan:

\`\`\`json
{
  "summary": "<one sentence>",
  "steps": [
    { "type": "<step-type>", ... }
  ]
}
\`\`\`

Allowed step types (use only these):

- { "type": "pullModel",    "model": "<ollama-tag>" }
- { "type": "setSetting",   "key": "<settings-key>", "value": <any-json> }
- { "type": "addMcpServer", "name": "<id>", "command": "<bin>", "args": ["..."], "env": {...} }
- { "type": "shell",        "command": "<bin>", "args": ["..."], "cwd": "<path?>", "description": "<why>" }
- { "type": "openTab",      "tab": "chat|cli|terminal|history|prompts|settings|upgrades|self|security|library|assistant" }
- { "type": "webFetch",     "url": "<https-url>", "description": "<why>" }
- { "type": "note",         "text": "<info for the user>" }

Rules:
- Prefer the smallest set of steps that accomplishes the request.
- Use pullModel/setSetting/addMcpServer instead of raw shell when the action maps to one.
- Never run \`rm\`, \`del\`, \`Remove-Item -Recurse\`, \`format\`, or anything destructive without an obvious justification in description.
- When you only need to explain something, omit the JSON block entirely.
- Common settings keys: ollamaUrl, chatModel, reasoningModel, visionModel, openclawPath, claudeCodePath.
- Tab names (use exactly these): chat, cli, terminal, history, prompts, settings, upgrades, self, security, library, assistant.`;
