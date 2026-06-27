// Status tagging — the "old-vs-new guarantee" (BOOTSTRAP §3 Phase 1).
// Pure function over plain symbol/edge data so it's fully unit-testable without
// the native DB. Precedence: deprecated > superseded > active > orphaned.
//
//   - reachability BFS from entrypoints (module anchors of entry files, tab
//     roots, exported handlers) → an internal symbol nothing reaches = orphaned.
//   - exported symbols are public surface: we can't prove them dead, so they
//     stay `active` even if unreachable within the project.
//   - `@deprecated` → deprecated.
//   - superseded: among an injected similar-pair, the zero-ref sibling when the
//     other has refs → superseded_by the other. (Pairs come from embedding
//     clusters in embed.ts; injected here so the rule is testable on its own.)

import { type SymbolStatus } from './types';

export interface StalenessSymbol {
  key: string;
  exported?: boolean;
  deprecated?: boolean;
}

export interface StalenessEdge {
  srcKey: string;
  dstKey: string;
}

export interface StalenessInput {
  symbols: StalenessSymbol[];
  edges: StalenessEdge[];
  /** Seeds for the reachability BFS (e.g. module anchors of entry files). */
  isEntrypoint: (key: string) => boolean;
  /** Similar symbol pairs from embedding clusters (optional; drives `superseded`). */
  similarPairs?: [string, string][];
}

export interface StalenessResult {
  status: Map<string, SymbolStatus>;
  supersededBy: Map<string, string>;
  refCount: Map<string, number>;
}

export function computeStaleness(input: StalenessInput): StalenessResult {
  const { symbols, edges } = input;
  const keys = new Set(symbols.map((s) => s.key));

  // incoming-edge counts (who references/calls this symbol)
  const refCount = new Map<string, number>();
  for (const k of keys) refCount.set(k, 0);
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!keys.has(e.srcKey) || !keys.has(e.dstKey)) continue;
    refCount.set(e.dstKey, (refCount.get(e.dstKey) ?? 0) + 1);
    (adj.get(e.srcKey) ?? adj.set(e.srcKey, []).get(e.srcKey)!).push(e.dstKey);
  }

  // reachability BFS from entrypoints
  const reachable = new Set<string>();
  const queue: string[] = [];
  for (const s of symbols) if (input.isEntrypoint(s.key)) { reachable.add(s.key); queue.push(s.key); }
  while (queue.length) {
    const cur = queue.shift()!;
    for (const next of adj.get(cur) ?? []) {
      if (!reachable.has(next)) { reachable.add(next); queue.push(next); }
    }
  }

  // superseded: zero-ref sibling of a referenced look-alike
  const supersededBy = new Map<string, string>();
  for (const [a, b] of input.similarPairs ?? []) {
    if (!keys.has(a) || !keys.has(b)) continue;
    const ra = refCount.get(a) ?? 0;
    const rb = refCount.get(b) ?? 0;
    if (ra > 0 && rb === 0) supersededBy.set(b, a);
    else if (rb > 0 && ra === 0) supersededBy.set(a, b);
  }

  const status = new Map<string, SymbolStatus>();
  for (const s of symbols) {
    let st: SymbolStatus;
    if (s.deprecated) st = 'deprecated';
    else if (supersededBy.has(s.key)) st = 'superseded';
    else if (reachable.has(s.key) || s.exported) st = 'active';
    else st = 'orphaned';
    status.set(s.key, st);
  }

  return { status, supersededBy, refCount };
}

/** Default entrypoint predicate: module anchors of known entry files. */
export function makeEntrypointPredicate(entryFiles: string[]): (key: string) => boolean {
  const set = new Set(entryFiles.map((f) => f.replace(/\\/g, '/')));
  return (key: string) => {
    const hash = key.indexOf('#');
    if (hash < 0) return false;
    const file = key.slice(0, hash);
    const qn = key.slice(hash + 1);
    return qn === '<module>' && set.has(file);
  };
}
