// Protocols & phase primitives (BOOTSTRAP §4.3). Pure data + parsing helpers.
import { GateVerdict } from './agents';

export type PhaseKind = 'independent' | 'debate' | 'gauntlet' | 'steelman' | 'select' | 'synthesize' | 'gate' | 'relay' | 'vote' | 'propose' | 'execute';

export interface Phase {
  kind: PhaseKind;
  agents?: string[];          // role refs (@panelists, …) or literal ids
  rounds?: number;
  stopOn?: 'cap' | 'converge';
  by?: string;                // single role ref for synthesize/gate/propose/execute
  onMinor?: 'apply-forward';
  onMajor?: 'bounce';
  maxTurns?: number;
  method?: 'majority' | 'judge-pick';
  editPolicy?: 'dry-run' | 'review-each' | 'auto-checkpoint';
  blind?: boolean;            // gate: judge sees only (task + patch), not the consensus
  label?: string;
}

export interface Protocol { id: string; name: string; phases: Phase[] }

// COUNCIL = independent → debate(converge) → synthesize → gate(qa) → relay(qa,judge) → gate(judge) → execute(judge)
const COUNCIL: Protocol = {
  id: 'COUNCIL', name: 'Full Council',
  phases: [
    { kind: 'independent', agents: ['@panelists'], label: 'Independent takes' },
    { kind: 'debate', agents: ['@panelists'], rounds: 3, stopOn: 'converge', label: 'Debate' },
    { kind: 'synthesize', by: '@scribe', label: 'Synthesize' },
    { kind: 'gate', by: '@qa-gate', onMinor: 'apply-forward', onMajor: 'bounce', label: 'QA gate' },
    { kind: 'relay', agents: ['@qa-gate', '@judge'], maxTurns: 4, label: 'QA ⇄ Judge' },
    { kind: 'gate', by: '@judge', onMinor: 'apply-forward', onMajor: 'bounce', label: 'Judge gate' },
    { kind: 'execute', by: '@judge', editPolicy: 'review-each', label: 'Execute' },
  ],
};

// PCRSR = Propose → Critique → Revise → Synthesize → Ratify
const PCRSR: Protocol = {
  id: 'PCRSR', name: 'Propose·Critique·Revise·Synthesize·Ratify',
  phases: [
    { kind: 'independent', agents: ['@panelists'], label: 'Propose' },
    { kind: 'debate', agents: ['@panelists'], rounds: 1, stopOn: 'cap', label: 'Critique' },
    { kind: 'debate', agents: ['@panelists'], rounds: 1, stopOn: 'cap', label: 'Revise' },
    { kind: 'synthesize', by: '@scribe', label: 'Synthesize' },
    { kind: 'gate', by: '@judge', onMinor: 'apply-forward', onMajor: 'bounce', label: 'Ratify' },
  ],
};

// GCRJ = Generate → Cross-critique → Rebuttal → Judge
const GCRJ: Protocol = {
  id: 'GCRJ', name: 'Generate·Cross-critique·Rebuttal·Judge',
  phases: [
    { kind: 'independent', agents: ['@panelists'], label: 'Generate' },
    { kind: 'debate', agents: ['@panelists'], rounds: 1, stopOn: 'cap', label: 'Cross-critique' },
    { kind: 'debate', agents: ['@panelists'], rounds: 1, stopOn: 'cap', label: 'Rebuttal' },
    { kind: 'gate', by: '@judge', onMinor: 'apply-forward', onMajor: 'bounce', label: 'Judge' },
  ],
};

// REDTEAM = adversarial audit (no edits): propose → adversarial gauntlet (each
// agent must find a NEW flaw or say NO_FURTHER_ISSUES) → harden → blind judge.
const REDTEAM: Protocol = {
  id: 'REDTEAM', name: 'Red Team (adversarial audit)',
  phases: [
    { kind: 'independent', agents: ['@panelists'], label: 'Proposal' },
    { kind: 'gauntlet', agents: ['@panelists'], maxTurns: 8, label: 'Adversarial gauntlet' },
    { kind: 'synthesize', by: '@scribe', label: 'Harden' },
    { kind: 'gate', by: '@judge', blind: true, onMinor: 'apply-forward', onMajor: 'bounce', label: 'Blind sign-off' },
  ],
};

