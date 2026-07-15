import { run, type RunResult } from '../selfUpgrade/exec';

/**
 * Authenticode verification for downloaded Windows installers.
 *
 * Claw Deck's installers are Authenticode-signed by Azure Trusted Signing
 * (CN=Charles Chambers). That signature — the one Windows itself validates when
 * you run the installer — IS the update's signature. The self-update path used
 * to ignore it and instead look for an Ed25519 sidecar signature that was never
 * provisioned, so every genuine update tripped an "install unsigned anyway"
 * prompt. The honest fix is to verify the Authenticode signature that is
 * actually there, against the pinned publisher, and trust a valid one.
 *
 * We require BOTH:
 *   - Get-AuthenticodeSignature Status == 'Valid' (chain + hash checked by the OS), and
 *   - the signing certificate's subject CN == exactly the pinned publisher CN.
 *
 * The CN match is done by parsing the X.500 subject and comparing the CN RDN
 * value exactly — never a substring test. A real signer subject is
 *   CN=Charles Chambers, O=Charles Chambers, L=Arlington, S=tx, C=US
 * so the name appears in O as well; an attacker cert whose O (or any other
 * field) merely contains the name, but whose CN differs, must NOT pass.
 */

/** The one publisher whose Authenticode signature we trust for auto-updates. */
export const TRUSTED_PUBLISHER_CN = 'Charles Chambers';

export interface RawSignature {
  /** Get-AuthenticodeSignature .Status as a string, e.g. 'Valid', 'NotSigned', 'HashMismatch'. */
  status: string;
  statusMessage?: string | null;
  /** SignerCertificate.Subject (X.500 DN), or null when unsigned. */
  subject: string | null;
}

export interface AuthenticodeResult {
  /** True only when the file is Valid AND signed by the pinned publisher CN. */
  ok: boolean;
  /** True when the file carries any Authenticode signature at all. */
  signed: boolean;
  status?: string;
  subject?: string | null;
  /** The parsed CN of the signer, if any. */
  cn?: string | null;
  /** Human-readable reason when ok is false. */
  reason?: string;
}

/**
 * Split an X.500 distinguished name into its RDN components on top-level commas,
 * respecting double-quoted values and backslash escapes.
 */
function splitDN(dn: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < dn.length; i++) {
    const ch = dn[i];
    if (ch === '\\') {
      // keep the escape and its escaped char together for later unescaping
      cur += ch + (dn[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '"') { inQuotes = !inQuotes; cur += ch; continue; }
    if (ch === ',' && !inQuotes) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Index of the first unescaped, unquoted '=' in an RDN component, or -1. */
function findUnescapedEquals(s: string): number {
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === '=' && !inQuotes) return i;
  }
  return -1;
}

/** Remove surrounding quotes and resolve backslash escapes in an RDN value. */
function unescapeRDNValue(raw: string): string {
  let s = raw.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1);
  }
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

/**
 * Extract the CN (Common Name) value from an X.500 subject string. Returns null
 * when there is no CN. Handles quoted values and escaped commas so that a value
 * like  CN=Chambers\, Charles  yields  "Chambers, Charles"  rather than
 * splitting into two RDNs.
 *
 * Defense-in-depth: a subject with MORE THAN ONE CN RDN is treated as untrusted
 * and returns null, so a synthetic subject like `CN=Charles Chambers, CN=Mallory`
 * (or the reverse) can never be trimmed down to the pinned name.
 */
export function parseCertificateCN(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const cns: string[] = [];
  for (const rdn of splitDN(subject)) {
    const eq = findUnescapedEquals(rdn);
    if (eq < 0) continue;
    const type = rdn.slice(0, eq).trim().toUpperCase();
    if (type !== 'CN') continue;
    cns.push(unescapeRDNValue(rdn.slice(eq + 1)));
  }
  if (cns.length !== 1) return null;
  return cns[0];
}

