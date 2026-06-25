import * as fs from 'fs';
import * as path from 'path';

function pathCandidates(binary: string): string[] {
  if (process.platform !== 'win32') return [binary];
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean);
  if (path.extname(binary)) return [binary];
  return [binary, ...exts.map((ext) => `${binary}${ext.toLowerCase()}`), ...exts.map((ext) => `${binary}${ext.toUpperCase()}`)];
}

function isPathLike(binary: string): boolean {
  return /[\\/]/.test(binary) || /^[A-Za-z]:/.test(binary);
}

function existingFile(p: string): string | undefined {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? p : undefined;
  } catch {
    return undefined;
  }
}

function newest(files: string[]): string | undefined {
  let best: { file: string; mtime: number } | undefined;
  for (const file of files) {
    try {
      const mtime = fs.statSync(file).mtimeMs;
      if (!best || mtime > best.mtime) best = { file, mtime };
    } catch {
      // ignore vanished candidate
    }
  }
  return best?.file;
}

function collectCodexExtensionBins(): string[] {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return [];
  const roots = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.antigravity-ide', 'extensions'),
  ];
  const out: string[] = [];
  for (const root of roots) {
    try {
      for (const ext of fs.readdirSync(root)) {
        if (!/^openai\.chatgpt-/i.test(ext)) continue;
        const exe = path.join(root, ext, 'bin', process.platform === 'win32' ? 'windows-x86_64' : process.platform === 'darwin' ? 'macos' : 'linux-x86_64', process.platform === 'win32' ? 'codex.exe' : 'codex');
        if (existingFile(exe)) out.push(exe);
      }
    } catch {
      // extension root not present
    }
  }
  return out;
}

function extraCandidates(binary: string): string[] {
  const lower = binary.toLowerCase().replace(/\.(exe|cmd|bat|com)$/i, '');
  const appData = process.env.APPDATA || '';
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const extras: string[] = [];
  if (appData) for (const name of pathCandidates(binary)) extras.push(path.join(appData, 'npm', name));
  if (lower === 'codex') {
    extras.push(...collectCodexExtensionBins());
    if (home) {
      extras.push(path.join(home, '.codex', '.sandbox-bin', process.platform === 'win32' ? 'codex.exe' : 'codex'));
      extras.push(path.join(home, '.codex', 'plugins', '.plugin-appserver', process.platform === 'win32' ? 'codex.exe' : 'codex'));
    }
  }
  return extras;
}

export function resolveCliBinary(binary: string): string {
  const requested = (binary || '').trim();
  if (!requested) return requested;
  if (isPathLike(requested)) return existingFile(requested) ?? requested;

  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const name of pathCandidates(requested)) {
      const found = existingFile(path.join(dir, name));
      if (found) return found;
    }
  }
  return newest(extraCandidates(requested)) ?? requested;
}

