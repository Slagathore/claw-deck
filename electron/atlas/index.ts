// The Cartographer — builds/refreshes a workspace's Atlas.
// `writeIndex` is driver-agnostic (Queryable) so the full parse→persist→tag
// pipeline is tested under node:sqlite in vitest. `indexWorkspace` is the
// Electron-side wrapper that walks the FS and opens the per-workspace
// better-sqlite3 handle.
//
// Phase 1 does a full wipe+insert each pass (correct, simple). Incremental
// re-index (watch.ts diffs one file) is an additive refinement — see watch.ts.

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { Queryable, rowId } from './driver';
import { migrate } from './schema';
import { parseTsProgram } from './parse/tsProgram';
import { parsePolyglot, polyLangOf } from './parse/polyglot';
import { computeStaleness, makeEntrypointPredicate } from './staleness';
import { ParseResult } from './types';

export interface FileMeta { lang: string; hash: string; mtime: number; gitLastDate?: number | null }

export interface WriteIndexInput {
  parse: ParseResult;
  fileMeta: Record<string, FileMeta>;   // relPath → meta
  entryFiles: string[];
  mode?: string;
}

export interface IndexCounts { files: number; symbols: number; edges: number; runId: number; byStatus: Record<string, number> }

/** Persist a parse result + computed staleness into an Atlas DB (any driver). */
export function writeIndex(db: Queryable, input: WriteIndexInput, now: number): IndexCounts {
  migrate(db);
  const { parse, fileMeta, entryFiles } = input;

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM atlas_edges; DELETE FROM atlas_embeddings; DELETE FROM atlas_symbols; DELETE FROM atlas_files;');

    const runRes = db.prepare(`INSERT INTO atlas_runs(started, mode) VALUES(?, ?)`).run(now, input.mode ?? 'full');
    const runId = rowId(runRes);

    // files
    const fileIds = new Map<string, number>();
    const insFile = db.prepare(`INSERT INTO atlas_files(path, lang, hash, mtime, git_last_date) VALUES(?,?,?,?,?)`);
    const filesInParse = new Set(parse.symbols.map((s) => s.file));
    for (const file of filesInParse) {
      const m = fileMeta[file] ?? { lang: file.endsWith('.tsx') ? 'tsx' : 'ts', hash: '', mtime: now, gitLastDate: null };
      fileIds.set(file, rowId(insFile.run(file, m.lang, m.hash, m.mtime, m.gitLastDate ?? null)));
    }

    // staleness (reachability + superseded). similarPairs come from embeddings later.
    const { status, supersededBy, refCount } = computeStaleness({
      symbols: parse.symbols.map((s) => ({ key: s.key, exported: s.exported, deprecated: s.deprecated })),
      edges: parse.edges.map((e) => ({ srcKey: e.srcKey, dstKey: e.dstKey })),
      isEntrypoint: makeEntrypointPredicate(entryFiles),
    });

    // symbols
    const symIds = new Map<string, number>();
    const insSym = db.prepare(`INSERT INTO atlas_symbols(file_id, key, kind, name, qualified_name, signature, start_line, end_line, doc, status, ref_count, last_seen_run) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const s of parse.symbols) {
      const fid = fileIds.get(s.file);
      if (fid == null) continue;
      const st = status.get(s.key) ?? 'active';
      const rc = refCount.get(s.key) ?? 0;
      symIds.set(s.key, rowId(insSym.run(fid, s.key, s.kind, s.name, s.qualifiedName, s.signature ?? null, s.startLine, s.endLine, s.doc ?? null, st, rc, runId)));
    }

    // superseded_by (now that ids exist)
    const updSup = db.prepare(`UPDATE atlas_symbols SET superseded_by = ? WHERE id = ?`);
    for (const [key, byKey] of supersededBy) {
      const a = symIds.get(key); const b = symIds.get(byKey);
      if (a != null && b != null) updSup.run(b, a);
    }

    // edges
    const insEdge = db.prepare(`INSERT INTO atlas_edges(src, dst, kind, resolved) VALUES(?,?,?,?)`);
    let edgeCount = 0;
    for (const e of parse.edges) {
      const s = symIds.get(e.srcKey); const d = symIds.get(e.dstKey);
      if (s == null || d == null) continue;
      insEdge.run(s, d, e.kind, e.resolved ? 1 : 0);
      edgeCount++;
    }

    const byStatus: Record<string, number> = { active: 0, orphaned: 0, deprecated: 0, superseded: 0 };
    for (const s of parse.symbols) { if (s.kind === 'module') continue; const st = status.get(s.key) ?? 'active'; byStatus[st] = (byStatus[st] ?? 0) + 1; }

    db.prepare(`UPDATE atlas_runs SET finished = ?, files_indexed = ?, symbols = ? WHERE id = ?`).run(now, fileIds.size, symIds.size, runId);
    db.exec('COMMIT');
    return { files: fileIds.size, symbols: symIds.size, edges: edgeCount, runId, byStatus };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// ---- Electron-side FS walk ------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-electron', 'dist-installer', '.git', '.fusion', 'staging-source', 'quarantine', 'certs', 'data', '.vite', 'out']);
const EXTS = new Set(['.ts', '.tsx', '.py', '.pyi', '.sh', '.bash', '.gd']);

function langOf(rel: string): string {
  if (rel.endsWith('.tsx')) return 'tsx';
  if (rel.endsWith('.ts')) return 'ts';
  return polyLangOf(rel) ?? 'text';
}

export function collectSourceFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(full); }
      else if (EXTS.has(path.extname(e.name)) && !e.name.endsWith('.d.ts')) out.push(full);
    }
  };
  walk(root);
  return out;
}

const ENTRY_HINTS = ['electron/main.ts', 'electron/preload.ts', 'src/main.tsx', 'src/main.ts', 'src/index.tsx', 'src/index.ts', 'src/App.tsx', 'index.ts'];

function entryFilesFor(root: string, rels: string[]): string[] {
  const present = new Set(rels);
  const entries = ENTRY_HINTS.filter((h) => present.has(h));
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const cand: string[] = [];
    if (typeof pkg.main === 'string') cand.push(pkg.main);
    if (pkg.bin && typeof pkg.bin === 'object') cand.push(...Object.values(pkg.bin as Record<string, string>));
    for (const c of cand) {
      const tsGuess = c.replace(/^dist-electron\//, 'electron/').replace(/^dist\//, 'src/').replace(/\.js$/, '.ts');
      if (present.has(tsGuess)) entries.push(tsGuess);
    }
  } catch { /* no package.json — hints only */ }
  for (const r of rels) if (r.startsWith('bin/')) entries.push(r);
  return [...new Set(entries)];
}

/** Read + parse a workspace into a ParseResult plus per-file metadata. */
export function scanWorkspace(root: string): { parse: ParseResult; fileMeta: Record<string, FileMeta>; entryFiles: string[] } {
  const abs = collectSourceFiles(root);
  const tsFiles: Record<string, string> = {};
  const polyFiles: Record<string, string> = {};
  const fileMeta: Record<string, FileMeta> = {};
  for (const f of abs) {
    let content: string;
    try { content = fs.readFileSync(f, 'utf8'); } catch { continue; }
    const rel = path.relative(root, f).replace(/\\/g, '/');
    if (rel.endsWith('.ts') || rel.endsWith('.tsx')) tsFiles[rel] = content; else polyFiles[rel] = content;
    let mtime = Date.now();
    try { mtime = Math.floor(fs.statSync(f).mtimeMs); } catch { /* ignore */ }
    fileMeta[rel] = { lang: langOf(rel), hash: crypto.createHash('sha256').update(content).digest('hex'), mtime, gitLastDate: null };
  }
  const ts = parseTsProgram(tsFiles);
  const poly = parsePolyglot(polyFiles);
  const parse: ParseResult = { symbols: [...ts.symbols, ...poly.symbols], edges: [...ts.edges, ...poly.edges] };
  return { parse, fileMeta, entryFiles: entryFilesFor(root, [...Object.keys(tsFiles), ...Object.keys(polyFiles)]) };
}
