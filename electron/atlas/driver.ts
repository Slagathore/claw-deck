// Minimal SQLite surface shared by both drivers we use:
//   - better-sqlite3        (Electron main process, ABI-bound to Electron)
//   - node:sqlite (Node 24) (vitest tests + the standalone code-brain server)
// Keeping every Atlas SQL function typed against this interface lets the real
// queries run under vitest (node:sqlite loads in plain node; better-sqlite3 does
// not) and lets the MCP server reuse query.ts verbatim. Both drivers already
// expose prepare()/exec() with all()/get()/run(); run() returns lastInsertRowid.

export interface Stmt {
  all(...params: any[]): any[];
  get(...params: any[]): any;
  run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}

export interface Queryable {
  prepare(sql: string): Stmt;
  exec(sql: string): void;
}

export const rowId = (r: { lastInsertRowid: number | bigint }): number => Number(r.lastInsertRowid);
