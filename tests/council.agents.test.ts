import { describe, it, expect } from 'vitest';
import { resolveRoleRef, resolveAgents, validateAssignment, RosterAgent, SessionAssignment } from '../electron/council/agents';
import { PROTOCOLS, parseGateVerdict, isConverged, extractDiff } from '../electron/council/protocol';

const ROSTER: RosterAgent[] = [
  { id: 'p1', displayName: 'P1', transport: 'ollama-cloud', capabilities: { canEdit: false, canRunTools: false, costTier: 'cheap' } },
  { id: 'p2', displayName: 'P2', transport: 'ollama-cloud', capabilities: { canEdit: false, canRunTools: false, costTier: 'cheap' } },
  { id: 'j', displayName: 'J', transport: 'claude-code', capabilities: { canEdit: true, canRunTools: true, costTier: 'expensive' } },
  { id: 'qa', displayName: 'QA', transport: 'codex', capabilities: { canEdit: true, canRunTools: true, costTier: 'mid' } },
];
const A: SessionAssignment = { panelists: ['p1', 'p2'], judge: 'j', qaGate: 'qa' };

describe('agent resolution', () => {
  it('resolves role refs', () => {
    expect(resolveRoleRef('@panelists', A)).toEqual(['p1', 'p2']);
    expect(resolveRoleRef('@judge', A)).toEqual(['j']);
    expect(resolveRoleRef('@qa-gate', A)).toEqual(['qa']);
    expect(resolveRoleRef('@scribe', A)).toEqual(['j']);     // no scribe → falls back to judge
    expect(resolveRoleRef('p2', A)).toEqual(['p2']);          // literal id
  });
  it('resolveAgents maps + dedupes', () => {
    const a = resolveAgents(ROSTER, ['@panelists', 'p1'], A);
    expect(a.map((x) => x.id)).toEqual(['p1', 'p2']);
  });
  it('validateAssignment flags unknown ids and missing roles', () => {
    expect(validateAssignment(ROSTER, A).ok).toBe(true);
    expect(validateAssignment(ROSTER, { panelists: ['nope'], judge: 'j', qaGate: 'qa' }).missing).toContain('nope');
    expect(validateAssignment(ROSTER, { panelists: [], judge: 'j', qaGate: 'qa' }).ok).toBe(false);
  });
});

describe('protocol helpers', () => {
  it('ships all five protocols', () => {
    expect(Object.keys(PROTOCOLS).sort()).toEqual(['COUNCIL', 'GCRJ', 'PAIR', 'PCRSR', 'REDTEAM']);
    expect(PROTOCOLS.PAIR.phases.map((p) => p.kind)).toEqual(['relay', 'execute']);
  });
  it('parseGateVerdict picks the verdict word (defaults safe to major)', () => {
    expect(parseGateVerdict('VETO: dangerous').verdict).toBe('veto');
    expect(parseGateVerdict('major issues remain').verdict).toBe('major');
    expect(parseGateVerdict('minor nits only').verdict).toBe('minor');
    expect(parseGateVerdict('approve — LGTM').verdict).toBe('approve');
    expect(parseGateVerdict('hmm not sure').verdict).toBe('major');
  });
  it('isConverged + extractDiff', () => {
    expect(isConverged('we have CONVERGED on the design')).toBe(true);
    expect(isConverged('still debating')).toBe(false);
    expect(extractDiff('text\n```diff\ndiff --git a/x b/x\n@@\n-a\n+b\n```')).toContain('diff --git');
    expect(extractDiff('no patch here')).toBeUndefined();
  });
});
