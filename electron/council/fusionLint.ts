/**
 * fusionLint.ts — Deterministic pre-gate for Fusion Council methods (the "P5" gate).
 *
 * WHY THIS EXISTS
 * ---------------
 * In the Crucible run that produced the SporeSpore evaluator, the QA gate bounced the
 * whole session with "major" on a FALSE NEGATIVE: it reviewed a truncated copy of the
 * weakest agent's draft, called the missing 85% "missing functionality," and terminated.
 * Separately, two real classes of defect slipped through every model review:
 *   1. "dead-code-before-correcting-comment" — an agent emits a wrong line, then a comment
 *      (or a "**CORRECTION**" block) admitting it's wrong, but leaves the wrong code in place.
 *      An executor copying verbatim ships the broken version.
 *   2. truncated functions / artifacts cut mid-token (e.g. ended at "...happens in `val").
 *   3. changelog claims that contradict the code ("replaced X with Dijkstra" while the code
 *      still calls pop_front; "removed HEIGHT_REF" while HEIGHT_REF still appears).
 *
 * These are all DETERMINISTIC and FREE to check. Running this BEFORE spending any QA model
 * call catches the cheap-to-find, expensive-to-miss defects and (critically) detects the
 * truncation that caused the bounce. It is intentionally dependency-free and language-light
 * so it works on GDScript, TS, Python, or prose-with-fenced-code artifacts alike.
 *
 * It never throws and never aborts — it returns findings. Callers decide whether to route
 * findings into a bounded repair loop (they should) or proceed.
 */

// ----------------------------- Types -----------------------------

export type LintSeverity = "block" | "warn" | "info";

export interface LintFinding {
  rule: string;          // machine id, e.g. "dead-code-correction"
  severity: LintSeverity;
  line: number;          // 1-indexed line in the artifact; 0 if whole-artifact
  excerpt: string;       // the offending text, trimmed
  message: string;       // human explanation for the repair agent
}

export interface LintResult {
  passed: boolean;       // true iff zero "block" findings
  findings: LintFinding[];
  blockCount: number;
  warnCount: number;
}

interface CodeBlock {
  startLine: number;     // 1-indexed line of the line AFTER the opening fence
  endLine: number;       // 1-indexed line of the closing fence (or EOF)
  closed: boolean;       // false if the artifact ended with the fence still open
  lines: string[];       // raw lines of code inside the fence
}

// ----------------------------- Public entry -----------------------------

/**
 * Lint a single artifact (the full text an agent produced, prose + fenced code).
 * Pass `{ source }` when you want the truncation check to compare the received artifact
 * against the original — a length mismatch is the exact signature of the bounce-causing
 * handoff truncation.
 */
export function lintArtifact(
  text: string,
  opts: { source?: string } = {},
): LintResult {
  const findings: LintFinding[] = [];
  const lines = text.split(/\r?\n/);
  const blocks = extractCodeBlocks(lines);

  findings.push(...checkHandoffTruncation(text, opts.source));
  findings.push(...checkDeadCodeBeforeCorrection(lines, blocks));
  findings.push(...checkParenAndBlockBalance(text, lines, blocks));
  findings.push(...checkChangelogVsCode(text, blocks));

  const blockCount = findings.filter((f) => f.severity === "block").length;
  const warnCount = findings.filter((f) => f.severity === "warn").length;
  return { passed: blockCount === 0, findings, blockCount, warnCount };
}

/** Convenience: render findings as a compact report for a repair agent's prompt. */
export function formatFindings(result: LintResult): string {
  if (result.findings.length === 0) return "LINT: clean (0 findings).";
  const lines = result.findings
    .sort((a, b) => sevRank(b.severity) - sevRank(a.severity) || a.line - b.line)
    .map(
      (f) =>
        `[${f.severity.toUpperCase()}] ${f.rule} (line ${f.line}): ${f.message}` +
        (f.excerpt ? `\n      → ${f.excerpt}` : ""),
    );
  return `LINT: ${result.blockCount} blocking, ${result.warnCount} warn.\n${lines.join("\n")}`;
}

