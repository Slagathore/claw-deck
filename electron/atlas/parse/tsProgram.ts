// TS/TSX structural + resolved-edge parser, built on the TypeScript compiler API
// (a dep already; loads in plain node, so this whole module is unit-testable in
// vitest without the native DB). Produces ParsedSymbol[] + ParsedEdge[]:
//   - one `module` symbol per file (reachability anchor + import target)
//   - top-level functions / classes / methods / interfaces / types / enums /
//     consts / components
//   - `calls` / `references` / `imports` / `extends` / `implements` edges,
//     resolved through the type checker (resolved=1) where the target is an
//     in-project declaration.
//
// Polyglot (python/bash/gdscript) lives in ./treeSitter.ts (deferred — see note
// there). This module owns the `.ts`/`.tsx` story, which is all of claw-deck.

import ts from 'typescript';
import { ParseResult, ParsedSymbol, ParsedEdge, SymbolKind, EdgeKind } from '../types';

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
  allowJs: false,
  skipLibCheck: true,
  noEmit: true,
  noLib: false,
  allowNonTsExtensions: true,
  esModuleInterop: true,
};

const norm = (p: string) => p.replace(/\\/g, '/');
const MODULE_QN = '<module>';

/** Build an in-memory TS Program over `files` (relPath → content). */
function createProgram(files: Record<string, string>): { program: ts.Program; rootNames: string[] } {
  const map = new Map<string, string>();
  for (const [p, c] of Object.entries(files)) map.set('/' + norm(p).replace(/^\/+/, ''), c);
  const rootNames = [...map.keys()];
  const sourceCache = new Map<string, ts.SourceFile>();

  const host: ts.CompilerHost = {
    getSourceFile: (fileName, langVersion) => {
      const n = norm(fileName);
      if (map.has(n)) {
        if (!sourceCache.has(n)) {
          sourceCache.set(n, ts.createSourceFile(fileName, map.get(n)!, langVersion, true));
        }
        return sourceCache.get(n);
      }
      const text = ts.sys.readFile(fileName);
      return text !== undefined ? ts.createSourceFile(fileName, text, langVersion, true) : undefined;
    },
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (f) => norm(f),
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => map.has(norm(f)) || ts.sys.fileExists(f),
    readFile: (f) => map.get(norm(f)) ?? ts.sys.readFile(f),
    directoryExists: () => true,
    getDirectories: () => [],
  };

  return { program: ts.createProgram(rootNames, OPTIONS, host), rootNames };
}

function isExported(node: ts.Node): boolean {
  const flags = ts.getCombinedModifierFlags(node as ts.Declaration);
  return !!(flags & ts.ModifierFlags.Export) || !!(flags & ts.ModifierFlags.Default);
}

function isPascal(name: string): boolean { return /^[A-Z]/.test(name); }

function jsdocOf(node: ts.Node): { doc?: string; deprecated?: boolean } {
  let deprecated = false;
  try {
    for (const tag of ts.getJSDocTags(node)) {
      if (tag.tagName.getText() === 'deprecated') deprecated = true;
    }
  } catch { /* getText may throw on synthetic nodes */ }
  let doc: string | undefined;
  try {
    const comments = (ts as any).getJSDocCommentsAndTags?.(node) as ts.Node[] | undefined;
    const first = comments?.find((c) => ts.isJSDoc(c)) as ts.JSDoc | undefined;
    const text = first ? ts.getTextOfJSDocComment(first.comment) : undefined;
    if (text) doc = text.trim().slice(0, 400);
  } catch { /* best-effort */ }
  return { doc, deprecated };
}

function firstLine(node: ts.Node, sf: ts.SourceFile): string {
  const t = node.getText(sf);
  const brace = t.indexOf('{');
  const head = (brace > 0 ? t.slice(0, brace) : t).replace(/\s+/g, ' ').trim();
  return head.slice(0, 240);
}

function lineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}
function endLineOf(node: ts.Node, sf: ts.SourceFile): number {
  return sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
}

/**
 * Parse a set of in-memory TS/TSX files into symbols + resolved edges.
 * @param files relPath (forward slashes) → file content
 */
