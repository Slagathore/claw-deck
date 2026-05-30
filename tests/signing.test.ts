import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import { verifyEd25519, summarizeVtResponse, loadEd25519PublicKey } from '../electron/ipc/signing';

function makeKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const rawPub = publicKey.export({ type: 'spki', format: 'der' }).slice(12); // drop SPKI prefix
  return { privateKey, pem, hex: rawPub.toString('hex') };
}

function sign(privateKey: crypto.KeyObject, data: Buffer): string {
  return crypto.sign(null, data, privateKey).toString('base64');
}

describe('signing.verifyEd25519', () => {
  it('verifies a valid signature with a PEM key', () => {
    const { privateKey, pem } = makeKeypair();
    const data = Buffer.from('hello world');
    const sig = sign(privateKey, data);
    const r = verifyEd25519(data, sig, [{ name: 'k1', format: 'pem', key: pem }]);
    expect(r.ok).toBe(true);
    expect(r.matchedKey).toBe('k1');
  });

  it('verifies a valid signature with a hex (raw 32-byte) key', () => {
    const { privateKey, hex } = makeKeypair();
    const data = Buffer.from('payload');
    const sig = sign(privateKey, data);
    const r = verifyEd25519(data, sig, [{ name: 'hexkey', format: 'hex', key: hex }]);
    expect(r.ok).toBe(true);
  });

  it('rejects when signature does not match any key', () => {
    const a = makeKeypair();
    const b = makeKeypair();
    const data = Buffer.from('x');
    const sig = sign(a.privateKey, data);
    const r = verifyEd25519(data, sig, [{ name: 'b', format: 'pem', key: b.pem }]);
    expect(r.ok).toBe(false);
  });

  it('rejects when signature is wrong length', () => {
    const { pem } = makeKeypair();
    const r = verifyEd25519(Buffer.from('x'), Buffer.from('too short').toString('base64'),
      [{ name: 'k', format: 'pem', key: pem }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/64-byte/);
  });

  it('rejects when no keys configured', () => {
    const zeroSig = Buffer.alloc(64).toString('base64');
    const r = verifyEd25519(Buffer.from('x'), zeroSig, []);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no signing keys/);
  });

  it('rejects empty signature', () => {
    const { pem } = makeKeypair();
    const r = verifyEd25519(Buffer.from('x'), '', [{ name: 'k', format: 'pem', key: pem }]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no signature/);
  });

  it('loadEd25519PublicKey: hex must be 64 chars', () => {
    expect(() => loadEd25519PublicKey({ name: 'bad', format: 'hex', key: 'deadbeef' }))
      .toThrow(/64 hex chars/);
  });
});

describe('signing.summarizeVtResponse', () => {
  it('flags ok when 0 malicious / 0 suspicious', () => {
    const r = summarizeVtResponse({ data: { attributes: { last_analysis_stats: { malicious: 0, suspicious: 0, harmless: 60, undetected: 10 } } } });
    expect(r.ok).toBe(true);
    expect(r.malicious).toBe(0);
    expect(r.harmless).toBe(60);
  });
  it('flags not-ok when malicious > 0', () => {
    const r = summarizeVtResponse({ data: { attributes: { last_analysis_stats: { malicious: 3, suspicious: 1, harmless: 50, undetected: 10 } } } });
    expect(r.ok).toBe(false);
    expect(r.malicious).toBe(3);
    expect(r.suspicious).toBe(1);
  });
  it('handles missing stats gracefully', () => {
    const r = summarizeVtResponse({});
    expect(r.malicious).toBe(0);
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/VT:/);
  });
});
