import { describe, it, expect, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  parseCertificateCN,
  evaluateAuthenticode,
  verifyAuthenticode,
  TRUSTED_PUBLISHER_CN,
  type RawSignature
} from '../electron/ipc/authenticode';

// A RunResult-shaped stub for the injected runner seam.
function runResult(over: Partial<{ ok: boolean; code: number | null; stdout: string; stderr: string }> = {}) {
  return { ok: true, code: 0, stdout: '', stderr: '', durationMs: 1, ...over };
}
// The JSON shape our PowerShell script emits.
function sigJson(status: string, subject: string | null, statusMessage = '') {
  return JSON.stringify({ status, statusMessage, subject });
}

describe('parseCertificateCN', () => {
  it('extracts CN from a normal subject where O also contains the name', () => {
    // The real signer subject — the name appears in O too, so a substring match would be wrong.
    expect(parseCertificateCN('CN=Charles Chambers, O=Charles Chambers, L=Arlington, S=tx, C=US'))
      .toBe('Charles Chambers');
  });
  it('extracts CN even when it is not the first RDN', () => {
    expect(parseCertificateCN('O=Charles Chambers, C=US, CN=Someone Else')).toBe('Someone Else');
  });
  it('handles a quoted CN value', () => {
    expect(parseCertificateCN('CN="Charles Chambers", O=Acme')).toBe('Charles Chambers');
  });
  it('handles an escaped comma inside the CN (does not split the RDN)', () => {
    expect(parseCertificateCN('CN=Chambers\\, Charles, O=Acme, C=US')).toBe('Chambers, Charles');
  });
  it('returns null when there is no CN', () => {
    expect(parseCertificateCN('O=Charles Chambers, C=US')).toBeNull();
    expect(parseCertificateCN('')).toBeNull();
    expect(parseCertificateCN(null)).toBeNull();
  });
  it('rejects a subject with more than one CN RDN (multi-CN is untrusted)', () => {
    // A synthetic subject must not be trimmable down to the pinned name.
    expect(parseCertificateCN('CN=Charles Chambers, CN=Mallory, O=Acme')).toBeNull();
    expect(parseCertificateCN('CN=Mallory, CN=Charles Chambers')).toBeNull();
  });
});

describe('evaluateAuthenticode rejects multi-CN subjects', () => {
  it('refuses a Valid signature whose subject carries two CN RDNs', () => {
    const r = evaluateAuthenticode({ status: 'Valid', subject: 'CN=Charles Chambers, CN=Mallory' });
    expect(r.ok).toBe(false);
    expect(r.cn).toBeNull();
  });
});

describe('evaluateAuthenticode', () => {
  const valid = (subject: string): RawSignature => ({ status: 'Valid', subject, statusMessage: 'Signature verified.' });

  it('trusts a Valid signature from the pinned publisher CN', () => {
    const r = evaluateAuthenticode(valid('CN=Charles Chambers, O=Charles Chambers, C=US'));
    expect(r.ok).toBe(true);
    expect(r.signed).toBe(true);
    expect(r.cn).toBe('Charles Chambers');
  });

  it('refuses a Valid signature whose CN is a different name', () => {
    const r = evaluateAuthenticode(valid('CN=Mallory, O=Evil, C=US'));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/must be signed by CN=Charles Chambers/);
  });

  it('refuses when the name is only in O and the CN differs (no substring pass)', () => {
    const r = evaluateAuthenticode(valid('CN=Definitely Not Charles, O=Charles Chambers, C=US'));
    expect(r.ok).toBe(false);
    expect(r.cn).toBe('Definitely Not Charles');
  });

  it('refuses a CN that merely contains the trusted name as a substring', () => {
    const r = evaluateAuthenticode(valid('CN=Charles Chambers Imposter, C=US'));
    expect(r.ok).toBe(false);
  });

  it('refuses an unsigned file', () => {
    const r = evaluateAuthenticode({ status: 'NotSigned', subject: null });
    expect(r.ok).toBe(false);
    expect(r.signed).toBe(false);
    expect(r.reason).toMatch(/not Authenticode-signed/);
  });

  it('refuses a signature that is present but not Valid (e.g. HashMismatch)', () => {
    const r = evaluateAuthenticode({ status: 'HashMismatch', subject: 'CN=Charles Chambers', statusMessage: 'file was tampered' });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/HashMismatch/);
  });
});

