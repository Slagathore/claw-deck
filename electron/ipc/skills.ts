import { ipcMain, shell } from 'electron';
import { spawn } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { auditDirectory } from '../lib/scanner';

/** Run a CLI capturing combined output; shell-resolves bare names on Windows. */
function runCli(bin: string, args: string[], timeoutMs: number): Promise<{ ok: boolean; out: string }> {
  return new Promise(resolve => {
    const useShell = process.platform === 'win32' && !/[\\/]/.test(bin);
    let child;
    try { child = spawn(bin, args, { shell: useShell, windowsHide: true }); }
    catch (e: any) { resolve({ ok: false, out: e.message }); return; }
    let out = '';
    const onData = (d: Buffer) => { out += d.toString(); };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const t = setTimeout(() => { try { child!.kill('SIGKILL'); } catch { /* ignore */ } }, timeoutMs);
    child.on('error', e => { clearTimeout(t); resolve({ ok: false, out: out + String(e) }); });
    child.on('close', code => { clearTimeout(t); resolve({ ok: code === 0, out }); });
  });
}

/**
 * Local OpenClaw skill management. Skills live at `<workspace>/skills/<slug>/`,
 * each a `SKILL.md` (YAML frontmatter `name`/`description` + body) plus any
 * supporting files. This is the same on-disk layout the `clawhub` CLI installs
 * into, so locally-authored skills and registry-installed skills sit together.
 */

interface SkillRow {
  slug: string;
  name: string;
  description: string;
  dir: string;
  skillMd: string;
  hasScripts: boolean;
}

function skillsRoot(workspace: string): string {
  return path.join(workspace, 'skills');
}

// Minimal SKILL.md frontmatter reader (name + description).
function parseFrontmatter(md: string): { name?: string; description?: string } {
  const m = /^﻿?---\s*\r?\n([\s\S]*?)\r?\n---/.exec(md);
  if (!m) return {};
  const block = m[1];
  const get = (k: string): string | undefined => {
    const r = new RegExp(`^\\s*${k}\\s*:\\s*(.*)$`, 'm').exec(block);
    if (!r) return undefined;
    let v = r[1].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1).replace(/\\"/g, '"');
    }
    return v;
  };
  return { name: get('name'), description: get('description') };
}

export function registerSkillHandlers() {
  ipcMain.handle('skills:list', async (_e, opts: { workspace: string }): Promise<{ ok: boolean; skills?: SkillRow[]; reason?: string }> => {
    const root = skillsRoot(opts.workspace || '');
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      const rows: SkillRow[] = [];
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const dir = path.join(root, ent.name);
        const skillMd = path.join(dir, 'SKILL.md');
        let md = '';
        try { md = await fs.readFile(skillMd, 'utf8'); } catch { continue; } // skip folders without SKILL.md
        const fm = parseFrontmatter(md);
        let hasScripts = false;
        try { hasScripts = (await fs.readdir(dir)).some(f => f !== 'SKILL.md'); } catch { /* ignore */ }
        rows.push({
          slug: ent.name,
          name: fm.name || ent.name,
          description: fm.description || '',
          dir, skillMd, hasScripts
        });
      }
      rows.sort((a, b) => a.slug.localeCompare(b.slug));
      return { ok: true, skills: rows };
    } catch (e: any) {
      if (e?.code === 'ENOENT') return { ok: true, skills: [] }; // no skills dir yet
      return { ok: false, reason: e.message };
    }
  });

  ipcMain.handle('skills:read', async (_e, opts: { skillMd: string }) => {
    try { return { ok: true, content: await fs.readFile(opts.skillMd, 'utf8') }; }
    catch (e: any) { return { ok: false, reason: e.message }; }
  });

  ipcMain.handle('skills:write', async (_e, opts: { skillMd: string; content: string }) => {
    try {
      await fs.mkdir(path.dirname(opts.skillMd), { recursive: true });
      await fs.writeFile(opts.skillMd, opts.content, 'utf8');
      return { ok: true };
    } catch (e: any) { return { ok: false, reason: e.message }; }
  });

  ipcMain.handle('skills:create', async (_e, opts: { workspace: string; slug: string; content: string }) => {
    if (!opts.workspace) return { ok: false, reason: 'no workspace set' };
    const dir = path.join(skillsRoot(opts.workspace), opts.slug);
    const skillMd = path.join(dir, 'SKILL.md');
    try {
      try { await fs.access(skillMd); return { ok: false, reason: `skill "${opts.slug}" already exists` }; } catch { /* good, doesn't exist */ }
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(skillMd, opts.content, 'utf8');
      return { ok: true, dir, skillMd };
    } catch (e: any) { return { ok: false, reason: e.message }; }
  });

  ipcMain.handle('skills:delete', async (_e, opts: { dir: string }) => {
    try { await fs.rm(opts.dir, { recursive: true, force: true }); return { ok: true }; }
    catch (e: any) { return { ok: false, reason: e.message }; }
  });

  ipcMain.handle('skills:open', async (_e, opts: { target: string }) => {
    await shell.openPath(opts.target);
    return { ok: true };
  });

  // Vet a registry skill BEFORE installing it for real: install it into a
  // throwaway quarantine dir (download only — nothing runs), scan the files with
  // the same static security engine used by the upgrade gate, then delete the
  // quarantine. Returns the AuditReport.
  ipcMain.handle('skills:scanRegistry', async (_e, opts: { slug: string; clawhubPath?: string }) => {
    const slug = (opts?.slug || '').trim();
    if (!slug) return { ok: false, reason: 'no slug' };
    const bin = opts.clawhubPath || 'clawhub';
    const tmp = path.join(os.tmpdir(), `clawdeck-skillscan-${Date.now().toString(36)}`);
    try {
      await fs.mkdir(tmp, { recursive: true });
      const inst = await runCli(bin, ['--workdir', tmp, '--dir', 'skills', '--no-input', 'install', slug], 120000);
      const skillDir = path.join(tmp, 'skills', slug);
      let exists = false;
      try { await fs.access(skillDir); exists = true; } catch { /* not installed */ }
      if (!exists) {
        return { ok: false, reason: (inst.out || 'clawhub install produced no skill folder').trim().slice(-600) };
      }
      const report = await auditDirectory(skillDir);
      return { ok: true, report };
    } catch (e: any) {
      return { ok: false, reason: e.message };
    } finally {
      fs.rm(tmp, { recursive: true, force: true }).catch(() => { /* best-effort */ });
    }
  });
}
