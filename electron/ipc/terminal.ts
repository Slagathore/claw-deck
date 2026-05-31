import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface ShellPreset {
  id: string;
  label: string;
  binary: string;
  args: string[];
  /** soft hint — UI marks unavailable presets greyed out */
  available: boolean;
}

function firstExisting(...candidates: string[]): string | null {
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch { /* ignore */ }
  }
  return null;
}

function detectShells(): ShellPreset[] {
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const systemRoot = process.env['SystemRoot'] || 'C:\\Windows';
  const localAppData = process.env['LOCALAPPDATA'] || '';

  const pwsh = firstExisting(
    path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    path.join(programFilesX86, 'PowerShell', '7', 'pwsh.exe')
  );
  const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const cmd = path.join(systemRoot, 'System32', 'cmd.exe');
  const gitBash = firstExisting(
    path.join(programFiles, 'Git', 'bin', 'bash.exe'),
    path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe')
  );
  const wsl = path.join(systemRoot, 'System32', 'wsl.exe');
  const gh = firstExisting(
    path.join(programFiles, 'GitHub CLI', 'gh.exe'),
    path.join(localAppData, 'Programs', 'GitHub CLI', 'gh.exe')
  );

  const presets: ShellPreset[] = [
    // Interactive args (the Console runs shells in a real PTY). `-Command -`
    // (script-from-stdin) is intentionally omitted so PowerShell presents its
    // normal interactive REPL on the terminal.
    pwsh
      ? { id: 'pwsh', label: 'PowerShell 7 (pwsh)', binary: pwsh, args: ['-NoLogo'], available: true }
      : { id: 'pwsh', label: 'PowerShell 7 (pwsh) — not installed', binary: 'pwsh.exe', args: [], available: false },
    { id: 'powershell', label: 'Windows PowerShell', binary: powershell, args: ['-NoLogo'], available: fs.existsSync(powershell) },
    { id: 'cmd', label: 'Command Prompt (cmd)', binary: cmd, args: ['/Q'], available: fs.existsSync(cmd) },
    gitBash
      ? { id: 'gitbash', label: 'Git Bash', binary: gitBash, args: ['--login', '-i'], available: true }
      : { id: 'gitbash', label: 'Git Bash — not installed', binary: 'bash.exe', args: [], available: false },
    { id: 'wsl', label: 'WSL (default distro)', binary: wsl, args: [], available: fs.existsSync(wsl) },
    gh
      ? { id: 'gh', label: 'GitHub CLI (gh)', binary: gh, args: [], available: true }
      : { id: 'gh', label: 'GitHub CLI (gh) — not installed', binary: 'gh.exe', args: [], available: false }
  ];
  return presets;
}

export function registerTerminalHandlers() {
  ipcMain.handle('terminal:shells', () => detectShells());

  /**
   * Launch a shell elevated. This intentionally does NOT stream output back —
   * Windows UAC requires a new, separate console for the elevated process,
   * and piping stdio across the integrity boundary is not allowed without a
   * helper service. We spawn an unattached elevated window instead.
   */
  ipcMain.handle('terminal:launchElevated', (_e, opts: { binary: string; args?: string[]; cwd?: string }) => {
    const args = opts.args ?? [];
    const psArgs = [
      '-NoProfile',
      '-Command',
      `Start-Process -FilePath '${opts.binary.replace(/'/g, "''")}' -Verb RunAs ${args.length ? `-ArgumentList @(${args.map(a => `'${a.replace(/'/g, "''")}'`).join(',')})` : ''} ${opts.cwd ? `-WorkingDirectory '${opts.cwd.replace(/'/g, "''")}'` : ''}`.trim()
    ];
    try {
      const proc = spawn('powershell.exe', psArgs, { detached: true, stdio: 'ignore', windowsHide: true });
      proc.unref();
      return { ok: true, pid: proc.pid };
    } catch (e: any) {
      return { ok: false, reason: e.message };
    }
  });
}
