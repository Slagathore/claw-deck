// Pure parsers for git porcelain / diff output. Kept dependency-free so the loop's
// "stage only what I produced, never the user's pre-existing WIP" logic is unit-testable.

/** Parse `git status --porcelain` (or `-z`-less porcelain) into the set of touched paths.
 *  Handles renames ("R  old -> new" → new) and quoted paths with spaces. */
export function parsePorcelain(stdout: string): string[] {
  const out: string[] = [];
  for (const line of (stdout ?? '').split(/\r?\n/)) {
    if (line.length < 4) continue;
    let p = line.slice(3).trim();                         // strip the 2-char XY status + space
    const arrow = p.indexOf(' -> ');
    if (arrow >= 0) p = p.slice(arrow + 4);               // rename: keep the destination path
    if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1).replace(/\\(.)/g, '$1');
    if (p) out.push(p);
  }
  return [...new Set(out)];
}

/** Files referenced by a unified diff (the `+++ b/<path>` / `diff --git` headers), minus /dev/null. */
export function diffFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const m of (diff ?? '').matchAll(/^\+\+\+ b\/(.+)$/gm)) { const f = m[1].trim(); if (f && f !== '/dev/null') files.add(f); }
  for (const m of (diff ?? '').matchAll(/^diff --git a\/.+ b\/(.+)$/gm)) { const f = m[1].trim(); if (f) files.add(f); }
  return [...files];
}
