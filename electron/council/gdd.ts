// FORGE campaign §1 — the Game Design Document ("the bible") as a parseable artifact.
//
// The GDD is human-readable markdown whose ONE machine-contract is a `## Backlog`
// section: a checklist of stable-id items the campaign loop selects, builds, and
// flips to done. Prose anywhere else is free — agents read all of it. Only the
// backlog lines are parsed, and only deterministic code (never an agent) flips a
// status, so progress can't drift. Pure + dependency-free → fully unit-testable.
//
// Backlog line grammar (one item per line, under a `## Backlog` heading):
//   - [ ] [S-001] Title text | deps: S-000, Q-002 | rigor: full | slice | accept: a; b; c
// Status markers:  [ ] todo · [x] done · [~] blocked · [?] open design question
// Tags (any order, `|`-separated, all optional): deps, rigor (light|full), accept,
//   blocked (reason), and the bare flag `slice` (vertical-slice — built first).

export type GddStatus = 'todo' | 'done' | 'blocked' | 'question';
export type Rigor = 'light' | 'full';

export interface GddItem {
  id: string;            // e.g. "S-001" / "Q-004"
  status: GddStatus;
  title: string;
  deps: string[];        // ids this item waits on
  rigor: Rigor;          // which inner cycle to run (cost tier)
  slice: boolean;        // vertical-slice — selected before non-slice work
  accept: string;        // acceptance criteria (becomes regression context once done)
  note?: string;         // blocked/done reason
  lineIndex: number;     // 0-based index into the source md's lines (for deterministic rewrite)
}

const MARKER: Record<string, GddStatus> = { ' ': 'todo', x: 'done', X: 'done', '~': 'blocked', '?': 'question' };
const FROM_STATUS: Record<GddStatus, string> = { todo: ' ', done: 'x', blocked: '~', question: '?' };
const ID_RE = /\[([A-Za-z]+-\d+)\]/;
const LINE_RE = /^(\s*[-*]\s*)\[([ xX~?])\]\s*\[([A-Za-z]+-\d+)\]\s*(.*)$/;
const ID_TOKEN = /^[A-Za-z]+-\d+$/;

/** Parse the `## Backlog` section into items. Lines outside it (prose) are ignored. */
export function parseBacklog(md: string): GddItem[] {
  const lines = (md ?? '').split(/\r?\n/);
  const items: GddItem[] = [];
  let inBacklog = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) { inBacklog = /^backlog\b/i.test(heading[2].trim()); continue; }
    if (!inBacklog) continue;
    const m = line.match(LINE_RE);
    if (!m) continue;
    const [, , marker, id, rest] = m;
    const parts = rest.split('|').map((s) => s.trim());
    const title = (parts.shift() ?? '').trim();
    const item: GddItem = { id, status: MARKER[marker] ?? 'todo', title, deps: [], rigor: 'full', slice: false, accept: '', lineIndex: i };
    for (const p of parts) {
      if (!p) continue;
      const kv = p.match(/^(\w+)\s*:\s*(.*)$/);
      if (!kv) { if (/^slice$/i.test(p)) item.slice = true; continue; }
      const key = kv[1].toLowerCase();
      const val = kv[2].trim();
      if (key === 'deps') item.deps = val.split(',').map((d) => d.trim()).filter((d) => ID_TOKEN.test(d));
      else if (key === 'rigor') item.rigor = /^light$/i.test(val) ? 'light' : 'full';
      else if (key === 'accept') item.accept = val;
      else if (key === 'blocked' || key === 'done' || key === 'note') item.note = val;
      else if (key === 'slice') item.slice = /^(true|yes|1)$/i.test(val) || val === '';
    }
    items.push(item);
  }
  return items;
}

/** Re-serialize one item to its canonical backlog line. */
export function serializeItem(item: Pick<GddItem, 'id' | 'status' | 'title' | 'deps' | 'rigor' | 'slice' | 'accept' | 'note'>): string {
  const tags: string[] = [];
  if (item.deps.length) tags.push(`deps: ${item.deps.join(', ')}`);
  tags.push(`rigor: ${item.rigor}`);
  if (item.slice) tags.push('slice');
  if (item.accept) tags.push(`accept: ${item.accept}`);
  if (item.note && (item.status === 'blocked' || item.status === 'done')) tags.push(`${item.status === 'blocked' ? 'blocked' : 'note'}: ${item.note}`);
  return `- [${FROM_STATUS[item.status]}] [${item.id}] ${item.title}${tags.length ? ` | ${tags.join(' | ')}` : ''}`;
}

/** Deterministically flip one item's status (+ optional note), returning the new md.
 *  No-op (returns input) if the id isn't found. Only the matched line is rewritten. */
export function setStatus(md: string, id: string, status: GddStatus, note?: string): string {
  const items = parseBacklog(md);
  const it = items.find((x) => x.id === id);
  if (!it) return md;
  const lines = (md ?? '').split(/\r?\n/);
  lines[it.lineIndex] = serializeItem({ ...it, status, note: note ?? it.note });
  return lines.join('\n');
}

