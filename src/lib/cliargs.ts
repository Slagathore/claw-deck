/**
 * Shell-style argument splitter shared by the Console launcher.
 * Honors single and double quotes; collapses runs of whitespace.
 *
 * Lives in lib/ (not a tab) so it can be unit-tested and reused after the
 * Run-a-CLI + Terminal tabs were merged into the single Console tab.
 */
export function parseArgs(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) { quote = null; continue; }
      cur += c;
    } else {
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === ' ' || c === '\t') {
        if (cur) { out.push(cur); cur = ''; }
        continue;
      }
      cur += c;
    }
  }
  if (cur) out.push(cur);
  return out;
}
