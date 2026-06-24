// Shared Atlas data model. Kept dependency-free so the pure logic (parsing,
// staleness, card/graph assembly) is unit-testable in node without the native
// better-sqlite3 binding (which is built for Electron's ABI and won't load in
// vitest — see RECON.md / the repo's existing "no DB in tests" convention).

export type SymbolKind =
  | 'function' | 'method' | 'class' | 'interface' | 'type'
  | 'const' | 'module' | 'component' | 'enum' | 'variable';

export type SymbolStatus = 'active' | 'orphaned' | 'deprecated' | 'superseded';

export type EdgeKind = 'calls' | 'imports' | 'references' | 'extends' | 'implements';

/** A symbol as produced by a parser, before it gets a DB row id. */
export interface ParsedSymbol {
  /** Stable identity within a parse pass: `<relPath>#<qualifiedName>`. Edges reference this. */
  key: string;
  file: string;            // workspace-relative, forward slashes
  kind: SymbolKind;
  name: string;
  qualifiedName: string;   // e.g. `Foo.bar` for a method, `baz` for a top-level fn
  signature?: string;
  startLine: number;       // 1-based
  endLine: number;         // 1-based
  doc?: string;
  deprecated?: boolean;    // @deprecated in leading jsdoc
  exported?: boolean;      // part of the module's public surface
}

/** A directed edge between two symbol keys. */
export interface ParsedEdge {
  srcKey: string;
  dstKey: string;
  kind: EdgeKind;
  resolved: boolean;       // true = resolved via the TS type checker
}

export interface ParseResult {
  symbols: ParsedSymbol[];
  edges: ParsedEdge[];
}

/** Persisted symbol shape (with DB id + computed status). */
export interface AtlasSymbol extends ParsedSymbol {
  id: number;
  fileId: number;
  status: SymbolStatus;
  supersededBy?: number | null;
  refCount: number;
  summary?: string | null;
  gitLastDate?: number | null;
}

export interface SymbolCard {
  id: number;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  signature?: string;
  summary?: string | null;
  doc?: string | null;
  location: string;        // `file:line`
  status: SymbolStatus;
  supersededBy?: string | null;  // location of the superseding symbol
  refCount: number;
  gitLastDate?: number | null;
  callers: { name: string; location: string }[];
  callees: { name: string; location: string }[];
}
