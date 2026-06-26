import { describe, it, expect } from 'vitest';
import {
  parseBacklog, serializeItem, setStatus, appendItems, parseAmendments,
  selectBatch, isComplete, acceptanceOfDone, backlogStats, hasBacklog, nextId,
  blockedWithSatisfiedDeps,
} from '../electron/council/gdd';

const MD = `# Tiny Game — GDD
Vision prose that the parser must ignore.

## Systems
Some [bracketed] prose that is NOT a backlog line.

## Backlog
- [x] [S-000] Scaffold | rigor: light | accept: index.html opens
- [ ] [S-001] Vertical slice | slice | rigor: full | accept: arrows move; no console errors
- [ ] [S-002] Enemies | deps: S-001 | rigor: full | accept: enemies spawn; die on hit
- [~] [S-003] Netcode | deps: S-002 | blocked: too early
- [?] [Q-001] Combat: real-time or turn-based?
`;

describe('gdd parse', () => {
  it('parses only backlog lines, with status / id / fields', () => {
    const items = parseBacklog(MD);
    expect(items.map((i) => i.id)).toEqual(['S-000', 'S-001', 'S-002', 'S-003', 'Q-001']);
    const by = Object.fromEntries(items.map((i) => [i.id, i]));
    expect(by['S-000'].status).toBe('done');
    expect(by['S-001'].status).toBe('todo');
    expect(by['S-003'].status).toBe('blocked');
    expect(by['Q-001'].status).toBe('question');
    expect(by['S-001'].slice).toBe(true);
    expect(by['S-001'].rigor).toBe('full');
    expect(by['S-000'].rigor).toBe('light');
    expect(by['S-002'].deps).toEqual(['S-001']);
    expect(by['S-001'].accept).toContain('arrows move');
  });

  it('hasBacklog / backlogStats reflect the doc', () => {
    expect(hasBacklog(MD)).toBe(true);
    expect(hasBacklog('# No backlog here')).toBe(false);
    const s = backlogStats(parseBacklog(MD));
    expect(s).toMatchObject({ total: 5, done: 1, blocked: 1, todo: 2, question: 1 });
  });
});

describe('gdd batch selection (dependency-aware, slice-first)', () => {
  it('only surfaces todos whose deps are all done; slice goes first', () => {
    const batch = selectBatch(parseBacklog(MD), { maxSize: 5 });
    // S-002 deps on S-001 (not done) → not ready; S-001 ready and is the slice
    expect(batch.map((i) => i.id)).toEqual(['S-001']);
  });

  it('a dependent becomes ready once its dep is done', () => {
    const md2 = setStatus(MD, 'S-001', 'done');
    const batch = selectBatch(parseBacklog(md2), { maxSize: 5 });
    expect(batch.map((i) => i.id)).toEqual(['S-002']);
  });

  it('design mode surfaces open questions only', () => {
    expect(selectBatch(parseBacklog(MD), { mode: 'design', maxSize: 5 }).map((i) => i.id)).toEqual(['Q-001']);
  });

  it('respects maxSize', () => {
    const md = `## Backlog\n- [ ] [S-1] a | rigor: light\n- [ ] [S-2] b | rigor: light\n- [ ] [S-3] c | rigor: light`;
    expect(selectBatch(parseBacklog(md), { maxSize: 2 }).length).toBe(2);
  });
});

describe('gdd completeness', () => {
  it('build: incomplete while a ready todo remains, complete when only done/blocked left', () => {
    expect(isComplete(parseBacklog(MD), 'build')).toBe(false);
    const finished = setStatus(setStatus(MD, 'S-001', 'done'), 'S-002', 'done');
    // S-003 stays blocked → not actionable → backlog is complete (won't spin forever)
    expect(isComplete(parseBacklog(finished), 'build')).toBe(true);
  });

  it('design: complete once no question items remain', () => {
    expect(isComplete(parseBacklog(MD), 'design')).toBe(false);
    expect(isComplete(parseBacklog(setStatus(MD, 'Q-001', 'done')), 'design')).toBe(true);
  });
});

