// FS watcher → debounced re-index. Uses built-in fs.watch({recursive:true})
// (works on Windows) instead of adding chokidar — BOOTSTRAP §3 explicitly allows
// "fs.watch — note the choice". Phase 1 triggers a full re-index on change;
// true per-file incremental is an additive refinement.

import * as fs from 'fs';

export interface Watcher { close(): void }

const IGNORE = new Set(['node_modules', '.git', '.fusion', 'dist', 'dist-electron', 'dist-installer', 'staging-source', 'quarantine', 'certs', 'data', '.vite', 'out']);

export function watchWorkspace(root: string, onChange: (files: string[]) => void, debounceMs = 600): Watcher {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let watcher: fs.FSWatcher | null = null;

  const flush = () => {
    const files = [...pending];
    pending.clear();
    timer = null;
    if (files.length) { try { onChange(files); } catch { /* indexer errors shouldn't kill the watcher */ } }
  };

  try {
    watcher = fs.watch(root, { recursive: true }, (_evt, filename) => {
      if (!filename) return;
      const rel = filename.toString().replace(/\\/g, '/');
      if (rel.split('/').some((seg) => IGNORE.has(seg))) return;
      if (!/\.(ts|tsx)$/.test(rel) || rel.endsWith('.d.ts')) return;
      pending.add(rel);
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    });
  } catch { /* recursive watch unsupported here → degrade to no-op (manual re-index still works) */ }

  return { close() { if (timer) clearTimeout(timer); try { watcher?.close(); } catch { /* ignore */ } } };
}
