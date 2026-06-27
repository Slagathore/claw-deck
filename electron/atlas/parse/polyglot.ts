// Polyglot structural parser for python / bash / gdscript (BOOTSTRAP §3 Phase 1
// "polyglot structural parse"). Produces the same ParseResult as tsProgram.ts so
// it merges seamlessly.
//
// IMPLEMENTATION NOTE (deviation from the locked web-tree-sitter choice): this is
// a dependency-free line/indentation structural extractor, not tree-sitter.
// Why: gdscript has NO prebuilt grammar wasm on npm (tree-sitter-gdscript is C
// source only → needs an emscripten build), and the python/bash wasms in
// tree-sitter-wasms carry ABI/packaging (asarUnpack) risk against web-tree-sitter
// 0.26. A line-based extractor ships all three languages now, fully unit-tested,
// with zero native/wasm surface. It yields symbols + intra-file structural edges
// (resolved=0), which is exactly tree-sitter's "structural" remit here — swapping
// python/bash to tree-sitter later is a precision upgrade behind this same API.

import { type ParseResult, type ParsedSymbol, type ParsedEdge, type SymbolKind } from '../types';

export type PolyLang = 'python' | 'bash' | 'gdscript';

export function polyLangOf(relPath: string): PolyLang | null {
  if (relPath.endsWith('.py') || relPath.endsWith('.pyi')) return 'python';
  if (relPath.endsWith('.sh') || relPath.endsWith('.bash')) return 'bash';
  if (relPath.endsWith('.gd')) return 'gdscript';
  return null;
}

interface Raw extends ParsedSymbol { indent: number; bodyStart: number; bodyEnd: number }

const indentOf = (line: string): number => (line.match(/^[ \t]*/)?.[0].length ?? 0);
const MODULE_QN = '<module>';

/** Last 0-based line index of the block owned by a symbol at `indent` starting after `startIdx`. */
function blockEnd(lines: string[], startIdx: number, indent: number): number {
  let end = startIdx;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;             // blanks belong to the block
    if (indentOf(l) <= indent) break;    // dedent → block over
    end = i;
  }
  return end;
}

function parseIndented(rel: string, lines: string[], lang: 'python' | 'gdscript'): Raw[] {
  const syms: Raw[] = [];
  const classStack: { indent: number; name: string }[] = [];
  const classRe = lang === 'python' ? /^(\s*)class\s+([A-Za-z_]\w*)/ : /^(\s*)class\s+([A-Za-z_]\w*)\s*:/;
  const funcRe = lang === 'python' ? /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/ : /^(\s*)(?:static\s+)?func\s+([A-Za-z_]\w*)\s*\(/;
  const varRe = lang === 'gdscript' ? /^(\s*)(?:@?export[^\n]*?\s+)?(?:var|const)\s+([A-Za-z_]\w*)/ : /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/;
  const signalRe = /^(\s*)signal\s+([A-Za-z_]\w*)/;

  const push = (line: number, name: string, qn: string, kind: SymbolKind, indent: number) => {
    const be = blockEnd(lines, line, indent);
    syms.push({ key: `${rel}#${qn}`, file: rel, kind, name, qualifiedName: qn, signature: lines[line].trim().slice(0, 200), startLine: line + 1, endLine: be + 1, exported: !name.startsWith('_'), indent, bodyStart: line, bodyEnd: be });
  };

  // whole-file class name (gdscript `class_name X`)
  for (const [i, l] of lines.entries()) {
    const cn = lang === 'gdscript' ? l.match(/^class_name\s+([A-Za-z_]\w*)/) : null;
    if (cn) push(i, cn[1], cn[1], 'class', 0);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const ind = indentOf(line);
    while (classStack.length && ind <= classStack[classStack.length - 1].indent) classStack.pop();
    const enclosing = classStack.length ? classStack[classStack.length - 1] : null;

    let m: RegExpMatchArray | null;
    if ((m = line.match(classRe))) {
      push(i, m[2], m[2], 'class', ind);
      classStack.push({ indent: ind, name: m[2] });
    } else if ((m = line.match(funcRe))) {
      const qn = enclosing ? `${enclosing.name}.${m[2]}` : m[2];
      push(i, m[2], qn, enclosing ? 'method' : 'function', ind);
    } else if ((m = line.match(signalRe))) {
      push(i, m[2], enclosing ? `${enclosing.name}.${m[2]}` : m[2], 'const', ind);
    } else if ((m = line.match(varRe))) {
      const name = m[lang === 'gdscript' ? 2 : 1];
      if (name && (lang === 'gdscript' ? ind === 0 || enclosing : ind === 0)) {
        push(i, name, enclosing ? `${enclosing.name}.${name}` : name, 'const', ind);
      }
    }
  }
  return syms;
}

function parseBash(rel: string, lines: string[]): Raw[] {
  const syms: Raw[] = [];
  const re = /^(?:function\s+)?([A-Za-z_]\w*)\s*\(\s*\)\s*\{|^function\s+([A-Za-z_]\w*)\b/;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const name = m[1] || m[2];
    if (!name) continue;
    let end = i;
    for (let j = i + 1; j < lines.length; j++) { end = j; if (/^\}/.test(lines[j])) break; }
    syms.push({ key: `${rel}#${name}`, file: rel, kind: 'function', name, qualifiedName: name, signature: lines[i].trim().slice(0, 200), startLine: i + 1, endLine: end + 1, exported: true, indent: 0, bodyStart: i, bodyEnd: end });
  }
  return syms;
}