export function parseTsProgram(files: Record<string, string>): ParseResult {
  const { program, rootNames } = createProgram(files);
  const checker = program.getTypeChecker();

  const symbols: ParsedSymbol[] = [];
  const edges: ParsedEdge[] = [];
  // Map a declaration node → the symbol key it defines (resolution target).
  const declToKey = new Map<ts.Node, string>();
  // Per source file: the enclosing-key resolver works off these.
  const seenEdge = new Set<string>();

  const rel = (sf: ts.SourceFile) => norm(sf.fileName).replace(/^\/+/, '');

  function add(sym: ParsedSymbol, declNodes: ts.Node[]) {
    symbols.push(sym);
    for (const d of declNodes) declToKey.set(d, sym.key);
  }

  // ---- Pass 1: collect symbols ---------------------------------------------
  for (const fileName of rootNames) {
    const sf = program.getSourceFile(fileName);
    if (!sf || sf.isDeclarationFile) continue;
    const relPath = rel(sf);
    const isTsx = relPath.endsWith('.tsx');

    // module anchor (exported = public file surface; reachability root candidate)
    add(
      { key: `${relPath}#${MODULE_QN}`, file: relPath, kind: 'module', name: relPath.split('/').pop() || relPath, qualifiedName: MODULE_QN, startLine: 1, endLine: sf.getLineAndCharacterOfPosition(sf.getEnd()).line + 1, exported: true },
      [sf],
    );

    const pushSym = (node: ts.Node, name: string, qualifiedName: string, kind: SymbolKind, declNodes: ts.Node[]) => {
      const { doc, deprecated } = jsdocOf(node);
      add({
        key: `${relPath}#${qualifiedName}`, file: relPath, kind, name, qualifiedName,
        signature: firstLine(node, sf), startLine: lineOf(node, sf), endLine: endLineOf(node, sf),
        doc, deprecated, exported: isExported(node),
      }, declNodes);
    };

    const visitTop = (node: ts.Node) => {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const name = node.name.text;
        pushSym(node, name, name, isTsx && isPascal(name) ? 'component' : 'function', [node, node.name]);
      } else if (ts.isClassDeclaration(node) && node.name) {
        const cls = node.name.text;
        pushSym(node, cls, cls, isTsx && isPascal(cls) ? 'component' : 'class', [node, node.name]);
        for (const m of node.members) {
          if ((ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)) && m.name && ts.isIdentifier(m.name)) {
            pushSym(m, m.name.text, `${cls}.${m.name.text}`, 'method', [m, m.name]);
          } else if (ts.isPropertyDeclaration(m) && m.name && ts.isIdentifier(m.name) && m.initializer && (ts.isArrowFunction(m.initializer) || ts.isFunctionExpression(m.initializer))) {
            pushSym(m, m.name.text, `${cls}.${m.name.text}`, 'method', [m, m.name]);
          }
        }
      } else if (ts.isInterfaceDeclaration(node)) {
        pushSym(node, node.name.text, node.name.text, 'interface', [node, node.name]);
      } else if (ts.isTypeAliasDeclaration(node)) {
        pushSym(node, node.name.text, node.name.text, 'type', [node, node.name]);
      } else if (ts.isEnumDeclaration(node)) {
        pushSym(node, node.name.text, node.name.text, 'enum', [node, node.name]);
      } else if (ts.isModuleDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        pushSym(node, node.name.text, node.name.text, 'module', [node, node.name]);
        if (node.body && ts.isModuleBlock(node.body)) node.body.statements.forEach(visitTop);
      } else if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) {
          if (!ts.isIdentifier(d.name)) continue;
          const name = d.name.text;
          const fnInit = d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer));
          const kind: SymbolKind = fnInit
            ? (isTsx && isPascal(name) ? 'component' : 'function')
            : (isTsx && isPascal(name) ? 'component' : 'const');
          pushSym(d, name, name, kind, [d, d.name]);
        }
      }
    };
    sf.statements.forEach(visitTop);
  }

  // ---- Pass 2: resolve edges ------------------------------------------------
  const keyOfDecl = (decl: ts.Node): string | undefined => {
    let n: ts.Node | undefined = decl;
    // climb to a node we mapped (e.g. Identifier → VariableDeclaration)
    while (n) { const k = declToKey.get(n); if (k) return k; n = n.parent; }
    return undefined;
  };

  const resolveTarget = (idNode: ts.Node): string | undefined => {
    let sym = checker.getSymbolAtLocation(idNode);
    if (!sym) return undefined;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try { sym = checker.getAliasedSymbol(sym); } catch { /* keep original */ }
    }
    for (const decl of sym.declarations ?? []) {
      const k = keyOfDecl(decl);
      if (k) return k;
    }
    return undefined;
  };

  const emit = (srcKey: string, dstKey: string, kind: EdgeKind) => {
    if (srcKey === dstKey) return;
    const tag = `${srcKey}|${dstKey}|${kind}`;
    if (seenEdge.has(tag)) return;
    seenEdge.add(tag);
    edges.push({ srcKey, dstKey, kind, resolved: true });
  };

  for (const fileName of rootNames) {
    const sf = program.getSourceFile(fileName);
    if (!sf || sf.isDeclarationFile) continue;
    const relPath = rel(sf);
    const moduleKey = `${relPath}#${MODULE_QN}`;

    const walk = (node: ts.Node, currentKey: string) => {
      // descend into a declaration → switch the enclosing key
      const ownKey = declToKey.get(node);
      const here = ownKey ?? currentKey;

      // heritage (extends/implements)
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) {
        for (const hc of node.heritageClauses ?? []) {
          const kind: EdgeKind = hc.token === ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
          for (const t of hc.types) {
            const dst = resolveTarget(t.expression);
            if (dst && here) emit(here, dst, kind);
          }
        }
      }

      // import declarations → 'imports' edges from the module
      if (ts.isImportDeclaration(node) && node.importClause) {
        const named = node.importClause.namedBindings;
        const specs: ts.ImportSpecifier[] = named && ts.isNamedImports(named) ? [...named.elements] : [];
        for (const s of specs) {
          const dst = resolveTarget(s.name);
          if (dst) emit(moduleKey, dst, 'imports');
        }
        if (node.importClause.name) {
          const dst = resolveTarget(node.importClause.name);
          if (dst) emit(moduleKey, dst, 'imports');
        }
        return; // don't double-count import idents as references
      }

      // identifier references (calls vs references)
      if (ts.isIdentifier(node)) {
        const parent = node.parent;
        const isNameOfDecl = parent && (parent as any).name === node && declToKey.has(parent);
        if (!isNameOfDecl) {
          const callExpr = parent && ts.isCallExpression(parent) && parent.expression === node;
          const dst = resolveTarget(node);
          if (dst && here) emit(here, dst, callExpr ? 'calls' : 'references');
        }
      } else if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.name)) {
        const parent = node.parent;
        const callExpr = parent && ts.isCallExpression(parent) && parent.expression === node;
        const dst = resolveTarget(node.name);
        if (dst && here) emit(here, dst, callExpr ? 'calls' : 'references');
      }

      node.forEachChild((c) => walk(c, here));
    };

    sf.statements.forEach((s) => walk(s, moduleKey));
  }

  return { symbols, edges };
}