function sevRank(s: LintSeverity): number {
  return s === "block" ? 2 : s === "warn" ? 1 : 0;
}

// ----------------------------- Check 1: handoff truncation -----------------------------
//
// The bounce-causer. Two signatures:
//   (a) the artifact passed to a downstream model is SHORTER than the source it came from
//       (inline-truncation at a char/token cap) — only checkable when `source` is given;
//   (b) the artifact ends mid-token: dangling inline-code span, trailing operator/comma,
//       or an open code fence at EOF.

function checkHandoffTruncation(text: string, source?: string): LintFinding[] {
  const out: LintFinding[] = [];

  // (a) length mismatch vs the original artifact (the literal bounce cause).
  if (source && text.length < source.length * 0.98) {
    const pct = Math.round((text.length / source.length) * 100);
    out.push({
      rule: "handoff-truncation",
      severity: "block",
      line: 0,
      excerpt: `received ${text.length} chars vs source ${source.length} (${pct}%)`,
      message:
        "Artifact passed downstream is materially shorter than its source — it was " +
        "truncated during prompt assembly. Pass by file reference, do not inline-truncate. " +
        "This is the defect that false-bounced the SporeSpore run.",
    });
  }

  // (b) ends mid-token. Look at the trimmed tail of the whole artifact.
  const tail = text.replace(/\s+$/, "");
  const lastLine = tail.split(/\r?\n/).pop() ?? "";

  // Unterminated inline code span on the final line (e.g. ended at: in `val ).
  // Skip fence markers (```), which legitimately carry 3 backticks and aren't inline spans.
  const isFenceMarker = /^\s*```/.test(lastLine);
  const backticks = (lastLine.match(/`/g) ?? []).length;
  if (!isFenceMarker && backticks % 2 === 1) {
    out.push({
      rule: "truncation-midtoken",
      severity: "block",
      line: countLines(tail),
      excerpt: clip(lastLine),
      message:
        "Artifact ends inside an unterminated inline-code span — classic mid-token " +
        "truncation. The downstream reviewer will see an incomplete artifact.",
    });
  }

  // Dangling operator / open-paren / comma at the very end of the artifact.
  // Restricted to unambiguous code-mid-expression danglers — sentence punctuation
  // (. : - < >) is excluded so prose ending in a period doesn't false-positive.
  // Truncations like "clampf((... 0.0, 1." are caught by the bracket-balance check instead.
  if (/[(,+*/=&|]\s*$/.test(tail) && !/[;}\])]\s*$/.test(tail)) {
    out.push({
      rule: "truncation-dangling",
      severity: "block",
      line: countLines(tail),
      excerpt: clip(lastLine),
      message:
        "Artifact ends on a dangling operator/comma/open-paren — the final statement is " +
        "incomplete (cut mid-expression).",
    });
  }

  return out;
}

// ----------------------------- Check 2: dead-code-before-correcting-comment -----------------------------
//
// Pattern A (inside code): a value-bearing line carrying a self-doubt comment, e.g.
//     Vector3(-e.y, -e.y, e.z),   # BUG: should be e.x? No...
// Pattern B (prose after code): a "**CORRECTION**" / "typo" / "should be X not Y" block
// that FOLLOWS a code fence — meaning the code above is knowingly wrong but left in place.

const SELF_DOUBT =
  /\b(BUG\b|FIXME|XXX|TODO:?\s*fix|should be\b|typo\b|this is wrong|actually should|no[,.]?\s*wait|oops|incorrect\b)/i;

const CORRECTION_PROSE =
  /(\*\*?CORRECTION\*\*?|^correction\b|\btypo from\b|should be `[^`]+`,?\s*not `[^`]+`|^.{0,40}\bFixed:\s*$)/im;

