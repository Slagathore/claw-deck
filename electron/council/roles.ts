// Fusion-methods §1.1 — Roster & role-eligibility config.
//
// Evidence-based (from the Crucible run that designed the SporeSpore evaluator):
// which advisor may play which role, and which it must NEVER play. The new methods
// (foundry / foundry-design / assay / prospect / relay / scatter) read THIS to
// auto-assign advisors to roles — they do not hard-code model names.
//
// Pure + dependency-free → fully unit-testable. Absent/unreachable advisors are
// simply skipped during assignment (§1.2 no-abort: log a coverage gap, proceed).

import { RosterAgent } from './agents';

// Fine-grained roles the methods assign (distinct from the coarse SessionAssignment roles).
export type FusionRole =
  | 'framer'            // writes the contract / rubric / golden tests (Claude)
  | 'diverger'          // parallel independent drafts
  | 'ideator'           // generative idea producer (prospect)
  | 'critic'            // adversarial reviewer (finds NEW flaws)
  | 'red-team'          // alias of critic for adversarial passes
  | 'wildcard-critic'   // high-variance critic (catches subtle, non-obvious misses)
  | 'repair-hand'       // applies finding→fix changes
  | 'builder'           // produces the actual code/build
  | 'consolidator'      // merges drafts into ONE canonical artifact (Claude)
  | 'consolidator-backup'
  | 'extractor'         // ingests a repo / builds the map (assay/prospect)
  | 'verify'            // re-checks checkable findings against real code (Codex)
  | 'judge'             // blind judge (generic)
  | 'judge-primary'     // primary blind judge (Codex)
  | 'judge-tiebreak'    // breaks contested judgements (Claude)
  | 'qa-wholedoc'       // reviews the FULL artifact — large-context models only
  | 'qa-focused'        // reviews chunked sections — smaller-window models
  | 'qa-code'           // code-correctness QA
  | 'final-qa';         // final sign-off QA

/** Canonical advisor key derived from a roster agent (model/id/transport heuristics). */
export type AdvisorKey =
  | 'kimi' | 'qwen35' | 'qwen-coder' | 'gemini-hot' | 'deepseek'
  | 'claude' | 'codex' | 'minimax' | 'nemotron' | 'unknown';

interface Eligibility {
  eligible: FusionRole[];
  notEligible: FusionRole[];
  context: 'large' | 'small';
  temp?: number;        // recommended sampling temperature (Gemini runs hot)
  maxCalls?: number;    // per-run trusted-call budget (Claude/Codex)
  optional?: boolean;   // never required — drop silently if unreachable
}

// The §1.1 table. `eligible` is the allowlist; `notEligible` are hard bans the
// rules call out explicitly (a ban always wins over the allowlist).
export const ADVISOR_ELIGIBILITY: Record<AdvisorKey, Eligibility> = {
  kimi: { eligible: ['critic', 'red-team', 'wildcard-critic', 'builder', 'consolidator-backup', 'qa-wholedoc', 'diverger', 'ideator', 'extractor', 'judge'], notEligible: [], context: 'large' },
  qwen35: { eligible: ['critic', 'red-team', 'builder', 'diverger', 'ideator', 'qa-focused', 'judge'], notEligible: [], context: 'large' },
  'qwen-coder': { eligible: ['builder', 'repair-hand', 'extractor', 'qa-wholedoc', 'diverger'], notEligible: ['critic', 'red-team', 'wildcard-critic'], context: 'large' },
  'gemini-hot': { eligible: ['diverger', 'wildcard-critic', 'ideator'], notEligible: ['builder', 'final-qa', 'consolidator', 'consolidator-backup', 'judge', 'judge-primary', 'judge-tiebreak', 'qa-wholedoc', 'qa-code'], context: 'small', temp: 1.1 },
  deepseek: { eligible: ['qa-focused', 'builder', 'critic', 'red-team', 'diverger'], notEligible: ['qa-wholedoc'], context: 'small' },
  claude: { eligible: ['framer', 'consolidator', 'consolidator-backup', 'judge-tiebreak', 'qa-code', 'final-qa', 'builder'], notEligible: [], context: 'large', maxCalls: 10 },
  codex: { eligible: ['verify', 'judge-primary', 'judge', 'qa-code', 'final-qa'], notEligible: [], context: 'large', maxCalls: 10 },
  minimax: { eligible: ['diverger', 'ideator'], notEligible: [], context: 'small', optional: true },
  nemotron: { eligible: ['diverger', 'ideator'], notEligible: [], context: 'small', optional: true },
  // Anything we don't recognize: usable only for low-trust generative roles.
  unknown: { eligible: ['diverger', 'ideator', 'builder', 'repair-hand', 'extractor'], notEligible: ['critic', 'red-team', 'wildcard-critic', 'judge', 'judge-primary', 'judge-tiebreak', 'consolidator', 'consolidator-backup', 'qa-wholedoc', 'qa-focused', 'qa-code', 'final-qa', 'framer', 'verify'], context: 'small' },
};

