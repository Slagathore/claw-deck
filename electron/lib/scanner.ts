/**
 * Pure security scanner — no Electron imports, safe to unit-test.
 *
 * Walks a directory, scans every .js / .ts / .mjs / .cjs / .json file for
 * known-risky patterns, and returns a structured findings report.
 *
 * Patterns are deliberately broad (high false-positive rate) — this is a
 * triage tool, not a verdict. The UI presents findings ranked by severity
 * so the user can review snippets and decide.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'high' | 'critical';

export interface Finding {
  rule: string;
  severity: FindingSeverity;
  file: string;       // path relative to scanned root
  line: number;       // 1-indexed
  snippet: string;    // ≤ 200 chars
  reason: string;
}

export interface AuditReport {
  ok: boolean;
  error?: string;
  scannedAt: number;
  root: string;
  fileCount: number;
  bytesScanned: number;
  durationMs: number;
  findings: Finding[];
  summary: Record<FindingSeverity, number>;
  manifest?: {
    name?: string;
    version?: string;
    license?: string;
    dependencies?: Record<string, string>;
    scripts?: Record<string, string>;
    hash: string;     // sha256 of package.json
  };
}

interface Rule {
  id: string;
  severity: FindingSeverity;
  pattern: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  // --- Code execution ---
  { id: 'eval-call',         severity: 'critical', pattern: /\beval\s*\(/,                                reason: 'Dynamic code evaluation via eval(); a common malware vector.' },
  { id: 'new-function',      severity: 'high',     pattern: /\bnew\s+Function\s*\(/,                     reason: 'new Function() compiles arbitrary code at runtime.' },
  { id: 'vm-runincontext',   severity: 'high',     pattern: /\bvm\s*\.\s*run(?:InThisContext|InNewContext|InContext)\s*\(/, reason: 'Node vm module runs arbitrary code in a sandbox that is trivially escapable.' },
  { id: 'require-eval',      severity: 'high',     pattern: /require\s*\(\s*['"`]child_process['"`]/,    reason: 'Imports child_process for shell execution.' },

  // --- Shell / process spawning ---
  { id: 'child-spawn',       severity: 'medium',   pattern: /\b(spawn|exec|execSync|execFile|fork)\s*\(/, reason: 'Spawns a child process; verify the command and arguments.' },
  { id: 'shell-true',        severity: 'high',     pattern: /shell\s*:\s*true/,                          reason: 'spawn/exec with shell:true enables shell injection.' },
  { id: 'powershell-encoded',severity: 'critical', pattern: /-EncodedCommand|powershell\s+-[eE]\b/,      reason: 'Encoded PowerShell command — classic Living-off-the-Land technique.' },
  { id: 'cmd-curl-bash',     severity: 'critical', pattern: /curl\s+[^\s]+\s*\|\s*(bash|sh|powershell|iex)/i, reason: 'Pipes a downloaded payload directly into a shell.' },
  { id: 'iex-download',      severity: 'critical', pattern: /(Invoke-Expression|iex)\s*\(?\s*(?:\(?\s*New-Object\s+Net\.WebClient\)?\s*\.DownloadString|Invoke-WebRequest)/i, reason: 'PowerShell download-and-execute pattern.' },

  // --- Network ---
  { id: 'fetch-call',        severity: 'low',      pattern: /\bfetch\s*\(\s*['"`]https?:/,               reason: 'Outbound HTTP request.' },
  { id: 'http-request',      severity: 'low',      pattern: /\b(?:http|https|net|dgram|dns)\s*\.\s*(?:request|createConnection|connect|get)\s*\(/, reason: 'Raw network socket / HTTP request.' },
  { id: 'websocket',         severity: 'low',      pattern: /\bnew\s+WebSocket\s*\(/,                    reason: 'Opens a WebSocket — bidirectional comms.' },
  { id: 'suspicious-ip',     severity: 'medium',   pattern: /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/,     reason: 'Hard-coded IP address; check if it is a known-bad host.' },
  { id: 'tor-onion',         severity: 'high',     pattern: /[a-z2-7]{16,56}\.onion/i,                   reason: 'References a Tor hidden service — high-suspicion exfil channel.' },
  { id: 'discord-webhook',   severity: 'high',     pattern: /discord(?:app)?\.com\/api\/webhooks\//,    reason: 'Discord webhook — common token-grabber exfil endpoint.' },
  { id: 'telegram-bot',      severity: 'medium',   pattern: /api\.telegram\.org\/bot/,                   reason: 'Telegram bot API — sometimes used for exfiltration.' },
  { id: 'pastebin',          severity: 'medium',   pattern: /pastebin\.com\/raw\//,                      reason: 'Fetches code from pastebin.' },

  // --- Secret / credential access ---
  { id: 'env-secret',        severity: 'medium',   pattern: /process\.env\.[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|API|CREDENTIAL)/, reason: 'Reads what looks like a credential from environment.' },
  { id: 'aws-cred-read',     severity: 'high',     pattern: /\.aws\/credentials|AWS_SECRET_ACCESS_KEY/,  reason: 'Reads AWS credentials.' },
  { id: 'ssh-key-read',      severity: 'high',     pattern: /\.ssh\/(?:id_rsa|id_ed25519|known_hosts)/,  reason: 'Reads SSH private keys / known_hosts.' },
  { id: 'keychain',          severity: 'high',     pattern: /security\s+find-(?:internet|generic)-password|keytar|wincred/i, reason: 'Accesses OS credential store.' },
  { id: 'browser-cookie',    severity: 'critical', pattern: /(?:Cookies|Login Data|Local State)['"`]\)|Network\\Cookies/, reason: 'Browser cookie / login database access — common info-stealer pattern.' },
  { id: 'wallet-files',      severity: 'critical', pattern: /wallet\.dat|exodus\.wallet|metamask|electrum/i, reason: 'References crypto wallet files.' },

  // --- Obfuscation / packing ---
  { id: 'base64-eval',       severity: 'critical', pattern: /(?:Buffer\.from|atob)\s*\(\s*['"`][A-Za-z0-9+/=]{40,}['"`]\s*(?:,\s*['"`]base64['"`]\s*)?\)[\s\S]{0,40}(?:eval|Function)/, reason: 'Decodes base64 then executes it — textbook obfuscated payload.' },
  { id: 'hex-escape-spam',   severity: 'medium',   pattern: /(?:\\x[0-9a-fA-F]{2}){20,}/,                reason: 'Long sequence of hex escapes — likely obfuscation.' },
  { id: 'unicode-escape-spam',severity: 'medium',  pattern: /(?:\\u[0-9a-fA-F]{4}){20,}/,               reason: 'Long sequence of unicode escapes — likely obfuscation.' },
  { id: 'minified-blob',     severity: 'low',      pattern: /^.{2000,}$/m,                               reason: 'Very long single line — possible minified or packed code (skim findings).' },

  // --- Filesystem ---
  { id: 'fs-unlink',         severity: 'medium',   pattern: /\bfs(?:Promises)?\s*\.\s*(?:unlink|rm|rmdir|rmSync|unlinkSync)\s*\(/, reason: 'Deletes files from disk.' },
  { id: 'rm-rf',             severity: 'high',     pattern: /\brm\s+-rf?\s+[^\s'"`)]+/,                  reason: 'rm -rf detected; verify the target path.' },
  { id: 'fs-chmod-777',      severity: 'medium',   pattern: /chmod\s*\(\s*[^,]+,\s*(?:0o?777|511)/,      reason: 'Grants world-writable permissions.' },

  // --- Misc red flags ---
  { id: 'preinstall-script', severity: 'high',     pattern: /"(?:preinstall|install|postinstall)"\s*:\s*"[^"]*(?:curl|wget|node\s+-e|powershell)/i, reason: 'Lifecycle script downloads or executes code at install time.' },
  { id: 'crypto-miner',      severity: 'critical', pattern: /(?:coinhive|cryptonight|stratum\+tcp|xmr-stak|cpuminer|monero|mining-pool|webminer)/i, reason: 'References crypto miner.' },
  { id: 'os-environ-dump',   severity: 'medium',   pattern: /JSON\.stringify\s*\(\s*process\.env\s*\)/, reason: 'Serializes the entire environment block (often for exfiltration).' }
];

const TEXT_EXTS = new Set(['.js', '.cjs', '.mjs', '.jsx', '.ts', '.tsx', '.json', '.sh', '.ps1', '.bat', '.cmd', '.py', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.cache', '.turbo', '.next']);
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB per file
const MAX_LINE_LEN_FOR_SNIPPET = 200;

async function walk(root: string, acc: string[]): Promise<void> {
  if (acc.length >= MAX_FILES) return;
  let entries: import('fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (acc.length >= MAX_FILES) return;
    const full = path.join(root, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      await walk(full, acc);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (TEXT_EXTS.has(ext) || e.name.toLowerCase() === 'package.json') acc.push(full);
    }
  }
}

function scanText(rel: string, text: string): Finding[] {
  const out: Finding[] = [];
  const lines = text.split(/\r?\n/);
  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i++) {
      if (rule.pattern.test(lines[i])) {
        out.push({
          rule: rule.id,
          severity: rule.severity,
          file: rel,
          line: i + 1,
          snippet: lines[i].trim().slice(0, MAX_LINE_LEN_FOR_SNIPPET),
          reason: rule.reason
        });
      }
    }
  }
  return out;
}

export async function auditDirectory(root: string): Promise<AuditReport> {
  const startedAt = Date.now();
  const report: AuditReport = {
    ok: true,
    scannedAt: startedAt,
    root,
    fileCount: 0,
    bytesScanned: 0,
    durationMs: 0,
    findings: [],
    summary: { info: 0, low: 0, medium: 0, high: 0, critical: 0 }
  };

  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      return { ...report, ok: false, error: 'not a directory', durationMs: Date.now() - startedAt };
    }
  } catch (e: any) {
    return { ...report, ok: false, error: `cannot access: ${e.message}`, durationMs: Date.now() - startedAt };
  }

  const files: string[] = [];
  await walk(root, files);
  report.fileCount = files.length;

  // Parse package.json if present.
  const pkgPath = path.join(root, 'package.json');
  try {
    const buf = await fs.readFile(pkgPath);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const pkg = JSON.parse(buf.toString('utf8'));
    report.manifest = {
      name: pkg.name,
      version: pkg.version,
      license: pkg.license,
      dependencies: pkg.dependencies,
      scripts: pkg.scripts,
      hash: `sha256:${hash}`
    };
  } catch { /* no package.json or invalid JSON */ }

  for (const f of files) {
    let buf: Buffer;
    try {
      const st = await fs.stat(f);
      if (st.size > MAX_FILE_BYTES) {
        report.findings.push({
          rule: 'large-file',
          severity: 'info',
          file: path.relative(root, f),
          line: 0,
          snippet: `${(st.size / 1024).toFixed(0)} KB — skipped (over 2MB limit)`,
          reason: 'File too large to scan in full; review manually.'
        });
        continue;
      }
      buf = await fs.readFile(f);
    } catch {
      continue;
    }
    report.bytesScanned += buf.length;
    const text = buf.toString('utf8');
    const rel = path.relative(root, f);
    const found = scanText(rel, text);
    report.findings.push(...found);
  }

  for (const f of report.findings) report.summary[f.severity]++;

  // Sort findings: critical > high > medium > low > info, then by file then line.
  const order: Record<FindingSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  report.findings.sort((a, b) =>
    order[a.severity] - order[b.severity] ||
    a.file.localeCompare(b.file) ||
    a.line - b.line
  );

  report.durationMs = Date.now() - startedAt;
  return report;
}