describe('gdd status flips are deterministic and line-local', () => {
  it('setStatus flips the marker and can attach a note, leaving other lines intact', () => {
    const md = setStatus(MD, 'S-002', 'blocked', 'build failed');
    const it = parseBacklog(md).find((x) => x.id === 'S-002')!;
    expect(it.status).toBe('blocked');
    expect(it.note).toBe('build failed');
    // unrelated lines unchanged
    expect(parseBacklog(md).find((x) => x.id === 'S-000')!.status).toBe('done');
  });

  it('setStatus is a no-op for an unknown id', () => {
    expect(setStatus(MD, 'Z-999', 'done')).toBe(MD);
  });

  it('serializeItem round-trips through parseBacklog', () => {
    const line = serializeItem({ id: 'S-050', status: 'todo', title: 'Title', deps: ['S-001'], rigor: 'full', slice: true, accept: 'a; b' });
    const it = parseBacklog(`## Backlog\n${line}`)[0];
    expect(it).toMatchObject({ id: 'S-050', deps: ['S-001'], rigor: 'full', slice: true, accept: 'a; b' });
  });
});

describe('gdd amendments + append', () => {
  it('parseAmendments reassigns colliding/missing ids and tolerates a bare description', () => {
    const existing = parseBacklog(MD);
    const text = [
      'some agent output',
      'GDD-AMENDMENT: - [ ] [S-001] duplicate id | rigor: full | accept: x',  // collides with S-001
      'GDD-AMENDMENT: just a plain feature description',                        // no marker/id
      'trailing noise',
    ].join('\n');
    const lines = parseAmendments(text, existing);
    expect(lines.length).toBe(2);
    const ids = lines.map((l) => l.match(/\[([A-Za-z]+-\d+)\]/)?.[1]);
    expect(new Set(ids).size).toBe(2);          // distinct
    expect(ids).not.toContain('S-001');         // collision reassigned
    expect(ids.every((id) => /^S-\d+$/.test(id!))).toBe(true);
  });

  it('appendItems inserts under the Backlog heading', () => {
    const md = appendItems(MD, ['- [ ] [S-099] New thing | rigor: light']);
    const items = parseBacklog(md);
    expect(items.find((i) => i.id === 'S-099')).toBeTruthy();
    // still one backlog section, original items preserved
    expect(items.length).toBe(6);
  });

  it('nextId picks a fresh, padded id for a prefix', () => {
    expect(nextId(parseBacklog(MD), 'S')).toBe('S-004');   // max existing S is S-003
    expect(nextId(parseBacklog(MD), 'Q')).toBe('Q-002');
  });
});

describe('gdd regression context', () => {
  it('acceptanceOfDone lists shipped items only', () => {
    const acc = acceptanceOfDone(parseBacklog(MD));
    expect(acc).toContain('S-000');
    expect(acc).not.toContain('S-001');   // not done yet
  });
});

describe('gdd stall recovery (blocked-slice retry)', () => {
  // Reproduces the moss-hollow failure: the blocked root S-001 strands everything; it must be
  // surfaced as retryable (its own deps are satisfied), while items blocked BY it are not.
  const STALLED = `## Backlog
- [~] [S-001] root slice | slice | rigor: full | blocked: builder returned prose, not files
- [x] [S-000] scaffold | rigor: light
- [~] [S-003] blocked but dep done | deps: S-000
- [~] [S-004] blocked because S-001 is blocked | deps: S-001`;

  it('returns blocked items whose deps are all done (retry candidates), not those blocked by a blocked dep', () => {
    const r = blockedWithSatisfiedDeps(parseBacklog(STALLED)).map((i) => i.id).sort();
    expect(r).toEqual(['S-001', 'S-003']);   // S-004 excluded (its dep S-001 is still blocked)
  });

  it('a stalled backlog (0 ready) is recoverable while a blocked root has retry budget', () => {
    const items = parseBacklog(STALLED);
    expect(selectBatch(items).length).toBe(0);                 // nothing ready → stalled
    expect(blockedWithSatisfiedDeps(items).length).toBeGreaterThan(0);   // …but recoverable
    // simulate one retry of the root: unblock S-001 → it becomes the ready slice again
    const retried = setStatus(STALLED, 'S-001', 'todo');
    expect(selectBatch(parseBacklog(retried)).map((i) => i.id)).toEqual(['S-001']);
  });
});
