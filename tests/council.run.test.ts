import { describe, it, expect } from 'vitest';
import { runProtocol, TransportFn, CouncilEvent, ExecutorHooks } from '../electron/council/run';
import { PROTOCOLS, Protocol } from '../electron/council/protocol';
import { RosterAgent, SessionAssignment } from '../electron/council/agents';

const ROSTER: RosterAgent[] = [
  { id: 'p1', displayName: 'Panel One', transport: 'ollama-cloud', capabilities: { canEdit: false, canRunTools: false, costTier: 'cheap' } },
  { id: 'p2', displayName: 'Panel Two', transport: 'ollama-cloud', capabilities: { canEdit: false, canRunTools: false, costTier: 'cheap' } },
  { id: 'j', displayName: 'Judge', transport: 'claude-code', binary: 'claude', capabilities: { canEdit: true, canRunTools: true, costTier: 'expensive' } },
  { id: 'qa', displayName: 'QA', transport: 'codex', binary: 'codex', capabilities: { canEdit: true, canRunTools: true, costTier: 'mid' } },
];
const ASSIGN: SessionAssignment = { panelists: ['p1', 'p2'], judge: 'j', qaGate: 'qa' };

function stub(fn: (agentId: string, system: string, user: string) => string): TransportFn {
  return async (agent, messages) => {
    const system = messages[0]?.content ?? '';
    const user = messages[messages.length - 1]?.content ?? '';
    const out = fn(agent.id, system, user);
    if (out === '__throw__') throw new Error('advisor failed');
    return out;
  };
}

const okExecutor = (): ExecutorHooks => ({
  propose: async () => ({ ok: true, diff: 'diff --git a b' }),
  validate: async () => ({ ok: true }),
  approve: async () => ({ ok: true }),
});

const collect = () => { const evs: CouncilEvent[] = []; return { evs, emit: (e: CouncilEvent) => evs.push(e) }; };

describe('runProtocol', () => {
  it('COUNCIL runs all phases in order and completes', async () => {
    const { evs, emit } = collect();
    const transport = stub((_id, system) =>
      /verdict word/.test(system) ? 'approve — looks good' :
      /CONVERGED if/.test(system) ? 'CONVERGED' : 'a reasonable take');
    const res = await runProtocol(PROTOCOLS.COUNCIL, { roster: ROSTER, assignment: ASSIGN, task: 'do a thing', transport, emit, executor: okExecutor() });
    expect(res.status).toBe('completed');
    const phaseOrder = evs.filter((e) => e.type === 'phase').map((e) => e.phase);
    expect(phaseOrder).toEqual(['Independent takes', 'Debate', 'Synthesize', 'QA gate', 'QA ⇄ Judge', 'Judge gate', 'Execute']);
    expect(res.approved).toBe(true);
  });

  it('a stubbed major verdict bounces the run', async () => {
    const { evs, emit } = collect();
    const transport = stub((_id, system) => /verdict word/.test(system) ? 'major — this needs rework' : 'take');
    const res = await runProtocol(PROTOCOLS.GCRJ, { roster: ROSTER, assignment: ASSIGN, task: 't', transport, emit });
    expect(res.status).toBe('bounced');
    expect(evs.some((e) => e.type === 'bounce')).toBe(true);
    expect(res.verdicts.at(-1)?.verdict).toBe('major');
  });

  it('tolerates a failed advisor (k-of-n)', async () => {
    const proto: Protocol = { id: 'T', name: 't', phases: [{ kind: 'independent', agents: ['@panelists'], label: 'Ind' }, { kind: 'gate', by: '@judge', label: 'G' }] };
    const transport = stub((id, system) => /verdict word/.test(system) ? 'approve' : id === 'p1' ? '__throw__' : 'p2 take');
    const res = await runProtocol(proto, { roster: ROSTER, assignment: ASSIGN, task: 't', transport });
    expect(res.status).toBe('completed');
    expect(res.transcript.some((t) => t.agentId === 'p2')).toBe(true);
    expect(res.transcript.some((t) => t.agentId === 'p1')).toBe(false);
  });

  it('early convergence stops the debate', async () => {
    const { evs, emit } = collect();
    const proto: Protocol = { id: 'D', name: 'd', phases: [{ kind: 'debate', agents: ['@panelists'], rounds: 3, stopOn: 'converge', label: 'Debate' }] };
    const transport = stub((_id, system) => /CONVERGED if/.test(system) ? 'CONVERGED' : 'take');
    await runProtocol(proto, { roster: ROSTER, assignment: ASSIGN, task: 't', transport, emit });
    const rounds = evs.filter((e) => e.type === 'debate-round');
    expect(rounds.length).toBe(1);
    expect(evs.some((e) => e.type === 'converged')).toBe(true);
  });

  it('PAIR drives relay → execute through the executor and lands an approved diff', async () => {
    const { evs, emit } = collect();
    const transport = stub(() => 'here is the fix:\n```diff\ndiff --git a/x b/x\n@@\n-old\n+new\n```');
    const res = await runProtocol(PROTOCOLS.PAIR, { roster: ROSTER, assignment: ASSIGN, task: 'fix x', transport, emit, executor: okExecutor() });
    expect(res.status).toBe('completed');
    expect(res.approved).toBe(true);
    expect(evs.some((e) => e.type === 'execute' && e.ok)).toBe(true);
  });
});
