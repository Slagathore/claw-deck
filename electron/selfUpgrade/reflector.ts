import * as path from 'path';
import * as fsp from 'fs/promises';
import { PatchSet, extractPatchSetFromText } from './patcher';

const TEXT_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.json', '.md']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-electron', 'dist-installer', 'dist-installer2', 'dist-installer3', 'dist-installer4', 'dist-installer5', 'dist-installer6', 'dist-installer7', 'dist-installer8', '.cache', 'public']);

export interface FileFact {
  path: string;
  loc: number;
  bytes: number;
  imports: string[];
  exports: string[];
  complexityHints: number;
}

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, abs, out);
    else if (e.isFile() && TEXT_EXTS.has(path.extname(e.name).toLowerCase())) out.push(abs);
    if (out.length > 2000) return;
  }
}

export async function buildFacts(root: string): Promise<FileFact[]> {
  const files: string[] = [];
  await walk(root, root, files);
  const facts: FileFact[] = [];
  for (const f of files) {
    try {
      const buf = await fsp.readFile(f);
      if (buf.length > 256 * 1024) continue;
      const text = buf.toString('utf8');
      const loc = text.split(/\r?\n/).length;
      const importMatches = [...text.matchAll(/(?:^|\n)\s*import\s+[^'"]*['"]([^'"]+)['"]/g)].map(m => m[1]);
      const exportMatches = [...text.matchAll(/(?:^|\n)\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+([A-Za-z0-9_]+)/g)].map(m => m[1]);
      // Cheap cyclomatic-ish hint: count branchy keywords.
      const complexity = (text.match(/\b(if|else|for|while|switch|case|catch|\?\s*[^.])\b/g) || []).length;
      facts.push({
        path: path.relative(root, f).replace(/\\/g, '/'),
        loc,
        bytes: buf.length,
        imports: importMatches.slice(0, 30),
        exports: exportMatches.slice(0, 30),
        complexityHints: complexity
      });
    } catch { /* ignore */ }
  }
  facts.sort((a, b) => b.complexityHints - a.complexityHints);
  return facts;
}

export function buildPrompt(facts: FileFact[], goal: string): { system: string; user: string } {
  const top = facts.slice(0, 40);
  const inventory = top.map(f =>
    `- ${f.path}  (loc=${f.loc}, complexity=${f.complexityHints}, exports=[${f.exports.slice(0, 8).join(',')}])`
  ).join('\n');

  const system = `You are a senior TypeScript engineer auditing a small Electron + React desktop app called Claw Deck.
Your job: propose ONE small, safe, valuable improvement to the codebase.
You MUST respond with a single JSON object inside a \`\`\`json fence, conforming to:
{
  "id": "short-slug",
  "rationale": "1-3 sentences explaining the change and why it's safe",
  "files": [
    { "path": "relative/posix/path.ts", "mode": "create"|"replace"|"delete", "contents": "FULL FILE CONTENTS" }
  ]
}
Rules:
- Replace whole files; do not emit diff hunks.
- Touch at most 3 files. Prefer additive changes (new utilities, new tests).
- Do NOT modify electron/main.ts, electron/preload.ts, electron/selfUpgrade/*, electron/ipc/security.ts, electron/lib/scanner.ts, package.json, or package-lock.json.
- Do NOT introduce eval, new Function, child_process, shell:true, network calls to non-localhost, base64-then-eval, or fs deletion.
- Output ONLY the JSON fence. No prose before or after.`;

  const user = `Goal: ${goal}

Inventory (top complexity-ranked files):
${inventory}

Propose one improvement.`;

  return { system, user };
}

export interface ReflectBackend {
  name: string;
  generate(system: string, user: string): Promise<string>;
}

export function localOllamaBackend(opts: { baseUrl: string; model: string }): ReflectBackend {
  return {
    name: `ollama:${opts.model}`,
    async generate(system, user) {
      const r = await fetch(`${opts.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          stream: false,
          options: { temperature: 0.2 }
        })
      });
      if (!r.ok) throw new Error(`ollama HTTP ${r.status}`);
      const j: any = await r.json();
      return j.message?.content ?? '';
    }
  };
}

export function openaiCompatBackend(opts: { url: string; apiKey?: string; model: string }): ReflectBackend {
  return {
    name: `openai:${opts.model}`,
    async generate(system, user) {
      const r = await fetch(`${opts.url.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {})
        },
        body: JSON.stringify({
          model: opts.model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user }
          ],
          temperature: 0.2
        })
      });
      if (!r.ok) throw new Error(`openai-compat HTTP ${r.status}`);
      const j: any = await r.json();
      return j.choices?.[0]?.message?.content ?? '';
    }
  };
}

export async function generateProposal(backend: ReflectBackend, root: string, goal: string): Promise<PatchSet | null> {
  const facts = await buildFacts(root);
  const { system, user } = buildPrompt(facts, goal);
  const text = await backend.generate(system, user);
  return extractPatchSetFromText(text);
}