/** Map a roster agent to its canonical advisor key (by model name, then id, then transport). */
export function advisorKey(agent: RosterAgent): AdvisorKey {
  const hay = `${agent.model ?? ''} ${agent.id} ${agent.binary ?? ''}`.toLowerCase();
  if (agent.transport === 'claude-code' || /\bclaude\b/.test(hay)) return 'claude';
  if (agent.transport === 'codex' || /\bcodex\b/.test(hay)) return 'codex';
  if (/qwen3?-?coder|qwen.*coder/.test(hay)) return 'qwen-coder';
  if (/qwen3?\.?5|qwen3-5|qwen.*397b/.test(hay)) return 'qwen35';
  if (/kimi/.test(hay)) return 'kimi';
  if (/gemini/.test(hay)) return 'gemini-hot';
  if (/deepseek/.test(hay)) return 'deepseek';
  if (/minimax/.test(hay)) return 'minimax';
  if (/nemotron/.test(hay)) return 'nemotron';
  return 'unknown';
}

/** Is this agent eligible to play `role`? A `notEligible` ban always wins. */
export function eligibleFor(agent: RosterAgent, role: FusionRole): boolean {
  const e = ADVISOR_ELIGIBILITY[advisorKey(agent)];
  if (e.notEligible.includes(role)) return false;
  return e.eligible.includes(role);
}

/** Recommended temperature for an agent (Gemini runs hot at 1.1), else undefined. */
export function advisorTemp(agent: RosterAgent): number | undefined {
  return ADVISOR_ELIGIBILITY[advisorKey(agent)].temp;
}

export interface PickResult { picks: RosterAgent[]; warning?: string }

/**
 * Pick up to `n` advisors eligible for `role` from `available`.
 * - excludes ids in `opts.exclude` (rotation: a critic never reviews its own draft)
 * - prefers required advisors over optional (minimax/nemotron) ones
 * - returns a coverage `warning` when fewer than `n` eligible advisors exist
 *   (the caller logs the gap and proceeds — never aborts).
 */
export function pickAdvisors(
  available: RosterAgent[],
  role: FusionRole,
  n: number,
  opts: { exclude?: string[] } = {},
): PickResult {
  const exclude = new Set(opts.exclude ?? []);
  const eligible = available.filter((a) => !exclude.has(a.id) && eligibleFor(a, role));
  // required-first so optional advisors only fill remaining slots
  eligible.sort((a, b) => Number(isOptional(a)) - Number(isOptional(b)));
  const picks = eligible.slice(0, n);
  const warning = picks.length < n
    ? `coverage gap: needed ${n} '${role}' advisor(s), only ${picks.length} eligible/available`
    : undefined;
  return { picks, warning };
}

function isOptional(agent: RosterAgent): boolean {
  return ADVISOR_ELIGIBILITY[advisorKey(agent)].optional === true;
}

/**
 * Per-run trusted-call budget tracker (§1.1). Claude and Codex are capped at 10
 * calls each. `charge` returns 'over' when the cap is exceeded so the caller can
 * DOWNGRADE optional trusted steps (e.g. skip the Claude tie-break) — never error.
 */
export interface Budget {
  charge: (agent: RosterAgent) => 'ok' | 'over';
  canAfford: (agent: RosterAgent) => boolean;
  spent: () => { claude: number; codex: number };
}

export function makeBudget(maxClaude = 10, maxCodex = 10): Budget {
  let claude = 0;
  let codex = 0;
  const keyOf = (a: RosterAgent) => advisorKey(a);
  return {
    charge: (agent) => {
      const k = keyOf(agent);
      if (k === 'claude') { claude++; return claude > maxClaude ? 'over' : 'ok'; }
      if (k === 'codex') { codex++; return codex > maxCodex ? 'over' : 'ok'; }
      return 'ok'; // free (Ollama) advisors are uncapped
    },
    canAfford: (agent) => {
      const k = keyOf(agent);
      if (k === 'claude') return claude < maxClaude;
      if (k === 'codex') return codex < maxCodex;
      return true;
    },
    spent: () => ({ claude, codex }),
  };
}