describe('verifyAuthenticode (mocked signature-check seam)', () => {
  const winOpts = (runner: any) => ({ platform: 'win32' as NodeJS.Platform, runner });

  it('verifies a validly-signed-by-Charles-Chambers installer (no unsigned prompt)', async () => {
    const runner = vi.fn((_cmd: string, _args: string[], _opts?: any) =>
      Promise.resolve(runResult({ stdout: sigJson('Valid', 'CN=Charles Chambers, O=Charles Chambers, C=US', 'Signature verified.') })));
    const r = await verifyAuthenticode('C:/q/Claw-Deck-Setup.exe', winOpts(runner));
    expect(r.ok).toBe(true);
    expect(r.cn).toBe('Charles Chambers');
    // Path is passed base64-encoded, never interpolated raw into the script.
    const script = runner.mock.calls[0]![1].join(' ');
    expect(script).not.toContain('Claw-Deck-Setup.exe');
    expect(script).toContain('FromBase64String');
  });

  it('refuses an unsigned installer', async () => {
    const runner = vi.fn(async () => runResult({ stdout: sigJson('NotSigned', null) }));
    const r = await verifyAuthenticode('C:/q/x.exe', winOpts(runner));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/not Authenticode-signed/);
  });

  it('refuses a Valid signature with the wrong CN', async () => {
    const runner = vi.fn(async () => runResult({ stdout: sigJson('Valid', 'CN=Mallory, O=Charles Chambers, C=US') }));
    const r = await verifyAuthenticode('C:/q/x.exe', winOpts(runner));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/must be signed by CN=Charles Chambers/);
  });

  it('reports an honest reason when PowerShell fails to run', async () => {
    const runner = vi.fn(async () => runResult({ ok: false, code: 1, stderr: 'powershell not found' }));
    const r = await verifyAuthenticode('C:/q/x.exe', winOpts(runner));
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/could not run Get-AuthenticodeSignature/);
  });

  it('is unavailable (honest) on non-Windows platforms without touching the runner', async () => {
    const runner = vi.fn();
    const r = await verifyAuthenticode('/q/x.exe', { platform: 'linux', runner });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/only available on Windows/);
    expect(runner).not.toHaveBeenCalled();
  });
});

// Real end-to-end check against Cole's actual signed installer, if one is present
// in a dist folder. Skips cleanly when absent (CI, or before a build) and off
// Windows. This is the one test that exercises real Get-AuthenticodeSignature.
describe('verifyAuthenticode (real signed installer, if present)', () => {
  function findSignedInstaller(): string | null {
    const roots = ['dist', 'dist-installer', 'dist-installer2', 'release'];
    const repo = path.resolve(__dirname, '..');
    const found: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        // Only descend into release output, never the *-unpacked staging dirs,
        // which hold the RAW unsigned electron exe that would fail this check.
        if (e.isDirectory()) {
          if (!/unpacked/i.test(e.name)) walk(full, depth + 1);
        }
        // Only the signed NSIS installer is named "...Setup...". The portable
        // and the raw electron exe are not what this test validates.
        else if (/setup.*\.exe$/i.test(e.name)) found.push(full);
      }
    };
    for (const r of roots) walk(path.join(repo, r), 0);
    return found[0] ?? null;
  }

  const installer = process.platform === 'win32' ? findSignedInstaller() : null;
  const maybe = installer ? it : it.skip;

  maybe(`recognizes the real installer as signed by ${TRUSTED_PUBLISHER_CN}`, async () => {
    const r = await verifyAuthenticode(installer!);
    expect(r.status).toBe('Valid');
    expect(r.cn).toBe(TRUSTED_PUBLISHER_CN);
    expect(r.ok).toBe(true);
  }, 30000);
});
