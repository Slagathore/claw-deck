// claw-bridge — a minimal VS Code extension that publishes editor-only signals
// to Claw Deck over a localhost HTTP server (BOOTSTRAP §3 Phase 6). It exposes
// what only the editor knows — live diagnostics, the active selection, document
// symbols, vscode.lm chat models (+ an invoke proxy), and configured MCP servers
// — so Claw Deck's Atlas/Council can read them when VS Code is open, and fall
// back to filesystem+git when it isn't. Read-only/observational; no edits.

import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const VERSION = '0.1.0';
let server: http.Server | undefined;

function severity(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error: return 'error';
    case vscode.DiagnosticSeverity.Warning: return 'warning';
    case vscode.DiagnosticSeverity.Information: return 'info';
    default: return 'hint';
  }
}

function diagnostics(file: string | null) {
  const out: { file: string; line: number; severity: string; message: string; source?: string }[] = [];
  for (const [uri, diags] of vscode.languages.getDiagnostics()) {
    if (file && uri.fsPath !== file) continue;
    for (const d of diags) out.push({ file: uri.fsPath, line: d.range.start.line + 1, severity: severity(d.severity), message: d.message, source: d.source });
  }
  return out;
}

function selection() {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return null;
  return { file: ed.document.uri.fsPath, text: ed.document.getText(ed.selection), line: ed.selection.start.line + 1 };
}

async function symbols(file: string | null) {
  if (!file) return [];
  try {
    const syms = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', vscode.Uri.file(file));
    const flat: { name: string; kind: string; line: number }[] = [];
    const walk = (list: vscode.DocumentSymbol[] = []) => { for (const s of list) { flat.push({ name: s.name, kind: vscode.SymbolKind[s.kind], line: s.range.start.line + 1 }); walk(s.children); } };
    walk(syms ?? []);
    return flat;
  } catch { return []; }
}

async function lmModels() {
  try {
    const models = await vscode.lm.selectChatModels();
    return models.map((m) => ({ id: m.id, vendor: m.vendor, family: m.family, name: m.name, maxInputTokens: m.maxInputTokens }));
  } catch { return []; }
}

async function lmInvoke(payload: { model?: string; messages?: { role: string; content: string }[] }) {
  try {
    const models = await vscode.lm.selectChatModels(payload.model ? { id: payload.model } : undefined);
    const model = models[0];
    if (!model) return { content: '', error: 'no language model available' };
    const msgs = (payload.messages ?? []).map((m) => vscode.LanguageModelChatMessage.User(m.content));
    const resp = await model.sendRequest(msgs, {}, new vscode.CancellationTokenSource().token);
    let out = '';
    for await (const chunk of resp.text) out += chunk;
    return { content: out };
  } catch (e: any) { return { content: '', error: String(e?.message ?? e) }; }
}

function mcp() {
  const out: { name: string; command: string; args?: string[] }[] = [];
  for (const f of vscode.workspace.workspaceFolders ?? []) {
    try {
      const p = path.join(f.uri.fsPath, '.vscode', 'mcp.json');
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const servers = j.servers ?? j.mcpServers ?? {};
      for (const [name, cfg] of Object.entries<any>(servers)) out.push({ name, command: cfg.command, args: cfg.args });
    } catch { /* skip malformed */ }
  }
  return out;
}

function readBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
}

export function activate(context: vscode.ExtensionContext) {
  const port = vscode.workspace.getConfiguration('clawBridge').get<number>('port', 39217);

  server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const send = (v: unknown, code = 200) => { res.statusCode = code; res.end(JSON.stringify(v)); };
    try {
      const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      const file = url.searchParams.get('file');
      switch (url.pathname) {
        case '/status': return send({ version: VERSION, folders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath) });
        case '/selection': return send(selection());
        case '/diagnostics': return send(diagnostics(file));
        case '/symbols': return send(await symbols(file));
        case '/lm/models': return send(await lmModels());
        case '/lm/invoke': return send(await lmInvoke(await readBody(req)));
        case '/mcp': return send(mcp());
        default: return send({ error: 'not found' }, 404);
      }
    } catch (e: any) { send({ error: String(e?.message ?? e) }, 500); }
  });

  server.on('error', (err) => vscode.window.showWarningMessage(`Claw Bridge: could not listen on ${port} (${err.message})`));
  server.listen(port, '127.0.0.1', () => console.log(`[claw-bridge] listening on 127.0.0.1:${port}`));

  context.subscriptions.push(
    { dispose: () => server?.close() },
    vscode.commands.registerCommand('clawBridge.status', () => vscode.window.showInformationMessage(`Claw Bridge v${VERSION} listening on 127.0.0.1:${port} · ${(vscode.workspace.workspaceFolders ?? []).length} folder(s)`)),
  );
}

export function deactivate() { server?.close(); }
