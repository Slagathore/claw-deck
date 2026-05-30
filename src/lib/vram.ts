/**
 * Pure helpers for the VRAM meter that lives in the chat header.
 */

export interface RunningModel {
  name: string;
  size?: number;
  sizeVram?: number;
  expiresAt?: number;
}

export function formatBytes(b?: number): string {
  if (!b || b <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

export function totalVram(models: RunningModel[]): number {
  return models.reduce((s, m) => s + (m.sizeVram ?? 0), 0);
}

export function summarizeRunning(models: RunningModel[]): string {
  if (models.length === 0) return 'no models loaded';
  const total = totalVram(models);
  const names = models.map(m => m.name).join(', ');
  return `${models.length} loaded · ${formatBytes(total)} VRAM · ${names}`;
}
