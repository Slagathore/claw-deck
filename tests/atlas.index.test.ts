/// <reference path="../electron/atlas/sqlite-node.d.ts" />
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { parseTsProgram } from '../electron/atlas/parse/tsProgram';
import { writeIndex } from '../electron/atlas/index';
import { migrate } from '../electron/atlas/schema';
import * as q from '../electron/atlas/query';
import type { Queryable } from '../electron/atlas/driver';

// Fixture workspace: an entry file that reaches `helper`, a deprecated symbol,
// a never-referenced internal orphan, and a duplicate cluster.
const FILES: Record<string, string> = {
  'electron/main.ts': `
import { register } from './ipc/handlers';
export function boot() { return register(); }
boot();
`,
  'electron/ipc/handlers.ts': `
import { cropRegion } from '../shot';
export function register() { return cropRegion(1, 2, 3, 4); }
/** @deprecated old path */
export function legacyRegister() { return 0; }
function neverUsed() { return 'orphan'; }
`,
  'electron/shot.ts': `
/** Crop a screenshot region to the given bounds. */
export function cropRegion(x: number, y: number, w: number, h: number) { return { x, y, w, h }; }
`,
};

function mkdb(): Queryable {
  const db = new DatabaseSync(':memory:');
  return db as unknown as Queryable;
}

describe('writeIndex + queries (node:sqlite)', () => {
  const db = mkdb();
  const parse = parseTsProgram(FILES);
  const counts = writeIndex(db, {
    parse,
    fileMeta: {},
    entryFiles: ['electron/main.ts'],
  }, 1_700_000_000_000);

  it('persists files / symbols / edges', () => {
    expect(counts.files).toBe(3);
    expect(counts.symbols).toBeGreaterThan(5);
    expect(counts.edges).toBeGreaterThan(0);
  });

  it('locate finds the cropping function by description', () => {
    const hits = q.locate(db, 'screenshot region crop');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].location).toContain('electron/shot.ts');
    expect(hits[0].name).toBe('cropRegion');
  });

  it('who_calls / calls_what resolve across files', () => {
    expect(q.whoCalls(db, 'cropRegion').some((c) => c.name === 'register')).toBe(true);
    expect(q.callsWhat(db, 'register').some((c) => c.name === 'cropRegion')).toBe(true);
  });

  it('get_card returns signature + callers + status', () => {
    const card = q.getCard(db, 'cropRegion');
    expect(card).not.toBeNull();
    expect(card!.kind).toBe('function');
    expect(card!.refCount).toBeGreaterThan(0);
    expect(card!.callers.some((c) => c.name === 'register')).toBe(true);
    expect(card!.location).toContain('electron/shot.ts:');
  });

  it('is_current reports orphaned / deprecated / active', () => {
    expect(q.isCurrent(db, 'neverUsed')?.status).toBe('orphaned');
    expect(q.isCurrent(db, 'legacyRegister')?.status).toBe('deprecated');
    expect(q.isCurrent(db, 'cropRegion')?.status).toBe('active');
  });

  it('status counts add up and graph is filterable', () => {
    const s = q.statusCounts(db);
    expect(s.total).toBe(s.byStatus.active + s.byStatus.orphaned + s.byStatus.deprecated + s.byStatus.superseded);
    const g = q.graph(db, { statuses: ['active'] });
    expect(g.nodes.every((n) => n.status === 'active')).toBe(true);
  });

  it('migration is idempotent', () => {
    expect(() => { migrate(db); migrate(db); }).not.toThrow();
    const ver = (db.prepare(`SELECT value FROM atlas_meta WHERE key='schema_version'`).get() as { value: string }).value;
    expect(ver).toBe('1');
  });
});
