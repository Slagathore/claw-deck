import * as crypto from 'crypto';

/**
 * Pure signature/VT helpers. Kept out of `security.ts` so they can be tested
 * without dragging in the Electron `app` import chain.
 */

export interface KeySpec {
  /** human label */
  name: string;
  /** key format: 'pem' (PEM-wrapped SPKI public key) or 'hex' (raw 32-byte ed25519 public key, hex) */
  format: 'pem' | 'hex';
  /** key material as a string */
  key: string;
}

export interface VerifyResult {
  ok: boolean;
  matchedKey?: string;
  reason?: string;
}

/**
 * Verify an Ed25519 detached signature (base64) over the given bytes against
 * any of the provided public keys. Succeeds on first match.
 *
 * Hex keys are interpreted as raw 32-byte Ed25519 public keys and wrapped into
 * the standard DER SPKI prefix (12 bytes) so node's KeyObject can consume them.
 */
export function verifyEd25519(
  data: Buffer,
  signatureBase64: string,
  keys: KeySpec[]
): VerifyResult {
  if (!signatureBase64) return { ok: false, reason: 'no signature provided' };
  let sig: Buffer;
  try { sig = Buffer.from(signatureBase64, 'base64'); }
  catch { return { ok: false, reason: 'signature is not valid base64' }; }
  if (sig.length !== 64) return { ok: false, reason: `expected 64-byte ed25519 signature, got ${sig.length}` };
  if (keys.length === 0) return { ok: false, reason: 'no signing keys configured' };

  for (const spec of keys) {
    try {
      const pub = loadEd25519PublicKey(spec);
      const ok = crypto.verify(null, data, pub, sig);
      if (ok) return { ok: true, matchedKey: spec.name };
    } catch {
      // ignore — try next key
    }
  }
  return { ok: false, reason: 'no configured key produced a valid signature' };
}

export function loadEd25519PublicKey(spec: KeySpec): crypto.KeyObject {
  if (spec.format === 'pem') {
    return crypto.createPublicKey({ key: spec.key, format: 'pem' });
  }
  // raw 32-byte ed25519 public key in hex → wrap as DER SPKI
  const hex = spec.key.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error('hex key must be exactly 64 hex chars (32 bytes)');
  }
  const raw = Buffer.from(hex, 'hex');
  // SPKI prefix for Ed25519 (RFC 8410): 302a300506032b6570032100
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const der = Buffer.concat([prefix, raw]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/** VirusTotal v3 hash-lookup parsing — separated for testing. */
export interface VtSummary {
  ok: boolean;
  malicious: number;
  suspicious: number;
  harmless: number;
  undetected: number;
  detail: string;
}

export function summarizeVtResponse(raw: any): VtSummary {
  const stats = raw?.data?.attributes?.last_analysis_stats ?? {};
  const malicious = Number(stats.malicious ?? 0);
  const suspicious = Number(stats.suspicious ?? 0);
  const harmless = Number(stats.harmless ?? 0);
  const undetected = Number(stats.undetected ?? 0);
  return {
    ok: malicious === 0 && suspicious === 0,
    malicious, suspicious, harmless, undetected,
    detail: `VT: ${malicious} malicious, ${suspicious} suspicious, ${harmless} harmless, ${undetected} undetected`
  };
}