function checkDeadCodeBeforeCorrection(
  lines: string[],
  blocks: CodeBlock[],
): LintFinding[] {
  const out: LintFinding[] = [];

  // Pattern A — self-doubt comment on a value-bearing code line.
  for (const block of blocks) {
    block.lines.forEach((raw, i) => {
      const ln = block.startLine + i;
      // value-bearing = has a return/assignment/literal-bearing call before a comment
      const hasValue = /(\breturn\b|=|:=|\bVector[234]\b|\bclampf?\(|\[|\{)/.test(raw);
      const commentIdx = findCommentStart(raw);
      if (hasValue && commentIdx >= 0) {
        const comment = raw.slice(commentIdx);
        if (SELF_DOUBT.test(comment)) {
          out.push({
            rule: "dead-code-correction",
            severity: "block",
            line: ln,
            excerpt: clip(raw),
            message:
              "Code line carries a self-doubt comment (BUG/should be/typo/etc.). The agent " +
              "flagged its own line as wrong but left it executable. An executor will ship " +
              "the broken version. Resolve to the correct value with no leftover wrong line.",
          });
        }
      }
    });
  }

  // Pattern B — a "CORRECTION"/"Fixed:" prose block that appears AFTER a code fence.
  // If a correction block exists, the most recent code fence above it is the suspect.
  let lastFenceEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) lastFenceEnd = i + 1; // 1-indexed
    if (CORRECTION_PROSE.test(lines[i]) && lastFenceEnd > 0) {
      out.push({
        rule: "dead-code-correction-prose",
        severity: "block",
        line: i + 1,
        excerpt: clip(lines[i]),
        message:
          "A 'CORRECTION'/'typo'/'should be X not Y'/'Fixed:' note follows a code block. " +
          "The code block above (ending ~line " +
          lastFenceEnd +
          ") is the knowingly-wrong version, left in place. Replace the block with the " +
          "corrected code and delete the correction note.",
      });
      lastFenceEnd = -1; // one finding per code/correction pair
    }
  }

  return out;
}

// ----------------------------- Check 3: paren / block balance (truncated functions) -----------------------------
//
// For each fenced code block: if the fence is unclosed at EOF, or bracket balance is
// non-zero at the close, the block was cut off (a truncated function).

function checkParenAndBlockBalance(
  _text: string,
  _lines: string[],
  blocks: CodeBlock[],
): LintFinding[] {
  const out: LintFinding[] = [];

  for (const block of blocks) {
    if (!block.closed) {
      out.push({
        rule: "code-fence-unclosed",
        severity: "block",
        line: block.startLine,
        excerpt: clip(block.lines[block.lines.length - 1] ?? ""),
        message:
          "A code fence opened but never closed before EOF — the code block is truncated.",
      });
      continue;
    }
    const bal = bracketBalance(block.lines.join("\n"));
    if (bal.paren !== 0 || bal.square !== 0 || bal.curly !== 0) {
      out.push({
        rule: "bracket-imbalance",
        severity: "block",
        line: block.endLine,
        excerpt: `( ${bal.paren}  [ ${bal.square}  { ${bal.curly}`,
        message:
          "Bracket balance is non-zero in this code block — a function/expression is " +
          "incomplete (likely truncated mid-body). Counts shown are opens-minus-closes.",
      });
    }
  }

  return out;
}

function bracketBalance(s: string): { paren: number; square: number; curly: number } {
  // crude but effective: ignore content of string/char literals to avoid false counts.
  const cleaned = stripStringsAndComments(s);
  let paren = 0,
    square = 0,
    curly = 0;
  for (const ch of cleaned) {
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "[") square++;
    else if (ch === "]") square--;
    else if (ch === "{") curly++;
    else if (ch === "}") curly--;
  }
  return { paren, square, curly };
}