// GAUNTLET = adversarial + executes. Generate → adversarial gauntlet → harden →
// BLIND judge (sees only task + patch, never the consensus) → execute.
const GAUNTLET: Protocol = {
  id: 'GAUNTLET', name: 'Adversarial Gauntlet',
  phases: [
    { kind: 'independent', agents: ['@panelists'], label: 'Generate' },
    { kind: 'gauntlet', agents: ['@panelists'], maxTurns: 8, label: 'Adversarial gauntlet' },
    { kind: 'synthesize', by: '@scribe', label: 'Harden' },
    { kind: 'gate', by: '@judge', blind: true, onMinor: 'apply-forward', onMajor: 'bounce', label: 'Blind judge' },
    { kind: 'execute', by: '@judge', editPolicy: 'review-each', label: 'Execute' },
  ],
};

// PAIR = relay(qa,judge) → execute(judge)  (quick fix; skips the swarm)
const PAIR: Protocol = {
  id: 'PAIR', name: 'Pair (quick fix)',
  phases: [
    { kind: 'relay', agents: ['@qa-gate', '@judge'], maxTurns: 4, label: 'QA ⇄ Judge' },
    { kind: 'execute', by: '@judge', editPolicy: 'review-each', label: 'Execute' },
  ],
};

// SOLO = one actor, no panel. The judge proposes a fix and executes it directly.
const SOLO: Protocol = {
  id: 'SOLO', name: 'Solo (judge only)',
  phases: [
    { kind: 'relay', agents: ['@judge'], maxTurns: 1, label: 'Judge proposes' },
    { kind: 'execute', by: '@judge', editPolicy: 'review-each', label: 'Execute' },
  ],
};

// TOURNAMENT = divergent. Panelists each propose independently; the judge PICKS
// the single strongest candidate (no merging/averaging) → execute.
const TOURNAMENT: Protocol = {
  id: 'TOURNAMENT', name: 'Tournament (pick-best)',
  phases: [
    { kind: 'independent', agents: ['@panelists'], label: 'Proposals' },
    { kind: 'select', by: '@judge', label: 'Judge picks winner' },
    { kind: 'execute', by: '@judge', editPolicy: 'review-each', label: 'Execute' },
  ],
};

// STEELMAN = constructive-adversarial. Each round, agents first STRENGTHEN the
// current proposal (add what's missing, fix weak spots) THEN flag any remaining
// flaw → synthesize → blind judge → execute.
const STEELMAN: Protocol = {
  id: 'STEELMAN', name: 'Steelman (strengthen-then-attack)',
  phases: [
    { kind: 'independent', agents: ['@panelists'], label: 'Draft' },
    { kind: 'steelman', agents: ['@panelists'], rounds: 2, label: 'Steelman rounds' },
    { kind: 'synthesize', by: '@scribe', label: 'Synthesize' },
    { kind: 'gate', by: '@judge', blind: true, onMinor: 'apply-forward', onMajor: 'bounce', label: 'Blind judge' },
    { kind: 'execute', by: '@judge', editPolicy: 'review-each', label: 'Execute' },
  ],
};

// DEVIL = one fixed adversary (the QA agent) attacks the whole panel's proposal
// across turns; blind judge ratifies → execute.
const DEVIL: Protocol = {
  id: 'DEVIL', name: "Devil's Advocate (one adversary)",
  phases: [
    { kind: 'independent', agents: ['@panelists'], label: 'Proposal' },
    { kind: 'gauntlet', agents: ['@qa-gate'], maxTurns: 5, label: 'Devil attacks' },
    { kind: 'synthesize', by: '@scribe', label: 'Harden' },
    { kind: 'gate', by: '@judge', blind: true, onMinor: 'apply-forward', onMajor: 'bounce', label: 'Blind judge' },
    { kind: 'execute', by: '@judge', editPolicy: 'review-each', label: 'Execute' },
  ],
};

