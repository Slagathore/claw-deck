import * as path from 'path';
import * as fsp from 'fs/promises';

export interface FilePatch {
  /** POSIX-style path relative to source root. */
  path: string;
  mode: 'create' | 'replace' | 'delete';
  /** Full file contents for create/replace. */
  contents?: string;
}

export interface PatchSet {
  id: string;
  rationale: string;
  files: FilePatch[];
}

const FORBIDDEN_SEGMENTS = ['..', '.git', 'node_modules'];

/** Reject patches that escape the root or touch forbidden paths. */
export function validatePatchSet(set: PatchSet, root: string): { ok: boolean; reason?: string } {
  if (!set || !Array.isArray(set.files) || set.files.length === 0) {
    return { ok: false, reason: 'empty patch set' };
  }
  for (const f of set.files) {
    if (typeof f.path !== 'string' || f.path.length === 0) return { ok: false, reason: 'missing file path' };
    if (path.isAbsolute(f.path)) return { ok: false, reason: `absolute path: ${f.path}` };
    const norm = path.posix.normalize(f.path.replace(/\\/g, '/'));
    if (norm.startsWith('../') || norm === '..') return { ok: false, reason: `escapes root: ${f.path}` };
    const parts = norm.split('/');
    for (const p of parts) {
      if (FORBIDDEN_SEGMENTS.includes(p)) return { ok: false, reason: `forbidden segment ${p}: ${f.path}` };
    }
    const abs = path.resolve(root, norm);
    const rootAbs = path.resolve(root);
    if (!abs.startsWith(rootAbs + path.sep) && abs !== rootAbs) {
      return { ok: false, reason: `resolves outside root: ${f.path}` };
    }
    if (f.mode === 'create' || f.mode === 'replace') {
      if (typeof f.contents !== 'string') return { ok: false, reason: `missing contents for ${f.path}` };
    }
  }
  return { ok: true };
}

export async function applyPatchSet(set: PatchSet, root: string): Promise<{ changed: string[] }> {
  const v = validatePatchSet(set, root);
  if (!v.ok) throw new Error(`invalid patch: ${v.reason}`);
  const changed: string[] = [];
  for (const f of set.files) {
    const norm = path.posix.normalize(f.path.replace(/\\/g, '/'));
    const abs = path.resolve(root, norm);
    if (f.mode === 'delete') {
      try { await fsp.rm(abs, { force: true }); changed.push(norm); } catch { /* ignore */ }
      continue;
    }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, f.contents!, 'utf8');
    changed.push(norm);
  }
  return { changed };
}

/** Parse a model response that may contain JSON in a code fence. */
export function extractPatchSetFromText(text: string): PatchSet | null {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  // Try to find the first { ... } block that parses.
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const slab = body.slice(start, end + 1);
  try {
    const j = JSON.parse(slab);
    if (!j || !Array.isArray(j.files)) return null;
    return {
      id: typeof j.id === 'string' ? j.id : `patch-${Date.now().toString(36)}`,
      rationale: typeof j.rationale === 'string' ? j.rationale : '',
      files: j.files
    };
  } catch {
    return null;
  }
}
