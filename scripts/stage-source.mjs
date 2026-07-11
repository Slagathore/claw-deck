/**
 * Stage a clean copy of the source tree into `staging-source/` so electron-builder
 * can ship it via `extraResources` (-> resources/source). The packaged app's
 * self-upgrade pipeline copies that into %APPDATA%/claw-deck/source so it has a
 * writable tree to read, snapshot, patch, and gate.
 *
 * WHY THE DUPLICATION: Claw Deck can modify its own source code at runtime via the
 * self-upgrade pipeline (electron/selfUpgrade/). The packaged app's ASAR archive is
 * read-only, so the app needs a writable copy of the source tree to operate on.
 * This staged copy is the seed for that writable tree — on first launch,
 * `ensureSourceTree()` in `electron/selfUpgrade/paths.ts` copies `resources/source/`
 * into `%APPDATA%/claw-deck/source/`. From there the pipeline can:
 *   - snapshot it (git commit or directory copy) before a patch,
 *   - apply patches (patcher.ts),
 *   - run the gate (typecheck + tests + delta scan),
 *   - probe (launch a second Electron instance to verify boot/DB/tray/Ollama),
 *   - and roll back (restoreSnapshot) if any stage fails.
 * Without this staged source, the self-upgrader would have nothing to work on in
 * packaged mode — it would be an app that can't fix itself.
 *
 * We copy an explicit allowlist of top-level entries (never node_modules / build
 * output) to keep the payload small and deterministic.
 */
import { cpSync, rmSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "staging-source");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const ITEMS = [
  "src",
  "electron",
  "tests",
  "scripts",
  "package.json",
  "package-lock.json",
  // .npmrc carries legacy-peer-deps — without it, npm installs in the staged
  // tree (the packaged self-upgrader's gate) fail ERESOLVE on fresh resolves.
  ".npmrc",
  "tsconfig.json",
  "vite.config.ts",
  "index.html",
  "README.md",
];

let copied = 0;
for (const item of ITEMS) {
  const from = join(root, item);
  if (!existsSync(from)) continue;
  cpSync(from, join(out, item), {
    recursive: true,
    filter: (src) =>
      !/[\\/]node_modules([\\/]|$)/.test(src) && !src.endsWith(".map"),
  });
  copied++;
}

console.log(`staged ${copied} source entries -> ${out}`);
