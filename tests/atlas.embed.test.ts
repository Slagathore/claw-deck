/// <reference path="../electron/atlas/sqlite-node.d.ts" />
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from '../electron/atlas/schema';
import { applySupersededFromEmbeddings } from '../electron/atlas/embed';
import type { Queryable } from '../electron/atlas/driver';

const vecBlob = (arr: number[]): Buffer => { const f = Float32Array.from(arr); return Buffer.from(f.buffer, f.byteOffset, f.byteLength); };

function setup(): Queryable {
  const db = new DatabaseSync(':memory:') as unknown as Queryable;
  migrate(db);
  db.prepare("INSERT INTO atlas_files(id,path,lang,hash,mtime) VALUES(1,'a.ts','ts','h',0)").run();
  const sym = db.prepare('INSERT INTO atlas_symbols(id,file_id,key,kind,name,qualified_name,start_line,end_line,ref_count,status) VALUES(?,?,?,?,?,?,?,?,?,?)');
  sym.run(1, 1, 'a#foo', 'function', 'foo', 'foo', 1, 2, 3, 'active');    // referenced
  sym.run(2, 1, 'a#foo2', 'function', 'foo', 'foo', 10, 11, 0, 'active'); // same name, orphan, near-identical vec
  sym.run(3, 1, 'a#bar', 'function', 'bar', 'bar', 20, 21, 1, 'active');  // unrelated
  const emb = db.prepare('INSERT INTO atlas_embeddings(symbol_id,dim,vec) VALUES(?,?,?)');
  emb.run(1, 3, vecBlob([1, 0, 0]));
  emb.run(2, 3, vecBlob([0.99, 0.01, 0]));  // cosine ≈ 0.9999 with #1
  emb.run(3, 3, vecBlob([0, 1, 0]));        // orthogonal
  return db;
}

describe('applySupersededFromEmbeddings — scale-safe near-dup pass', () => {
  it('bucketed path (large repo) tags the orphan same-name dup superseded', () => {
    const db = setup();
    const tagged = applySupersededFromEmbeddings(db, 0.93, 0); // fullPairsMax=0 → force the bucketed branch
    expect(tagged).toBe(1);
    const s2 = db.prepare('SELECT status, superseded_by FROM atlas_symbols WHERE id=2').get() as any;
    expect(s2.status).toBe('superseded');
    expect(s2.superseded_by).toBe(1);
    expect((db.prepare('SELECT status FROM atlas_symbols WHERE id=3').get() as any).status).toBe('active'); // unrelated untouched
  });

  it('full O(n²) path (small repo) gives the same result', () => {
    const db = setup();
    expect(applySupersededFromEmbeddings(db, 0.93, 9999)).toBe(1);
  });
});
