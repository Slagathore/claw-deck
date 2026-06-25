// Typed thin wrappers over window.api.atlas.* (BOOTSTRAP §1 Phase-1 file list).
// Keeps ProjectBrainTab free of raw IPC and gives one place to evolve the surface.

export type AtlasStatus = 'active' | 'orphaned' | 'deprecated' | 'superseded';

export const STATUS_COLOR: Record<AtlasStatus, string> = {
  active: '#4ade80',     // --good
  orphaned: '#8a93a6',   // --muted
  deprecated: '#fbbf24', // --warn
  superseded: '#f87171', // --bad
};

export const STATUS_BADGE: Record<AtlasStatus, 'ok' | 'warn' | 'bad' | ''> = {
  active: 'ok', deprecated: 'warn', superseded: 'bad', orphaned: '',
};

export const atlas = {
  open: (ws: string) => window.api.atlas.open(ws),
  index: (ws: string) => window.api.atlas.index(ws),
  status: (ws: string) => window.api.atlas.status(ws),
  query: (ws: string, tool: string, arg: string) => window.api.atlas.query(ws, tool, arg),
  graph: (ws: string, statuses?: string[], file?: string, search?: string, limit?: number) => window.api.atlas.graph(ws, statuses, file, search, limit),
  metrics: (ws: string) => window.api.atlas.metrics(ws),
  card: (ws: string, ref: string) => window.api.atlas.card(ws, ref),
  enrich: (ws: string, kind: 'embed' | 'summarize') => window.api.atlas.enrich(ws, kind),
  close: (ws: string) => window.api.atlas.close(ws),
  onEvent: (cb: (e: any) => void) => window.api.atlas.onEvent(cb),
};
