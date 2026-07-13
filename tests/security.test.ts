import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { isHostAllowed, verifyChain, type AuditRow } from '../electron/ipc/security';

describe('isHostAllowed', () => {
  const allow = ['github.com', 'releases.openclaw.org'];
  it('rejects non-https', () => {
    expect(isHostAllowed('http://github.com/x', allow)).toBe(false);
  });
  it('accepts exact host', () => {
    expect(isHostAllowed('https://github.com/x/y', allow)).toBe(true);
  });
  it('accepts subdomain', () => {
    expect(isHostAllowed('https://api.github.com/x', allow)).toBe(true);
  });
  it('rejects unrelated host', () => {
    expect(isHostAllowed('https://evil.example.com/x', allow)).toBe(false);
  });
  it('rejects malformed url', () => {
    expect(isHostAllowed('not a url', allow)).toBe(false);
  });
});

// Builds a valid hash-chained row list using the exact same formula
// appendAudit() uses (sha256(prevHash + ts + kind + payload)), so these tests
// exercise verifyChain() against a real chain rather than a hand-faked one.
function chainOf(entries: { ts: number; kind: string; payload: string }[]): AuditRow[] {
  const rows: AuditRow[] = [];
  let prevHash = '';
  let id = 1;
  for (const e of entries) {
    const hash = crypto.createHash('sha256').update(prevHash + e.ts + e.kind + e.payload).digest('hex');
    rows.push({ id: id++, ts: e.ts, kind: e.kind, payload: e.payload, prev_hash: prevHash || null, hash });
    prevHash = hash;
  }
  return rows;
}

describe('verifyChain', () => {
  it('accepts an empty log', () => {
    const r = verifyChain([]);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(0);
  });

  it('accepts a valid chain of several entries', () => {
    const rows = chainOf([
      { ts: 1, kind: 'scan', payload: '{"file":"a"}' },
      { ts: 2, kind: 'upgrade:installed', payload: '{"name":"x"}' },
      { ts: 3, kind: 'upgrade:rollback', payload: '{"id":1}' }
    ]);
    const r = verifyChain(rows);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(3);
  });

  it('detects a tampered payload (hash no longer matches)', () => {
    const rows = chainOf([
      { ts: 1, kind: 'scan', payload: '{"file":"a"}' },
      { ts: 2, kind: 'upgrade:installed', payload: '{"name":"x"}' }
    ]);
    // Simulate someone editing row 2's payload directly in the DB after the
    // fact, without recomputing its hash.
    rows[1].payload = '{"name":"tampered"}';
    const r = verifyChain(rows);
    expect(r.ok).toBe(false);
    expect(r.brokenAtId).toBe(2);
    expect(r.reason).toMatch(/hash/);
  });

  it('detects a deleted row (breaks the prev_hash link)', () => {
    const rows = chainOf([
      { ts: 1, kind: 'scan', payload: '{"file":"a"}' },
      { ts: 2, kind: 'upgrade:installed', payload: '{"name":"x"}' },
      { ts: 3, kind: 'upgrade:rollback', payload: '{"id":1}' }
    ]);
    // Simulate deleting the middle row out of the table.
    const withGap = [rows[0], rows[2]];
    const r = verifyChain(withGap);
    expect(r.ok).toBe(false);
    expect(r.brokenAtId).toBe(3);
    expect(r.reason).toMatch(/prev_hash/);
  });

  it('detects a forged first row whose prev_hash is not empty', () => {
    const rows = chainOf([{ ts: 1, kind: 'scan', payload: '{}' }]);
    rows[0].prev_hash = 'not-actually-empty';
    const r = verifyChain(rows);
    expect(r.ok).toBe(false);
    expect(r.brokenAtId).toBe(1);
  });
});