/** Parse python/bash/gdscript files into a merged ParseResult. */
export function parsePolyglot(files: Record<string, string>): ParseResult {
  const symbols: ParsedSymbol[] = [];
  const edges: ParsedEdge[] = [];

  for (const [rel, content] of Object.entries(files)) {
    const lang = polyLangOf(rel);
    if (!lang) continue;
    const lines = content.split(/\r?\n/);
    const raws = lang === 'bash' ? parseBash(rel, lines) : parseIndented(rel, lines, lang);

    // module anchor
    symbols.push({ key: `${rel}#${MODULE_QN}`, file: rel, kind: 'module', name: rel.split('/').pop() || rel, qualifiedName: MODULE_QN, startLine: 1, endLine: lines.length, exported: true });
    for (const r of raws) symbols.push({ key: r.key, file: r.file, kind: r.kind, name: r.name, qualifiedName: r.qualifiedName, signature: r.signature, startLine: r.startLine, endLine: r.endLine, exported: r.exported });

    // intra-file structural edges (resolved=0): calls + gdscript `extends`
    const byName = new Map<string, string>();          // simple name → key (last wins)
    for (const r of raws) byName.set(r.name, r.key);
    const moduleKey = `${rel}#${MODULE_QN}`;
    const seen = new Set<string>();
    const emit = (src: string, dst: string, kind: ParsedEdge['kind']) => {
      if (src === dst) return;
      const tag = `${src}|${dst}|${kind}`;
      if (seen.has(tag)) return; seen.add(tag);
      edges.push({ srcKey: src, dstKey: dst, kind, resolved: false });
    };

    // extends (gdscript file-level)
    for (const l of lines) {
      const ex = l.match(/^extends\s+([A-Za-z_]\w*)/);
      if (ex && byName.has(ex[1])) emit(moduleKey, byName.get(ex[1])!, 'extends');
    }

    const owners = raws.map((r) => ({ r, lo: r.bodyStart, hi: r.bodyEnd }));
    const ownerAt = (lineIdx: number): string => {
      let best: { key: string; span: number } | null = null;
      for (const o of owners) {
        if (lineIdx >= o.lo && lineIdx <= o.hi) { const span = o.hi - o.lo; if (!best || span < best.span) best = { key: o.r.key, span }; }
      }
      return best ? best.key : moduleKey;
    };
    for (let i = 0; i < lines.length; i++) {
      if (lang === 'bash') {
        // bash calls are bare command words, not name(...)
        const first = lines[i].trim().split(/\s+/)[0];
        if (first && byName.has(first)) emit(ownerAt(i), byName.get(first)!, 'calls');
      } else {
        for (const cm of lines[i].matchAll(/([A-Za-z_]\w*)\s*\(/g)) {
          const target = byName.get(cm[1]);
          if (target) emit(ownerAt(i), target, 'calls');
        }
      }
    }
  }
  return { symbols, edges };
}