/**
 * Pure decision: given a raw Get-AuthenticodeSignature result, is this file
 * trusted to run? This is the seam tests drive without a real signed file.
 */
export function evaluateAuthenticode(raw: RawSignature, expectedCN: string = TRUSTED_PUBLISHER_CN): AuthenticodeResult {
  const status = (raw.status ?? '').trim();
  const subject = raw.subject ?? null;
  const signed = !!subject && status !== 'NotSigned';

  if (status !== 'Valid') {
    return {
      ok: false,
      signed,
      status,
      subject,
      cn: parseCertificateCN(subject),
      reason: status === 'NotSigned' || !signed
        ? 'the file is not Authenticode-signed'
        : `Authenticode status is ${status || 'unknown'}${raw.statusMessage ? ` (${raw.statusMessage})` : ''}`
    };
  }

  const cn = parseCertificateCN(subject);
  if (cn !== expectedCN) {
    return {
      ok: false,
      signed: true,
      status,
      subject,
      cn,
      reason: `signed by CN=${cn ?? '(no CN)'}, but this update must be signed by CN=${expectedCN}`
    };
  }

  return { ok: true, signed: true, status, subject, cn };
}

export type SignatureRunner = (cmd: string, args: string[], opts?: any) => Promise<RunResult>;

export interface VerifyOptions {
  expectedCN?: string;
  /** Injected for tests; defaults to the real child-process runner. */
  runner?: SignatureRunner;
  /** Override the platform check; defaults to process.platform. */
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  /** Override the PowerShell executable (defaults to powershell.exe). */
  powershell?: string;
}

/**
 * Verify the Authenticode signature of a file on disk (Windows only).
 *
 * The file path is passed to PowerShell base64-encoded and decoded inside the
 * script, so no part of the path can break out of a quoted string or be
 * interpreted as PowerShell syntax — even though our quarantine filenames are
 * derived from a (allowlisted-host) download URL.
 *
 * On non-Windows this returns ok:false with an honest "only available on
 * Windows" reason; callers keep their existing behavior there.
 */
export async function verifyAuthenticode(file: string, opts: VerifyOptions = {}): Promise<AuthenticodeResult> {
  const expectedCN = opts.expectedCN ?? TRUSTED_PUBLISHER_CN;
  const platform = opts.platform ?? process.platform;
  if (platform !== 'win32') {
    return { ok: false, signed: false, reason: `Authenticode verification is only available on Windows (this is ${platform})` };
  }

  const runner = opts.runner ?? run;
  const powershell = opts.powershell ?? 'powershell.exe';
  const b64 = Buffer.from(file, 'utf16le').toString('base64');
  const script = [
    "$ErrorActionPreference='Stop';",
    `$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${b64}'));`,
    '$s=Get-AuthenticodeSignature -LiteralPath $p;',
    '$subj= if ($s.SignerCertificate) { $s.SignerCertificate.Subject } else { $null };',
    '[pscustomobject]@{ status=[string]$s.Status; statusMessage=[string]$s.StatusMessage; subject=$subj } | ConvertTo-Json -Compress'
  ].join(' ');

  const r = await runner(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { timeoutMs: opts.timeoutMs ?? 20000 });
  if (!r.ok) {
    const detail = (r.stderr || r.stdout || '').trim().slice(0, 300);
    return { ok: false, signed: false, reason: `could not run Get-AuthenticodeSignature: ${detail || `exit ${r.code}`}` };
  }

  let parsed: RawSignature;
  try {
    const json = JSON.parse(r.stdout.trim());
    parsed = {
      status: String(json.status ?? ''),
      statusMessage: json.statusMessage != null ? String(json.statusMessage) : null,
      subject: json.subject != null ? String(json.subject) : null
    };
  } catch {
    return { ok: false, signed: false, reason: `could not parse signature output: ${r.stdout.trim().slice(0, 200)}` };
  }

  return evaluateAuthenticode(parsed, expectedCN);
}