// ----------------------------- Check 4: changelog vs code -----------------------------
//
// Heuristic, advisory (warn). Extracts "removed/replaced/no longer uses X" claims from
// prose and checks whether X still appears in the code fences. Caught the real case where
// a changelog claimed "replaced with Dijkstra" while the code still ran pop_front (FIFO).

function checkChangelogVsCode(text: string, blocks: CodeBlock[]): LintFinding[] {
  const out: LintFinding[] = [];
  const codeText = blocks.map((b) => b.lines.join("\n")).join("\n");
  const code = stripStringsAndComments(codeText);

  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    // "removed X" / "no longer use(s) X" / "deleted X" / "dropped X"
    const removed = line.match(
      /\b(removed|deleted|dropped|eliminated|no longer (?:use|uses|using|call|calls|calling))\s+`?([A-Za-z_]\w{2,})`?/i,
    );
    if (removed) {
      const tok = removed[2];
      if (containsToken(code, tok)) {
        out.push({
          rule: "changelog-contradiction",
          severity: "warn",
          line: i + 1,
          excerpt: clip(line),
          message: `Changelog claims '${removed[1]} ${tok}', but '${tok}' still appears in code. Verify the change was actually made.`,
        });
      }
    }
    // "replaced A with B" — A should be gone from code.
    const replaced = line.match(
      /\breplaced?\s+`?([A-Za-z_]\w{2,})`?\s+with\s+`?([A-Za-z_]\w{2,})`?/i,
    );
    if (replaced) {
      const oldTok = replaced[1];
      const newTok = replaced[2];
      if (containsToken(code, oldTok) && !containsToken(code, newTok)) {
        out.push({
          rule: "changelog-contradiction",
          severity: "warn",
          line: i + 1,
          excerpt: clip(line),
          message: `Changelog claims '${oldTok}' was replaced with '${newTok}', but the code still contains '${oldTok}' and not '${newTok}'.`,
        });
      }
    }
  });

  return out;
}

// ----------------------------- shared helpers -----------------------------

function extractCodeBlocks(lines: string[]): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  let open = false;
  let start = 0;
  let buf: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) {
      if (!open) {
        open = true;
        start = i + 2; // first content line is the next line, 1-indexed
        buf = [];
      } else {
        blocks.push({ startLine: start, endLine: i + 1, closed: true, lines: buf });
        open = false;
      }
    } else if (open) {
      buf.push(lines[i]);
    }
  }
  if (open) {
    // fence never closed — truncated block
    blocks.push({ startLine: start, endLine: lines.length, closed: false, lines: buf });
  }
  return blocks;
}

/** Find the start index of a line comment (#, //) outside of strings; -1 if none. */
function findCommentStart(line: string): number {
  let inS: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inS) {
      if (c === inS && line[i - 1] !== "\\") inS = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") inS = c;
    else if (c === "#") return i;
    else if (c === "/" && line[i + 1] === "/") return i;
  }
  return -1;
}

function stripStringsAndComments(s: string): string {
  // remove // and # line comments and "…"/'…'/`…` string contents
  return s
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1") // // comments (avoid eating ://)
    .replace(/#[^\n]*/g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''")
    .replace(/`(?:\\.|[^`\\])*`/g, "``");
}

function containsToken(code: string, tok: string): boolean {
  return new RegExp(`\\b${escapeRe(tok)}\\b`).test(code);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clip(s: string, n = 120): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function countLines(s: string): number {
  return s.split(/\r?\n/).length;
}

/* ---------------------------------------------------------------------------
 * Wiring (see electron/council/run.ts — pre-gate lint before any QA model call):
 *
 *   import { lintArtifact, formatFindings } from "./fusionLint";
 *   const result = lintArtifact(consolidated, { source: rawConsolidated });
 *   if (!result.passed) {
 *     // route result.findings into a bounded repair loop — DO NOT abort.
 *     await repairLoop(consolidated, formatFindings(result), { maxRounds: 2 });
 *   }
 * ------------------------------------------------------------------------- */
