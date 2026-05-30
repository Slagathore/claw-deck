import { PatchSet } from './patcher';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface RiskAssessment {
  level: RiskLevel;
  score: number;
  reasons: string[];
}

/** Files that change the trust boundary or core process behavior. */
const HIGH_RISK_FILES = [
  /^electron\/main\.ts$/i,
  /^electron\/preload\.ts$/i,
  /^electron\/ipc\/security\./i,
  /^electron\/ipc\/runner\./i,
  /^electron\/selfUpgrade\//i,
  /^electron\/lib\/scanner\./i,
  /^package\.json$/i,
  /^package-lock\.json$/i
];

const MEDIUM_RISK_FILES = [
  /^electron\//i,
  /^src\/lib\//i,
  /^vite\.config\./i,
  /^tsconfig/i
];

/** Patterns that, when newly *introduced* by the patch, raise the risk floor. */
const DANGEROUS_INTRODUCTIONS: { rx: RegExp; weight: number; reason: string }[] = [
  { rx: /\beval\s*\(/, weight: 6, reason: 'introduces eval()' },
  { rx: /\bnew\s+Function\s*\(/, weight: 6, reason: 'introduces new Function()' },
  { rx: /child_process/i, weight: 4, reason: 'imports child_process' },
  { rx: /\bspawn\s*\(|\bexec\s*\(|\bexecFile\s*\(|\bexecSync\s*\(/, weight: 3, reason: 'process spawn' },
  { rx: /\bfs\.(unlink|rm|rmdir|chmod|chown)\b/, weight: 3, reason: 'destructive fs op' },
  { rx: /shell\s*:\s*true/i, weight: 4, reason: 'shell:true' },
  { rx: /process\.env\b[\s\S]{0,40}(TOKEN|KEY|SECRET|PASSWORD|API|CREDENTIAL)/i, weight: 3, reason: 'reads secret-ish env var' },
  { rx: /https?:\/\/(?!localhost|127\.0\.0\.1)/i, weight: 2, reason: 'outbound network URL' },
  { rx: /Buffer\.from\([^)]+,\s*['"]base64['"]/i, weight: 3, reason: 'base64 decode (possible obfuscation)' },
  { rx: /\.onion\b/i, weight: 5, reason: 'tor onion reference' }
];

export function assessRisk(patch: PatchSet): RiskAssessment {
  let score = 0;
  const reasons: string[] = [];
  for (const f of patch.files) {
    const p = f.path.replace(/\\/g, '/');
    if (HIGH_RISK_FILES.some(rx => rx.test(p))) {
      score += 6; reasons.push(`touches critical file: ${p}`);
    } else if (MEDIUM_RISK_FILES.some(rx => rx.test(p))) {
      score += 1; reasons.push(`touches: ${p}`);
    }
    if (f.mode === 'delete') {
      score += 2; reasons.push(`deletes ${p}`);
    }
    if (f.contents) {
      for (const d of DANGEROUS_INTRODUCTIONS) {
        if (d.rx.test(f.contents)) {
          score += d.weight;
          reasons.push(`${d.reason} in ${p}`);
        }
      }
    }
  }
  let level: RiskLevel = 'low';
  if (score >= 6) level = 'high';
  else if (score >= 3) level = 'medium';
  return { level, score, reasons };
}
