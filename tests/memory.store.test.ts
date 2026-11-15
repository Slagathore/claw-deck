/// <reference path="../electron/atlas/sqlite-node.d.ts" />
import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import type { Queryable } from '../electron/atlas/driver';
import {
  appendMessage, branchThread, chunkText, clearThreads, createThread, deleteThread, ftsQuery, getThread,
  importLegacyHistory, indexStats, listThreads, migrateMemory, pendingChunks, putVec, searchMemory,
  searchThreads, searchVectors, titleFrom, truncateThread, updateMessageMeta, updateThread,
} from '../electron/memory/store';

function open(): Queryable {
  const db = new DatabaseSync(':memory:') as unknown as Queryable;
  expect(migrateMemory(db).fts).toBe(true);
  return db;
}
const count = (db: Queryable, table: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as any).n);
const vec = (...a: number[]) => Float32Array.from(a);

describe('memory store: threads', () => {
  it('saves a whole thread in order and titles it from the first user message', () => {
    const db = open();
    const t = createThread(db, { agent: false, backend: 'auto', model: 'llama3.2' });
    expect(appendMessage(db, t.id, { role: 'user', content: 'How do I set up the filesystem MCP server?' }).seq).toBe(0);
    expect(appendMessage(db, t.id, { role: 'assistant', content: 'Open Library and click install.', thinking: 'hmm', meta: { model: 'llama3.2' } }).seq).toBe(1);
    expect(appendMessage(db, t.id, { role: 'user', content: 'thanks', images: ['data:image/png;base64,AAAA'] }).seq).toBe(2);

    const got = getThread(db, t.id)!;
    expect(got.thread.title).toBe('How do I set up the filesystem MCP server?');
    expect(got.messages.map(m => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(got.messages[1].thinking).toBe('hmm');
    expect(got.messages[1].meta.model).toBe('llama3.2');
    expect(got.messages[2].images).toEqual(['data:image/png;base64,AAAA']);
    expect(listThreads(db)[0]).toMatchObject({ id: t.id, messageCount: 3, preview: 'thanks' });
  });

  it('is durable: a second migrate on the same database keeps everything', () => {
    const db = open();
    const t = createThread(db);
    appendMessage(db, t.id, { role: 'user', content: 'remember the alamo' });
    migrateMemory(db);
    expect(getThread(db, t.id)!.messages).toHaveLength(1);
  });

  it('truncate drops later messages and their index rows', () => {
    const db = open();
    const t = createThread(db);
    for (const c of ['one apple', 'two banana', 'three cherry']) appendMessage(db, t.id, { role: 'user', content: c });
    truncateThread(db, t.id, 1);
    expect(getThread(db, t.id)!.messages.map(m => m.content)).toEqual(['one apple']);
    expect(count(db, 'memory_chunks')).toBe(1);
    expect(searchMemory(db, { query: 'cherry' })).toHaveLength(0);
    // the next message reuses the freed sequence number
    expect(appendMessage(db, t.id, { role: 'assistant', content: 'fresh' }).seq).toBe(1);
  });

  it('delete and clear leave no orphaned index rows', () => {
    const db = open();
    const a = createThread(db); const b = createThread(db);
    const m = appendMessage(db, a.id, { role: 'user', content: 'alpha content here' });
    appendMessage(db, b.id, { role: 'user', content: 'beta content here' });
    putVec(db, Number((db.prepare('SELECT id FROM memory_chunks WHERE message_id = ?').get(m.id) as any).id), 'm', vec(1, 0));
    deleteThread(db, a.id);
    expect(getThread(db, a.id)).toBeNull();
    expect(count(db, 'memory_chunks')).toBe(1);
    expect(count(db, 'memory_vecs')).toBe(0);
    expect(count(db, 'memory_fts')).toBe(1);
    clearThreads(db);
    for (const tbl of ['threads', 'thread_messages', 'memory_chunks', 'memory_vecs', 'memory_fts']) expect(count(db, tbl)).toBe(0);
  });

  it('branch copies messages up to a point into a new thread', () => {
    const db = open();
    const t = createThread(db, { agent: true, model: 'x' });
    for (const c of ['q1', 'a1', 'q2', 'a2']) appendMessage(db, t.id, { role: c.startsWith('q') ? 'user' : 'assistant', content: c });
    const br = branchThread(db, t.id, 1)!;
    const got = getThread(db, br.id)!;
    expect(got.messages.map(m => m.content)).toEqual(['q1', 'a1']);
    expect(got.thread.title).toContain('(branch)');
    expect(got.thread.agent).toBe(1);
    expect(getThread(db, t.id)!.messages).toHaveLength(4); // source untouched
  });

  it('updates thread fields and message meta', () => {
    const db = open();
    const t = createThread(db);
    const m = appendMessage(db, t.id, { role: 'assistant', content: 'plan', meta: { agent: true } });
    updateThread(db, t.id, { title: 'Renamed', agent: true, model: 'kimi' });
    updateMessageMeta(db, m.id, { agent: true, runs: { 0: { status: 'ok', output: 'done' } } });
    const got = getThread(db, t.id)!;
    expect(got.thread).toMatchObject({ title: 'Renamed', agent: 1, model: 'kimi' });
    expect(got.messages[0].meta.runs['0'].status).toBe('ok');
  });

  it('imports the legacy per-turn history once', () => {
    const db = open();
    db.exec(`CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, backend TEXT NOT NULL, model TEXT, prompt TEXT, response TEXT, thinking TEXT, tags TEXT, meta TEXT)`);
    const ins = db.prepare(`INSERT INTO history(ts,backend,model,prompt,response,thinking) VALUES(?,?,?,?,?,?)`);
    ins.run(1000, 'chat', 'llama3.2', 'what is a monad', 'a monoid in the category of endofunctors', '');
    ins.run(2000, 'console:shell', null, 'npm test', 'all green', '');
    expect(importLegacyHistory(db)).toBe(2);
    expect(importLegacyHistory(db)).toBe(0); // idempotent
    const rows = listThreads(db);
    expect(rows.map(r => r.kind).sort()).toEqual(['chat', 'console']);
    expect(rows.find(r => r.kind === 'chat')).toMatchObject({ created: 1000, messageCount: 2, backend: null, model: 'llama3.2' });
    expect(rows.find(r => r.kind === 'console')).toMatchObject({ backend: 'console:shell' });
    expect(searchMemory(db, { query: 'endofunctors' })[0].threadTitle).toBe('what is a monad');
  });

  it('skips the legacy import cleanly when there is no old table', () => {
    expect(importLegacyHistory(open())).toBe(0);
  });

  function withLegacy(n: number) {
    const db = open();
    db.exec(`CREATE TABLE history (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, backend TEXT NOT NULL, model TEXT, prompt TEXT, response TEXT, thinking TEXT, tags TEXT, meta TEXT)`);
    const ins = db.prepare(`INSERT INTO history(ts,backend,model,prompt,response,thinking) VALUES(?,?,?,?,?,?)`);
    for (let i = 1; i <= n; i++) ins.run(1000 * i, 'chat', 'llama3.2', `old question ${i} about walruses`, `old answer ${i}`, '');
    return db;
  }

  it('Clear all really clears: imported history does not come back on the next launch', () => {
    const db = withLegacy(3);
    expect(importLegacyHistory(db)).toBe(3);
    clearThreads(db);
    expect(count(db, 'history')).toBe(0);            // the pre-upgrade rows are gone from disk too
    expect(importLegacyHistory(db)).toBe(0);         // next boot
    expect(listThreads(db)).toHaveLength(0);
    expect(searchMemory(db, { query: 'walruses' })).toEqual([]);
  });

  it('a deleted imported thread stays deleted, including the newest one', () => {
    const db = withLegacy(3);
    importLegacyHistory(db);
    const newest = listThreads(db).find(t => t.title.includes('question 3'))!;
    deleteThread(db, newest.id);
    expect(count(db, 'history')).toBe(2);            // its original row went with it
    expect(importLegacyHistory(db)).toBe(0);         // next boot does not bring it back
    expect(listThreads(db).map(t => t.title).sort()).toEqual(['old question 1 about walruses', 'old question 2 about walruses']);
  });

  it('rows written by an older build after the import are picked up exactly once', () => {
    const db = withLegacy(2);
    importLegacyHistory(db);
    clearThreads(db);
    db.prepare(`INSERT INTO history(ts,backend,model,prompt,response,thinking) VALUES(?,?,?,?,?,?)`).run(9000, 'chat', 'x', 'written after a downgrade', 'ok', '');
    expect(importLegacyHistory(db)).toBe(1);
    expect(importLegacyHistory(db)).toBe(0);
    expect(listThreads(db).map(t => t.title)).toEqual(['written after a downgrade']);
  });

  it('a database imported before the watermark existed is not imported twice', () => {
    const db = withLegacy(2);
    importLegacyHistory(db);
    db.exec(`DELETE FROM memory_meta`);              // as left by a build that tracked the import on the threads
    expect(importLegacyHistory(db)).toBe(0);
    expect(listThreads(db)).toHaveLength(2);
  });
});

describe('memory store: text helpers', () => {
  it('chunks long text on boundaries with every part covered', () => {
    const para = (n: number) => `Paragraph ${n} ` + 'word '.repeat(120);
    const text = [1, 2, 3, 4, 5].map(para).join('\n\n');
    const chunks = chunkText(text, 800, 100);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every(c => c.length <= 800)).toBe(true);
    for (const n of [1, 2, 3, 4, 5]) expect(chunks.some(c => c.includes(`Paragraph ${n} `))).toBe(true);
    expect(chunkText('short')).toEqual(['short']);
    expect(chunkText('   ')).toEqual([]);
  });

  it('terminates on text with no break points', () => {
    const chunks = chunkText('x'.repeat(5000), 1000, 100);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.length).toBeLessThan(10);
  });

  it('builds FTS queries that cannot inject syntax', () => {
    expect(ftsQuery('the and for')).toBeNull();
    expect(ftsQuery('vector "search" NEAR(')).toBe('"vector" OR "search" OR "near"');
    expect(ftsQuery('docker compose networking', true)).toBe('"docker" AND "compose" AND "networking"');
    const db = open();
    const t = createThread(db);
    appendMessage(db, t.id, { role: 'user', content: 'anything' });
    expect(() => searchMemory(db, { query: '") OR * AND NOT (' })).not.toThrow();
  });

  it('prefix matching and the substring fallback find what the word index cannot', () => {
    expect(ftsQuery('docker compose', false, true)).toBe('"docker"* OR "compose"*');
    const db = open();
    const t = createThread(db, { title: 'Misc notes' });
    appendMessage(db, t.id, { role: 'user', content: 'The configuration for docker lives in the UI settings, v2 of the db schema.' });
    appendMessage(db, t.id, { role: 'user', content: 'Progress is at 100% on file_a, unrelated otherwise.' });
    const find = (query: string) => searchMemory(db, { query }).map(h => h.text.slice(0, 20));
    expect(find('config')).toEqual(['The configuration fo']);       // part of a longer word
    expect(find('dock')).toEqual(['The configuration fo']);
    expect(find('ui')).toEqual(['The configuration fo']);           // too short for the word index
    expect(find('v2')).toEqual(['The configuration fo']);
    expect(find('of the')).toEqual(['The configuration fo']);       // nothing but stop words
    expect(find('100%')).toEqual(['Progress is at 100% ']);         // % is literal, not a wildcard
    expect(find('file_a')).toEqual(['Progress is at 100% ']);       // _ is literal too
    expect(find('zzz')).toEqual([]);
    expect(searchThreads(db, { query: 'ui' }).map(r => r.id)).toEqual([t.id]);
    // automatic recall stays strict: no prefix guessing, no substring fallback
    expect(searchMemory(db, { query: 'config', strict: true })).toEqual([]);
    expect(searchMemory(db, { query: 'ui', strict: true })).toEqual([]);
  });

  it('titles are single-line and capped', () => {
    expect(titleFrom('  hello\n  world ')).toBe('hello world');
    expect(titleFrom('x'.repeat(200)).length).toBeLessThanOrEqual(64);
    expect(titleFrom('')).toBe('Untitled chat');
  });
});