/** Append new backlog lines under the `## Backlog` heading (used for vetted amendments). */
export function appendItems(md: string, newLines: string[]): string {
  const clean = newLines.map((l) => l.trim()).filter(Boolean);
  if (!clean.length) return md;
  const lines = (md ?? '').split(/\r?\n/);
  const headingIdx = lines.findIndex((l) => /^#{1,6}\s+backlog\b/i.test(l));
  if (headingIdx < 0) { lines.push('', '## Backlog', ...clean); return lines.join('\n'); }
  // find the last list line of the backlog section to insert after it
  let insertAt = headingIdx + 1;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{1,6}\s+/.test(lines[i])) break;          // next section ends the backlog
    if (LINE_RE.test(lines[i]) || lines[i].trim() === '') insertAt = i + 1;
  }
  lines.splice(insertAt, 0, ...clean);
  return lines.join('\n');
}

/** Known ids (so an amendment can be assigned a fresh, non-colliding id). */
export function nextId(items: GddItem[], prefix: string): string {
  const nums = items.filter((i) => i.id.startsWith(`${prefix}-`)).map((i) => Number(i.id.split('-')[1]) || 0);
  const n = (nums.length ? Math.max(...nums) : 0) + 1;
  return `${prefix}-${String(n).padStart(3, '0')}`;
}

/** Extract agent-proposed `GDD-AMENDMENT:` backlog lines from free text and normalize
 *  them to canonical lines with fresh ids (a proposed `[NEW]`/missing id is reassigned).
 *  Returns canonical backlog line strings ready for appendItems. */
export function parseAmendments(text: string, existing: GddItem[]): string[] {
  const out: string[] = [];
  const seen = new Set(existing.map((i) => i.id));
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const m = raw.match(/GDD-AMENDMENT:\s*(.*)$/i);
    if (!m) continue;
    let body = m[1].trim();
    if (!body) continue;
    if (!/^[-*]\s*\[/.test(body)) body = `- [ ] ${body}`;       // tolerate a bare description
    const line = body.match(LINE_RE);
    let item: GddItem;
    if (line) {
      const parsed = parseBacklog(`## Backlog\n${body}`)[0];
      if (!parsed) continue;
      item = parsed;
    } else {
      // has a marker but no id → synthesize one
      const desc = body.replace(/^[-*]\s*\[[ xX~?]\]\s*/, '').trim();
      item = { id: '', status: 'todo', title: desc, deps: [], rigor: 'full', slice: false, accept: '', lineIndex: -1 };
    }
    if (!item.id || seen.has(item.id)) item.id = nextId([...existing, ...out.map((l) => parseBacklog(`## Backlog\n${l}`)[0]).filter(Boolean)], item.id.split('-')[0] || 'S');
    seen.add(item.id);
    item.status = item.status === 'question' ? 'question' : 'todo';   // amendments enter as todo (or stay a question)
    out.push(serializeItem(item));
  }
  return out;
}

export interface BatchOptions { maxSize?: number; mode?: 'build' | 'design' }

/** Pick the next batch of actionable items, dependency-aware and vertical-slice-first.
 *  build mode  → todo items whose every dep is done. design mode → open questions. */
export function selectBatch(items: GddItem[], opts: BatchOptions = {}): GddItem[] {
  const maxSize = Math.max(1, opts.maxSize ?? 3);
  const done = new Set(items.filter((i) => i.status === 'done').map((i) => i.id));
  if (opts.mode === 'design') {
    return items.filter((i) => i.status === 'question').slice(0, maxSize);
  }
  const ready = items.filter((i) => i.status === 'todo' && i.deps.every((d) => done.has(d)));
  // slice-first, then declared order (file order is preserved by lineIndex)
  ready.sort((a, b) => Number(b.slice) - Number(a.slice) || a.lineIndex - b.lineIndex);
  return ready.slice(0, maxSize);
}

/** Done = no actionable items remain. build: no ready todos left (blocked/done don't count).
 *  design: no open questions left. A loop with only blocked items terminates (won't spin). */
export function isComplete(items: GddItem[], mode: 'build' | 'design' = 'build'): boolean {
  return selectBatch(items, { mode, maxSize: 1 }).length === 0;
}

/** Blocked items whose every dependency is DONE — i.e. they were blocked by their own
 *  build/gate failure, not by an unmet dependency. These are the retry candidates: re-running
 *  them can succeed (esp. a blocked vertical slice that strands the whole backlog). An item
 *  blocked because a dependency is itself blocked is NOT returned (fix the dependency first). */
export function blockedWithSatisfiedDeps(items: GddItem[]): GddItem[] {
  const done = new Set(items.filter((i) => i.status === 'done').map((i) => i.id));
  return items.filter((i) => i.status === 'blocked' && i.deps.every((d) => done.has(d)));
}

export interface BacklogStats { total: number; done: number; blocked: number; todo: number; question: number; ready: number }
export function backlogStats(items: GddItem[]): BacklogStats {
  const by = (s: GddStatus) => items.filter((i) => i.status === s).length;
  return { total: items.length, done: by('done'), blocked: by('blocked'), todo: by('todo'), question: by('question'), ready: selectBatch(items, { maxSize: 999 }).length };
}

/** Acceptance criteria of everything already shipped — fed back as the regression
 *  contract so a new batch can't silently break a finished one. */
export function acceptanceOfDone(items: GddItem[]): string {
  const lines = items.filter((i) => i.status === 'done' && i.accept).map((i) => `- [${i.id}] ${i.title}: ${i.accept}`);
  return lines.join('\n');
}

/** Has the document got a usable backlog at all? (charter sanity-check.) */
export function hasBacklog(md: string): boolean {
  return parseBacklog(md).length > 0;
}