// CRUCIBLE = generate → 3 rounds of (steelman ⇄ red-team) → synthesize → harden
// → QA → blind judge → build. The full forge: strengthen and attack, repeatedly.
const CRUCIBLE: Protocol = {
  id: 'CRUCIBLE', name: 'Crucible (steelman ⇄ red-team ×3)',
  phases: [
    { kind: 'independent', agents: ['@panelists'], label: 'Generate' },
    { kind: 'steelman', agents: ['@panelists'], rounds: 1, label: 'Steelman 1' },
    { kind: 'gauntlet', agents: ['@panelists'], maxTurns: 4, label: 'Red-team 1' },
    { kind: 'steelman', agents: ['@panelists'], rounds: 1, label: 'Steelman 2' },
    { kind: 'gauntlet', agents: ['@panelists'], maxTurns: 4, label: 'Red-team 2' },
    { kind: 'steelman', agents: ['@panelists'], rounds: 1, label: 'Steelman 3' },
    { kind: 'gauntlet', agents: ['@panelists'], maxTurns: 4, label: 'Red-team 3' },
    { kind: 'synthesize', by: '@scribe', label: 'Synthesize' },
    { kind: 'steelman', agents: ['@panelists'], rounds: 1, label: 'Harden' },
    { kind: 'gate', by: '@qa-gate', onMinor: 'apply-forward', onMajor: 'bounce', label: 'QA gate' },
    { kind: 'gate', by: '@judge', blind: true, onMinor: 'apply-forward', onMajor: 'bounce', label: 'Blind judge' },
    { kind: 'execute', by: '@judge', editPolicy: 'review-each', label: 'Build' },
  ],
};

export const PROTOCOLS: Record<string, Protocol> = { COUNCIL, CRUCIBLE, GAUNTLET, DEVIL, STEELMAN, TOURNAMENT, REDTEAM, PCRSR, GCRJ, PAIR, SOLO };

/** Parse a gate agent's free-text reply into a structured verdict. Default safe = 'major'. */
export function parseGateVerdict(text: string): GateVerdict {
  const t = (text || '').toLowerCase();
  let verdict: GateVerdict['verdict'] = 'major';
  if (/\bveto\b/.test(t)) verdict = 'veto';
  else if (/\bmajor\b/.test(t)) verdict = 'major';
  else if (/\bminor\b/.test(t)) verdict = 'minor';
  else if (/\bapprove(d)?\b|\blgtm\b|\bship it\b/.test(t)) verdict = 'approve';
  const patch = extractDiff(text);
  return { verdict, notes: (text || '').trim().slice(0, 4000), patch };
}

/** Blind-judge reply → verdict. Only an explicit "LGTM"/clean reply approves; a
 *  judge shown only (task + patch) and asked "what's still wrong" that finds
 *  issues yields `major` (the patch is not ratified on consensus it never saw). */
export function parseBlindVerdict(text: string): GateVerdict {
  const t = (text || '').trim();
  const lower = t.toLowerCase();
  const clean = /\blgtm\b|no (?:further |remaining )?issues|nothing (?:is )?(?:still |left )?(?:wrong|broken|missing)|looks correct|ship it/.test(lower);
  if (clean && t.length < 400) return { verdict: 'approve', notes: t.slice(0, 4000) };
  return { verdict: 'major', notes: t.slice(0, 4000), patch: extractDiff(t) };
}

/** A cheap convergence check on a debate-round checker's output. */
export function isConverged(text: string): boolean {
  const t = (text || '').toLowerCase();
  return /\bconverged\b|\bwe agree\b|\bconsensus\b|\bno (?:further|new) (?:points|disagreement)\b/.test(t);
}

/** Pull a fenced diff/patch out of a model reply, if present. */
export function extractDiff(text: string): string | undefined {
  const fence = text.match(/```(?:diff|patch)?\n([\s\S]*?)```/);
  if (fence && /^(diff --git|--- |\+\+\+ |@@ )/m.test(fence[1])) return fence[1];
  if (/^diff --git /m.test(text)) return text.slice(text.indexOf('diff --git'));
  return undefined;
}
