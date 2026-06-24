// Minimal ambient types for Node 24's built-in `node:sqlite`, scoped to the
// subset Atlas uses. @types/node@20 (this repo's pin) predates node:sqlite, so
// we declare it here instead of bumping @types/node globally (which would churn
// strictness across the whole codebase). Used by the code-brain MCP server and
// the vitest pipeline tests; the Electron main process uses better-sqlite3.
// If @types/node is ever bumped to a version that ships these, delete this file.

declare module 'node:sqlite' {
  interface StatementSync {
    all(...params: any[]): any[];
    get(...params: any[]): any;
    run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean; open?: boolean });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