describe('memory store: search', () => {
  function seeded() {
    const db = open();
    const cooking = createThread(db, { title: 'Sourdough notes' });
    const code = createThread(db, { title: 'Docker networking' });
    const m1 = appendMessage(db, cooking.id, { role: 'user', content: 'My sourdough starter needs feeding every twelve hours with rye flour.' });
    const m2 = appendMessage(db, code.id, { role: 'user', content: 'The compose bridge network could not resolve the postgres hostname.' });
    const m3 = appendMessage(db, code.id, { role: 'assistant', content: 'Put both services on the same user-defined network so DNS works.' });
    const chunkOf = (messageId: number) => Number((db.prepare('SELECT id FROM memory_chunks WHERE message_id = ?').get(messageId) as any).id);
    return { db, cooking, code, c1: chunkOf(m1.id), c2: chunkOf(m2.id), c3: chunkOf(m3.id) };
  }

  it('keyword search finds the right thread without any embeddings', () => {
    const { db, cooking } = seeded();
    const hits = searchMemory(db, { query: 'how often do I feed the starter' });
    expect(hits[0].threadId).toBe(cooking.id);
    expect(hits[0].lexical).toBe(true);
    expect(hits[0].sim).toBeNull();
  });

  it('vector search ranks by cosine and ignores other models and dimensions', () => {
    const { db, c1, c2, c3 } = seeded();
    putVec(db, c1, 'emb', vec(1, 0, 0));
    putVec(db, c2, 'emb', vec(0, 2, 0));      // stored normalized, so length does not matter
    putVec(db, c3, 'other-model', vec(0, 1, 0));
    const top = searchVectors(db, 'emb', vec(0.1, 0.9, 0), 5);
    expect(top.map(t => t.chunkId)).toEqual([c2, c1]);
    expect(top[0].sim).toBeGreaterThan(0.99);
    expect(searchVectors(db, 'emb', vec(1, 0), 5)).toEqual([]); // wrong dimension
  });

  it('semantic match wins even with no shared words', () => {
    const { db, code, c1, c2, c3 } = seeded();
    putVec(db, c1, 'emb', vec(1, 0, 0));
    putVec(db, c2, 'emb', vec(0, 1, 0));
    putVec(db, c3, 'emb', vec(0, 0.9, 0.1));
    const hits = searchMemory(db, { query: 'containers cannot talk', queryVec: vec(0, 1, 0), model: 'emb' });
    expect(hits[0].threadId).toBe(code.id);
    expect(hits[0].sim).toBeGreaterThan(0.9);
  });

  it('strict mode drops weak matches and respects excludeThreadId', () => {
    const { db, code, cooking, c1, c2, c3 } = seeded();
    putVec(db, c1, 'emb', vec(1, 0, 0));
    putVec(db, c2, 'emb', vec(0, 1, 0));
    putVec(db, c3, 'emb', vec(0, 1, 0));
    const strict = searchMemory(db, { query: 'unrelated words', queryVec: vec(0, 1, 0), model: 'emb', strict: true });
    expect(strict.every(h => h.threadId === code.id)).toBe(true);
    expect(searchMemory(db, { query: 'x', queryVec: vec(0, 1, 0), model: 'emb', strict: true, excludeThreadId: code.id })).toEqual([]);
    // without vectors, strict demands every term
    const db2 = seeded().db;
    expect(searchMemory(db2, { query: 'sourdough spaceship', strict: true })).toEqual([]);
    expect(searchMemory(db2, { query: 'sourdough starter', strict: true })).toHaveLength(1);
    expect(cooking.id).not.toBe(code.id);
  });

  it('thread search returns each thread once, with a snippet, and matches titles', () => {
    const { db, code, cooking } = seeded();
    const rows = searchThreads(db, { query: 'network hostname' });
    expect(rows.map(r => r.id)).toEqual([code.id]);
    expect(rows[0].snippet).toBeTruthy();
    expect(searchThreads(db, { query: 'Sourdough notes' }).map(r => r.id)).toContain(cooking.id);
  });

  it('plan-result follow-ups are saved but kept out of the index', () => {
    const db = open();
    const t = createThread(db);
    appendMessage(db, t.id, { role: 'user', content: '[plan-results]\nStep 1 (shell): OK zebra' });
    expect(getThread(db, t.id)!.messages).toHaveLength(1);
    expect(searchMemory(db, { query: 'zebra' })).toEqual([]);
  });

  it('failed turns are saved but kept out of the index', () => {
    const db = open();
    const t = createThread(db);
    appendMessage(db, t.id, { role: 'assistant', content: 'Error: Ollama HTTP 500 cudaMalloc failed', meta: { error: true } });
    expect(getThread(db, t.id)!.messages[0].meta.error).toBe(true);
    expect(searchMemory(db, { query: 'cudaMalloc' })).toEqual([]);
  });

  it('tracks what still needs embedding, including after a model change', () => {
    const { db, c1 } = seeded();
    expect(pendingChunks(db, 'emb')).toHaveLength(3);
    putVec(db, c1, 'emb', vec(1, 0));
    expect(pendingChunks(db, 'emb')).toHaveLength(2);
    expect(indexStats(db, 'emb')).toMatchObject({ chunks: 3, embedded: 1, threads: 2, messages: 3 });
    expect(pendingChunks(db, 'new-model')).toHaveLength(3); // old vectors are stale for a new model
    putVec(db, c1, 'new-model', vec(0, 1, 0));
    expect(indexStats(db, 'emb').embedded).toBe(0);
  });

  it('a vector that arrives after its passage was deleted is dropped', () => {
    const { db, cooking, c1 } = seeded();
    deleteThread(db, cooking.id);
    putVec(db, c1, 'emb', vec(1, 0, 0));
    expect(count(db, 'memory_vecs')).toBe(0);
    expect(indexStats(db, 'emb').embedded).toBe(0);
  });

  it('vector scan pages correctly past one page of rows', () => {
    const db = open();
    const t = createThread(db);
    db.exec('BEGIN');
    const ins = db.prepare('INSERT INTO memory_vecs(chunk_id,model,dim,vec) VALUES(?,?,?,?)');
    for (let i = 1; i <= 4500; i++) {
      const v = vec(Math.cos(i), Math.sin(i));
      ins.run(i, 'emb', 2, new Uint8Array(v.buffer));
    }
    db.exec('COMMIT');
    const top = searchVectors(db, 'emb', vec(Math.cos(4321), Math.sin(4321)), 3);
    expect(top[0].chunkId).toBe(4321);
    expect(top).toHaveLength(3);
    expect(top[0].sim).toBeGreaterThanOrEqual(top[1].sim);
    expect(t.id).toBeTruthy();
  });
});
