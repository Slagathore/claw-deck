import * as path from 'path';
import * as fs from 'fs';
import * as fsp from 'fs/promises';

/**
 * Builds a patched source tree into a *promoted bundle* — a directory under
 * userData that the app can actually boot (see promoted.ts / boot.ts).
 *
 * The packaged app has no npm, no vite and no node_modules in its writable
 * source tree, so the build has to be self-contained: we ship esbuild (a single
 * native binary + its JS wrapper, asar-unpacked) and bundle:
 *
 *   electron/main.ts    -> <out>/main.js       (cjs, node)
 *   electron/preload.ts -> <out>/preload.js    (cjs, node)
 *   src/main.tsx        -> <out>/renderer/assets/index.js (+ index.css)
 *   index.html          -> <out>/renderer/index.html      (rewritten script tags)
 *
 * Runtime deps that cannot be bundled (electron itself, native modules) stay
 * external and are resolved out of the installed app's own node_modules by the
 * resolver shim in boot.ts.
 *
 * This build is also the strongest check in the packaged gate: a patch with a
 * syntax error, a bad import, or a reference to a file it forgot to create
 * cannot bundle, so it can never be promoted.
 */

export const EXTERNALS = ['electron', 'better-sqlite3', 'node-pty', 'sqlite-vec', 'typescript', 'esbuild'];

export interface BuildResult {
  ok: boolean;
  outDir: string;
  errors: string[];
  warnings: string[];
  durationMs: number;
}

/** asar-aware: files unpacked by electron-builder live in app.asar.unpacked. */
export function unpackedPath(p: string): string {
  return p.split(`app.asar${path.sep}`).join(`app.asar.unpacked${path.sep}`);
}

/**
 * node_modules the bundler should resolve imports from. The writable source tree
 * has none of its own, so we point esbuild at the ones shipped with the app.
 */
export function bundlerNodePaths(appRoot: string, sourceRoot: string): string[] {
  const out = [path.join(sourceRoot, 'node_modules'), unpackedPath(path.join(appRoot, 'node_modules'))];
  return out.filter((p, i) => out.indexOf(p) === i);
}

/**
 * esbuild ships its compiler as a native executable. Inside an asar it cannot be
 * spawned, so point it at the unpacked copy before the module is loaded.
 */
export function resolveEsbuildBinary(appRoot: string): string | null {
  const exe = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  const pkg = `@esbuild/${process.platform}-${process.arch}`;
  const candidates = [
    unpackedPath(path.join(appRoot, 'node_modules', pkg, exe)),
    path.join(appRoot, 'node_modules', pkg, exe)
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return null;
}

function loadEsbuild(appRoot: string): any {
  const bin = resolveEsbuildBinary(appRoot);
  if (bin && !process.env.ESBUILD_BINARY_PATH) process.env.ESBUILD_BINARY_PATH = bin;
  return require('esbuild');
}

/** Rewrite the dev index.html (which points at /src/main.tsx) to load the bundle. */
export function rewriteIndexHtml(html: string): string {
  let out = html.replace(/<script[^>]*type="module"[^>]*><\/script>\s*/gi, '');
  const tags = '    <link rel="stylesheet" href="./assets/index.css" />\n    <script src="./assets/index.js"></script>\n';
  if (out.includes('</body>')) out = out.replace('</body>', `${tags}  </body>`);
  else out += tags;
  return out;
}

export async function buildPromotedBundle(opts: {
  sourceRoot: string;
  outDir: string;
  /** app.getAppPath() — where the shipped node_modules live. */
  appRoot: string;
  appVersion: string;
  appName?: string;
}): Promise<BuildResult> {
  const started = Date.now();
  const errors: string[] = [];
  const warnings: string[] = [];
  const { sourceRoot, outDir, appRoot } = opts;

  const fail = (msg: string): BuildResult => ({
    ok: false, outDir, errors: [...errors, msg], warnings, durationMs: Date.now() - started
  });

  let esbuild: any;
  try {
    esbuild = loadEsbuild(appRoot);
  } catch (e: any) {
    return fail(`esbuild is not available in this build: ${e.message}`);
  }

  await fsp.mkdir(path.join(outDir, 'renderer', 'assets'), { recursive: true });
  const nodePaths = bundlerNodePaths(appRoot, sourceRoot);

  const common = {
    bundle: true,
    write: true,
    logLevel: 'silent' as const,
    absWorkingDir: sourceRoot,
    nodePaths,
    sourcemap: false as const
  };

  const collect = (r: any) => {
    for (const w of r?.warnings ?? []) warnings.push(`${w.location?.file ?? '?'}: ${w.text}`);
  };

  try {
    const main = await esbuild.build({
      ...common,
      entryPoints: [path.join(sourceRoot, 'electron', 'main.ts')],
      outfile: path.join(outDir, 'main.js'),
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: EXTERNALS
    });
    collect(main);

    const preload = await esbuild.build({
      ...common,
      entryPoints: [path.join(sourceRoot, 'electron', 'preload.ts')],
      outfile: path.join(outDir, 'preload.js'),
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      external: EXTERNALS
    });
    collect(preload);

    const renderer = await esbuild.build({
      ...common,
      entryPoints: [path.join(sourceRoot, 'src', 'main.tsx')],
      outfile: path.join(outDir, 'renderer', 'assets', 'index.js'),
      platform: 'browser',
      format: 'iife',
      target: 'chrome120',
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' },
      loader: {
        '.png': 'dataurl', '.jpg': 'dataurl', '.svg': 'dataurl', '.gif': 'dataurl',
        '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.eot': 'dataurl'
      }
    });
    collect(renderer);
  } catch (e: any) {
    for (const err of e?.errors ?? []) {
      errors.push(`${err.location?.file ?? '?'}:${err.location?.line ?? 0} ${err.text}`);
    }
    if (!errors.length) errors.push(e?.message ?? String(e));
    return { ok: false, outDir, errors, warnings, durationMs: Date.now() - started };
  }

  // esbuild only emits the css file when something imported css; make sure the
  // stylesheet link in index.html never dangles.
  const cssFile = path.join(outDir, 'renderer', 'assets', 'index.css');
  if (!fs.existsSync(cssFile)) await fsp.writeFile(cssFile, '');

  try {
    const srcHtml = await fsp.readFile(path.join(sourceRoot, 'index.html'), 'utf8');
    await fsp.writeFile(path.join(outDir, 'renderer', 'index.html'), rewriteIndexHtml(srcHtml));
  } catch (e: any) {
    return fail(`could not produce renderer/index.html: ${e.message}`);
  }

  // A package.json with `main` makes the bundle directly launchable
  // (`electron <bundleDir>`), which is how the boot probe exercises it.
  await fsp.writeFile(
    path.join(outDir, 'package.json'),
    JSON.stringify({ name: opts.appName ?? 'claw-deck', version: opts.appVersion, main: 'main.js' }, null, 2)
  );

  return { ok: true, outDir, errors, warnings, durationMs: Date.now() - started };
}
