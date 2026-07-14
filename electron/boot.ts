/**
 * Real entry point (package.json `main`). It decides WHICH main process code to
 * run — the pristine build that shipped inside the asar, or a promoted bundle
 * that the self-upgrader built from the patched source tree — and then hands off.
 *
 * Nothing else in the app is allowed to load a promoted bundle: keeping the
 * decision in one file, before any other module is required, is what makes the
 * boot sentinel meaningful.
 */
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import Module from 'module';
import { decideBoot } from './selfUpgrade/promoted';

// A probe child (see selfUpgrade/probe.ts) gets its own userData so it can boot,
// open its own DB and render a window without touching the live app's state.
if (process.env.CLAW_USER_DATA) {
  try {
    fs.mkdirSync(process.env.CLAW_USER_DATA, { recursive: true });
    app.setPath('userData', process.env.CLAW_USER_DATA);
  } catch { /* fall back to the default userData */ }
}

/**
 * Promoted bundles live outside the asar, so their `require('electron')`,
 * `require('better-sqlite3')` etc. cannot resolve from their own directory.
 * Fall back to the installed app's node_modules for anything the bundle leaves
 * external. Only used as a *fallback*, so normal resolution still wins.
 */
function installResolverShim(appRoot: string): void {
  const M = Module as unknown as {
    _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
  };
  const original = M._resolveFilename;
  const paths = [path.join(appRoot, 'node_modules')];
  M._resolveFilename = function (request: string, parent: unknown, isMain: boolean, options?: any) {
    try {
      return original.call(this, request, parent, isMain, options);
    } catch (err) {
      try {
        return original.call(this, request, parent, isMain, { ...(options ?? {}), paths });
      } catch {
        throw err;
      }
    }
  };
}

function loadPristine(): void {
  require('./main.js');
}

function loadPromoted(root: string): void {
  process.env.CLAW_PROMOTED_ROOT = root;
  installResolverShim(app.getAppPath());
  require(path.join(root, 'main.js'));
}

// Promotion is a packaged-app concern: in dev the patched tree IS the repo and a
// normal rebuild picks it up. CLAW_PROMOTED_ENABLE=1 turns it on for tests.
const promotionEnabled = app.isPackaged || process.env.CLAW_PROMOTED_ENABLE === '1';

try {
  if (!promotionEnabled) {
    loadPristine();
  } else if (process.env.CLAW_BOOT_PROMOTED) {
    // The pipeline's boot probe: run a specific freshly-built bundle ONCE, before
    // it is ever recorded — with no sentinel and no `current.json` write, so a
    // candidate that fails to boot never becomes the app. This is an internal
    // channel (the env var is set only by our own pipeline, and the child runs
    // with its own throwaway userData, so the bundle it must load lives under the
    // *parent's* userData, not this process's). We therefore validate the shape
    // of the target — an existing directory with a bootable main.js — rather than
    // its location.
    const forced = path.resolve(process.env.CLAW_BOOT_PROMOTED);
    let bootable = false;
    try { bootable = fs.statSync(forced).isDirectory() && fs.existsSync(path.join(forced, 'main.js')); } catch { bootable = false; }
    if (bootable) {
      loadPromoted(forced);
    } else {
      console.error(`[boot] refusing CLAW_BOOT_PROMOTED=${forced}: not a directory with a bootable main.js`);
      loadPristine();
    }
  } else {
    const decision = decideBoot(app.getVersion());
    if (decision.refused) console.error(`[boot] ${decision.refused}`);
    if (decision.root) loadPromoted(decision.root);
    else loadPristine();
  }
} catch (e: any) {
  // A promoted bundle that throws on require would otherwise leave a windowless
  // process. Fall back immediately; the sentinel it left behind means the next
  // launch discards it for good.
  console.error('[boot] failed to load the promoted bundle, falling back to the pristine build:', e?.stack ?? e);
  delete process.env.CLAW_PROMOTED_ROOT;
  loadPristine();
}
