// Council agent registry + role resolution (BOOTSTRAP §4.2 / §4.5).
// The global roster lives in settings.fusionRoster; each workspace tab's
// SessionAssignment references roster ids by position. Role refs like
// '@panelists' / '@judge' / '@qa-gate' / '@scribe' resolve at runtime from the
// assignment. Pure + dependency-free → fully unit-testable.

export type Transport =
  | 'ollama-cloud' | 'ollama-local' | 'openai-compat'   // advisors (text)
  | 'claude-code'  | 'codex'        | 'openclaw'         // actors (agentic CLIs)
  | 'vscode-lm';                                          // via claw-bridge (Phase 6)

export type Role = 'panelist' | 'critic' | 'scribe' | 'qa-gate' | 'judge' | 'executor';
export type CostTier = 'cheap' | 'mid' | 'expensive';

export interface RosterAgent {
  id: string;
  displayName: string;
  transport: Transport;
  model?: string;
  binary?: string;
  capabilities: { canEdit: boolean; canRunTools: boolean; costTier: CostTier };
}

export interface SessionAssignment {
  panelists: string[];
  judge: string;
  qaGate: string;
  scribe?: string;
}

export interface GateVerdict { verdict: 'approve' | 'minor' | 'major' | 'veto'; notes: string; patch?: string }

export interface Msg { role: 'system' | 'user' | 'assistant'; content: string }

export function agentById(roster: RosterAgent[], id: string): RosterAgent | undefined {
  return roster.find((a) => a.id === id);
}

/** Resolve a role ref ('@panelists' | '@judge' | '@qa-gate' | '@scribe') or a literal id to agent ids. */
export function resolveRoleRef(ref: string, a: SessionAssignment): string[] {
  switch (ref) {
    case '@panelists': return [...a.panelists];
    case '@judge': return a.judge ? [a.judge] : [];
    case '@qa-gate': return a.qaGate ? [a.qaGate] : [];
    case '@scribe': return a.scribe ? [a.scribe] : (a.judge ? [a.judge] : []); // fall back to judge as scribe
    default: return [ref];
  }
}

export function resolveAgents(roster: RosterAgent[], refs: string[] | undefined, a: SessionAssignment): RosterAgent[] {
  const ids = (refs ?? []).flatMap((r) => resolveRoleRef(r, a));
  const seen = new Set<string>();
  const out: RosterAgent[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const ag = agentById(roster, id);
    if (ag) out.push(ag);
  }
  return out;
}

/** Validate an assignment against a roster: every referenced id must exist + ≥1 panelist + judge + qaGate. */
export function validateAssignment(roster: RosterAgent[], a: SessionAssignment): { ok: boolean; missing: string[] } {
  const ids = new Set(roster.map((r) => r.id));
  const refd = [...a.panelists, a.judge, a.qaGate, ...(a.scribe ? [a.scribe] : [])];
  const missing = refd.filter((id) => id && !ids.has(id));
  const ok = missing.length === 0 && a.panelists.length > 0 && !!a.judge && !!a.qaGate;
  return { ok, missing };
}
