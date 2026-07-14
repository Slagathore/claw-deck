import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vm from 'vm';
import { rewriteIndexHtml, unpackedPath, EXTERNALS, buildPromotedBundle } from '../electron/selfUpgrade/build';

describe('rewriteIndexHtml', () => {
  it('drops the dev module script and links the built bundle + css', () => {
    const dev = `<!doctype html><html><body><div id="root"></div>\n<script type="module" src="/src/main.tsx"></script>\n</body></html>`;
    const out = rewriteIndexHtml(dev);
    expect(out).not.toMatch(/main\.tsx/);
    expect(out).toMatch(/<script src="\.\/assets\/index\.js"><\/script>/);
    expect(out).toMatch(/<link rel="stylesheet" href="\.\/assets\/index\.css" \/>/);
  });
});

describe('unpackedPath', () => {
  it('redirects an asar path to app.asar.unpacked', () => {
    const p = ['app', 'resources', 'app.asar', 'node_modules', 'esbuild'].join(path.sep);
    expect(unpackedPath(p)).toContain('app.asar.unpacked');
  });
  it('leaves a non-asar path untouched', () => {
    const p = path.join('C:', 'dev', 'node_modules', 'esbuild');
    expect(unpackedPath(p)).toBe(p);
  });
});

describe('EXTERNALS', () => {
  it('keeps electron and native modules out of the bundle', () => {
    for (const dep of ['electron', 'better-sqlite3', 'node-pty']) expect(EXTERNALS).toContain(dep);
  });
});

// The real proof that packaged self-upgrade can produce a RUNNABLE bundle: build
// the actual repo (which has node_modules, exactly like a "Prepare deps"-ed
// packaged install) and assert every artifact the app boots is present and the
// main-process bundle is valid JavaScript.
describe('buildPromotedBundle (integration, real tree)', () => {
  const out = path.join(os.tmpdir(), `clawdeck-build-it-${Date.now()}`);
  const repo = path.resolve(__dirname, '..');
  const hasDeps = fs.existsSync(path.join(repo, 'node_modules', 'react'));

  afterAll(() => fs.rmSync(out, { recursive: true, force: true }));

  (hasDeps ? it : it.skip)('bundles main/preload/renderer that the app can load', async () => {
    const r = await buildPromotedBundle({ sourceRoot: repo, outDir: out, appRoot: repo, appVersion: '1.0.2' });
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);

    for (const f of ['main.js', 'preload.js', 'renderer/index.html', 'renderer/assets/index.js', 'renderer/assets/index.css', 'package.json']) {
      expect(fs.existsSync(path.join(out, f)), `${f} should exist`).toBe(true);
    }
    // main.js is real, parseable JS (a syntax error in a patch could never get here).
    const mainSrc = fs.readFileSync(path.join(out, 'main.js'), 'utf8');
    expect(() => new vm.Script(mainSrc, { filename: 'main.js' })).not.toThrow();

    // The bundle package.json is directly launchable (electron <dir> semantics).
    const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
    expect(pkg.main).toBe('main.js');
    expect(pkg.version).toBe('1.0.2');

    // The rewritten html points at the bundle, not the dev entry.
    const html = fs.readFileSync(path.join(out, 'renderer', 'index.html'), 'utf8');
    expect(html).toContain('./assets/index.js');
    expect(html).not.toContain('main.tsx');
  }, 120000);

  (hasDeps ? it : it.skip)('fails (does not half-build) when a patched file has a syntax error', async () => {
    const broken = path.join(os.tmpdir(), `clawdeck-build-broken-${Date.now()}`);
    // Minimal tree with a deliberately broken electron/main.ts.
    fs.mkdirSync(path.join(broken, 'electron'), { recursive: true });
    fs.mkdirSync(path.join(broken, 'src'), { recursive: true });
    fs.writeFileSync(path.join(broken, 'electron', 'main.ts'), 'export const x = = 1;');
    fs.writeFileSync(path.join(broken, 'electron', 'preload.ts'), 'export const y = 1;');
    fs.writeFileSync(path.join(broken, 'src', 'main.tsx'), 'export const z = 1;');
    fs.writeFileSync(path.join(broken, 'index.html'), '<html><body></body></html>');
    const r = await buildPromotedBundle({ sourceRoot: broken, outDir: path.join(broken, 'out'), appRoot: repo, appVersion: '1.0.2' });
    fs.rmSync(broken, { recursive: true, force: true });
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThan(0);
  }, 60000);
});
