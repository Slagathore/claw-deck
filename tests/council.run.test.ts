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

  it('gauntlet stops on NO_FURTHER_ISSUES; blind judge approves on LGTM', async () => {
    const proto: Protocol = { id: 'G', name: 'g', phases: [
      { kind: 'gauntlet', agents: ['@panelists'], maxTurns: 6, label: 'Gauntlet' },
      { kind: 'gate', by: '@judge', blind: true, label: 'Blind' },
    ] };
    let turn = 0;
    const transport = stub((_id, system) => {
      if (/BLIND reviewer/.test(system)) return 'LGTM';
      if (/ADVERSARIAL reviewer/.test(system)) { turn++; return turn >= 2 ? 'NO_FURTHER_ISSUES' : `concrete bug ${turn}`; }
      return 'x';
    });
    const { evs, emit } = collect();
    const res = await runProtocol(proto, { roster: ROSTER, assignment: ASSIGN, task: 't', transport, emit });
    expect(res.status).toBe('completed');                       // blind LGTM → approve (no bounce)
    expect(evs.some((e) => e.type === 'converged')).toBe(true); // gauntlet stopped early
  });

  it('blind judge bounces when it still finds problems', async () => {
    const proto: Protocol = { id: 'B', name: 'b', phases: [{ kind: 'gate', by: '@judge', blind: true, label: 'Blind' }] };
    const transport = stub(() => 'Still wrong: this uses an API removed in 4.3.');
    const res = await runProtocol(proto, { roster: ROSTER, assignment: ASSIGN, task: 't', transport });
    expect(res.status).toBe('bounced');
  });

  it('checkpoints after each phase and resumes mid-protocol without re-running earlier phases', async () => {
    const proto: Protocol = { id: 'R', name: 'r', phases: [
      { kind: 'independent', agents: ['@panelists'], label: 'P1' },
      { kind: 'synthesize', by: '@scribe', label: 'P2' },
      { kind: 'gate', by: '@judge', label: 'P3' },
    ] };
    const checkpoints: { phaseIndex: number }[] = [];
    const calls: string[] = [];
    const transport = stub((id, system) => { calls.push(id); return /verdict word/.test(system) ? 'approve' : `take-${id}`; });

    // first run: abort right after phase 0 (P1) checkpoints
    const abort = { aborted: false };
    const res1 = await runProtocol(proto, {
      roster: ROSTER, assignment: ASSIGN, task: 't', transport, signal: abort,
      onCheckpoint: (cp) => { checkpoints.push(cp); if (cp.phaseIndex === 1) abort.aborted = true; },
    });
    expect(res1.status).toBe('aborted');
    const cp = checkpoints.at(-1)!;
    expect(cp.phaseIndex).toBe(1);                       // resume point = phase index 1 (P2)
    expect(calls.filter((c) => c === 'p1' || c === 'p2').length).toBe(2);   // panelists ran once

    // resume from the checkpoint
    calls.length = 0;
    const res2 = await runProtocol(proto, { roster: ROSTER, assignment: ASSIGN, task: 't', transport, resumeFrom: cp as any });
    expect(res2.status).toBe('completed');
    expect(calls.includes('p1')).toBe(false);            // panelists (phase 0) NOT re-run
    expect(calls.includes('p2')).toBe(false);
    expect(calls.includes('j')).toBe(true);              // scribe + judge gate DID run
  });
});
