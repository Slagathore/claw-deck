// claw-bridge — a minimal VS Code extension that publishes editor-only signals
// to Claw Deck over a localhost HTTP server (BOOTSTRAP §3 Phase 6). It exposes
// what only the editor knows — live diagnostics, the active selection, document
// symbols, vscode.lm chat models (+ an invoke proxy), and configured MCP servers
// — so Claw Deck's Atlas/Council can read them when VS Code is open, and fall
// back to filesystem+git when it isn't. Read-only/observational; no edits.

import * as vscode from 'vscode';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const VERSION = '0.2.0';
let server: http.Server | undefined;

// Discovery registry so Claw Deck can find THIS window's bridge among several open
// VS Code windows (each binds its own port and advertises its folders).
const REG_DIR = path.join(os.homedir(), '.claw-bridge');
let regFile: string | undefined;
let heartbeat: NodeJS.Timeout | undefined;

function folderPaths(): string[] { return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath); }

function writeRegistry(port: number) {
  try {
    fs.mkdirSync(REG_DIR, { recursive: true });
    regFile = path.join(REG_DIR, `${port}.json`);
    fs.writeFileSync(regFile, JSON.stringify({ port, pid: process.pid, version: VERSION, folders: folderPaths(), updated: Date.now() }));
  } catch { /* registry is best-effort */ }
}
function clearRegistry() { try { if (regFile && fs.existsSync(regFile)) fs.unlinkSync(regFile); } catch { /* ignore */ } }

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

const requestHandler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
  res.setHeader('Content-Type', 'application/json');
  const send = (v: unknown, code = 200) => { res.statusCode = code; res.end(JSON.stringify(v)); };
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');   // base is cosmetic — only the path/query matter
    const file = url.searchParams.get('file');
    switch (url.pathname) {
      case '/status': return send({ version: VERSION, folders: folderPaths() });
      case '/selection': return send(selection());
      case '/diagnostics': return send(diagnostics(file));
      case '/symbols': return send(await symbols(file));
      case '/lm/models': return send(await lmModels());
      case '/lm/invoke': return send(await lmInvoke(await readBody(req)));
      case '/mcp': return send(mcp());
      default: return send({ error: 'not found' }, 404);
    }
  } catch (e: any) { send({ error: String(e?.message ?? e) }, 500); }
};

export function activate(context: vscode.ExtensionContext) {
  const startPort = vscode.workspace.getConfiguration('clawBridge').get<number>('port', 39217);
  let boundPort = startPort;

  // Bind the first free port from startPort upward, so multiple VS Code windows each get
  // their own bridge instead of the second one failing on EADDRINUSE.
  const listen = (port: number, attemptsLeft: number) => {
    server = http.createServer(requestHandler);
    server.on('error', (err: any) => {
      try { server?.close(); } catch { /* ignore */ }
      if (err?.code === 'EADDRINUSE' && attemptsLeft > 0) { listen(port + 1, attemptsLeft - 1); }
      else vscode.window.showWarningMessage(`Claw Bridge: could not listen (${err.message})`);
    });
    server.listen(port, '127.0.0.1', () => {
      boundPort = port;
      writeRegistry(port);
      heartbeat = setInterval(() => writeRegistry(port), 30_000);   // liveness + folder refresh
      console.log(`[claw-bridge] listening on 127.0.0.1:${port}`);
    });
  };
  listen(startPort, 20);

  context.subscriptions.push(
    { dispose: () => { if (heartbeat) clearInterval(heartbeat); clearRegistry(); try { server?.close(); } catch { /* ignore */ } } },
    vscode.workspace.onDidChangeWorkspaceFolders(() => writeRegistry(boundPort)),   // keep advertised folders fresh
    vscode.commands.registerCommand('clawBridge.status', () => vscode.window.showInformationMessage(`Claw Bridge v${VERSION} on 127.0.0.1:${boundPort} · ${folderPaths().length} folder(s)`)),
  );
}

export function deactivate() { if (heartbeat) clearInterval(heartbeat); clearRegistry(); server?.close(); }
