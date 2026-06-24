// Actor fallback detection (Phase 2 fallback chain). Pure + unit-tested:
// a designated actor's quota/auth failure (401/403/429 or "out of credits / rate
// limit" stderr) drops the run to the next actor; the final fallback is
// apply-mode using the best available *-coder:cloud.

export function isQuotaError(code: number | null, stderr: string): boolean {
  const s = (stderr || '').toLowerCase();
  if (/\b(401|403|429)\b/.test(s)) return true;
  return /out of credits|rate.?limit|\bquota\b|insufficient (?:credit|quota|balance)|too many requests|overloaded|payment required|billing/.test(s);
}

/** Given an ordered actor list and the index that just failed, the next to try. */
export function nextActor<T>(actors: T[], failedIndex: number): T | null {
  return failedIndex + 1 < actors.length ? actors[failedIndex + 1] : null;
}
