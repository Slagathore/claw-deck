/**
 * Stage a clean copy of the source tree into `staging-source/` so electron-builder
 * can ship it via `extraResources` (-> resources/source). The packaged app's
 * self-upgrade pipeline copies that into %APPDATA%/claw-deck/source so it has a
 * writable tree to read, snapshot, patch, and gate.
 *
 * We copy an explicit allowlist of top-level entries (never node_modules / build
 * output) to keep the payload small and deterministic.
 */
import { cpSync, rmSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'staging-source');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const ITEMS = [
  'src', 'electron', 'tests', 'scripts',
  'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts',
  'index.html', 'README.md', 'REQUIREMENTS.md', 'PLAN.md', 'SUMMARY.md'
];

let copied = 0;
for (const item of ITEMS) {
  const from = join(root, item);
  if (!existsSync(from)) continue;
  cpSync(from, join(out, item), {
    recursive: true,
    filter: (src) => !/[\\/]node_modules([\\/]|$)/.test(src) && !src.endsWith('.map')
  });
  copied++;
}

console.log(`staged ${copied} source entries -> ${out}`);
