// Council run state machine (BOOTSTRAP §3 Phase 3). Executes a Protocol's phase
// graph over a SessionAssignment. The transport + executor are INJECTED so the
// whole machine is unit-testable with stubs (no network/CLI). Advisors run in
// parallel and degrade to k-of-n (Promise.allSettled). A scribe condenses each
// phase so raw transcripts never get dumped into the actors. Gates return a
// verdict; major/veto bounces the run.

import { RosterAgent, SessionAssignment, Msg, GateVerdict, resolveAgents } from './agents';
import { Protocol, Phase, parseGateVerdict, isConverged, extractDiff } from './protocol';

export type TransportFn = (agent: RosterAgent, messages: Msg[], onDelta?: (chunk: string) => void) => Promise<string>;

export interface CouncilEvent { type: string; phase?: string; kind?: string; agentId?: string; content?: string; verdict?: string; round?: number; ok?: boolean; status?: string }

export interface ExecutorHooks {
  propose: (plan: string, diff?: string) => Promise<{ ok: boolean; diff?: string; error?: string }>;
  delegate?: (agent: RosterAgent, prompt: string) => Promise<{ ok: boolean; diff?: string; error?: string }>;
  validate: () => Promise<{ ok: boolean }>;
  approve: () => Promise<{ ok: boolean; error?: string }>;
}

export interface RunResult {
  status: 'completed' | 'bounced' | 'aborted';
  phasesRun: string[];
  transcript: { phase: string; kind: string; agentId?: string; content: string }[];
  artifact: string;
  verdicts: GateVerdict[];
  approved: boolean;
}

/** The resumable state of a run: everything needed to continue from `phaseIndex`. */
export interface ResumeState {
  phaseIndex: number;                       // index of the next phase to run
  artifact: string;                         // accumulated working text passed between phases
  transcript: RunResult['transcript'];
  verdicts: GateVerdict[];
  approved: boolean;
}

export interface RunDeps {
  roster: RosterAgent[];
  assignment: SessionAssignment;
  task: string;
  transport: TransportFn;
  emit?: (ev: CouncilEvent) => void;
  executor?: ExecutorHooks;
  minAdvisors?: number;
  signal?: { aborted: boolean };
  resumeFrom?: ResumeState;                 // continue a prior run from this checkpoint
  onCheckpoint?: (cp: ResumeState) => void; // called after each phase completes (persist to resume later)
}

const SYS = {
  panelist: 'You are an expert engineer on a review council. Give your best concise technical take on the task. If revising, improve on the prior takes — do not just restate them.',
  scribe: 'You are the council scribe. Condense the discussion into ONE clear, actionable proposal. No preamble.',
  gate: 'You are a QA/judge gate. Reply with exactly one verdict word first — approve, minor, major, or veto — then a one-paragraph rationale. Include a fenced ```diff if you have concrete edits.',
  converge: 'Reply with exactly one word: CONVERGED if the panel substantially agrees and no new points remain, else CONTINUE.',
  relay: 'You are pairing on a fix. Build on the other agent\'s last message; move toward a concrete, minimal change. Include a fenced ```diff when you have one.',
};

async function ask(deps: RunDeps, agent: RosterAgent, system: string, user: string, phase?: string): Promise<string | null> {
  try {
    deps.emit?.({ type: 'agent-start', phase, agentId: agent.id });
    return await deps.transport(agent, [{ role: 'system', content: system }, { role: 'user', content: user }],
      (delta) => { try { deps.emit?.({ type: 'agent-delta', phase, agentId: agent.id, content: delta }); } catch { /* ignore */ } });
  }
  catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 1000);
    try { deps.emit?.({ type: 'agent-error', phase, agentId: agent.id, content: msg, ok: false }); } catch { /* ignore */ }
    return null;
  }
}

export async function runProtocol(protocol: Protocol, deps: RunDeps): Promise<RunResult> {
  const emit = (ev: CouncilEvent) => { try { deps.emit?.(ev); } catch { /* ignore */ } };
  const transcript: RunResult['transcript'] = deps.resumeFrom ? [...deps.resumeFrom.transcript] : [];
  const verdicts: GateVerdict[] = deps.resumeFrom ? [...deps.resumeFrom.verdicts] : [];
  const phasesRun: string[] = [];
  const minAdvisors = deps.minAdvisors ?? 1;
  let artifact = deps.resumeFrom?.artifact ?? '';
  let approved = deps.resumeFrom?.approved ?? false;
  const startIndex = deps.resumeFrom?.phaseIndex ?? 0;

  const record = (phase: string, kind: string, content: string, agentId?: string) => {
    transcript.push({ phase, kind, agentId, content });
    emit({ type: 'agent', phase, kind, agentId, content });
  };

  for (let pi = startIndex; pi < protocol.phases.length; pi++) {
    const phase = protocol.phases[pi];
    if (deps.signal?.aborted) return { status: 'aborted', phasesRun, transcript, artifact, verdicts, approved };
    const label = phase.label ?? phase.kind;
    phasesRun.push(label);
    emit({ type: 'phase', phase: label, kind: phase.kind });

    if (phase.kind === 'independent') {
      const agents = resolveAgents(deps.roster, phase.agents, deps.assignment);
      const settled = await Promise.allSettled(agents.map((a) => ask(deps, a, SYS.panelist, `Task:\n${deps.task}\n\nCurrent artifact:\n${artifact || '(none yet)'}`, label)));
      const takes: string[] = [];
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled' && s.value) { takes.push(`### ${agents[i].displayName}\n${s.value}`); record(label, phase.kind, s.value, agents[i].id); }
      });
      if (takes.length < minAdvisors && takes.length === 0) { /* degrade: keep prior artifact */ }
      else artifact = takes.join('\n\n');
    }

    else if (phase.kind === 'debate') {
      const agents = resolveAgents(deps.roster, phase.agents, deps.assignment);
      const rounds = phase.rounds ?? 3;
      for (let r = 0; r < rounds; r++) {
        if (deps.signal?.aborted) break;
        emit({ type: 'debate-round', phase: label, round: r + 1 });
        const settled = await Promise.allSettled(agents.map((a) => ask(deps, a, SYS.panelist, `Task:\n${deps.task}\n\nDiscussion so far:\n${artifact}\n\nYour refined take:`, label)));
        const takes: string[] = [];
        settled.forEach((s, i) => { if (s.status === 'fulfilled' && s.value) { takes.push(`### ${agents[i].displayName}\n${s.value}`); record(label, phase.kind, s.value, agents[i].id); } });
        if (takes.length) artifact = takes.join('\n\n');
        if (phase.stopOn === 'converge' && agents.length) {
          const check = await ask(deps, agents[0], SYS.converge, artifact, label);
          if (check && isConverged(check)) { emit({ type: 'converged', phase: label, round: r + 1 }); break; }
        }
      }
    }

    else if (phase.kind === 'synthesize') {
      const scribe = resolveAgents(deps.roster, [phase.by ?? '@scribe'], deps.assignment)[0];
      if (scribe) { const out = await ask(deps, scribe, SYS.scribe, artifact, label); if (out) { artifact = out; record(label, phase.kind, out, scribe.id); } }
    }

    else if (phase.kind === 'gate') {
      const gate = resolveAgents(deps.roster, [phase.by ?? '@qa-gate'], deps.assignment)[0];
      if (!gate) continue;
      const reply = await ask(deps, gate, SYS.gate, `Proposal to review:\n${artifact}`, label);
      if (!reply) {
        const verdict: GateVerdict = { verdict: 'major', notes: `${gate.displayName} failed to respond; see agent-error event above.` };
        verdicts.push(verdict);
        emit({ type: 'verdict', phase: label, agentId: gate.id, verdict: verdict.verdict, content: verdict.notes });
        emit({ type: 'bounce', phase: label, verdict: verdict.verdict });
        return { status: 'bounced', phasesRun, transcript, artifact, verdicts, approved };
      }
      const verdict = parseGateVerdict(reply);
      verdicts.push(verdict);
      record(label, phase.kind, reply, gate.id);
      emit({ type: 'verdict', phase: label, agentId: gate.id, verdict: verdict.verdict });
      if (verdict.verdict === 'minor' && verdict.patch) artifact += `\n\n<!-- gate patch -->\n${verdict.patch}`;
      if (verdict.verdict === 'major' || verdict.verdict === 'veto') {
        emit({ type: 'bounce', phase: label, verdict: verdict.verdict });
        return { status: 'bounced', phasesRun, transcript, artifact, verdicts, approved };
      }
    }

    else if (phase.kind === 'relay') {
      const pair = resolveAgents(deps.roster, phase.agents, deps.assignment);
      const turns = phase.maxTurns ?? 4;
      let msg = `Task:\n${deps.task}\n\nStarting point:\n${artifact || '(none)'}`;
      for (let t = 0; t < turns && pair.length >= 1; t++) {
        if (deps.signal?.aborted) break;
        const speaker = pair[t % pair.length];
        const reply = await ask(deps, speaker, SYS.relay, msg, label);
        if (!reply) continue;
        msg = reply; artifact = reply; record(label, phase.kind, reply, speaker.id);
      }
    }

    else if (phase.kind === 'vote') {
      const agents = resolveAgents(deps.roster, phase.agents, deps.assignment);
      let yes = 0; let n = 0;
      await Promise.allSettled(agents.map(async (a) => {
        const reply = await ask(deps, a, 'Reply YES if you approve this proposal, else NO, then a brief reason.', artifact, label);
        if (reply) { n++; if (/\byes\b/i.test(reply)) yes++; record(label, phase.kind, reply, a.id); }
      }));
      if (n && yes * 2 <= n) { emit({ type: 'bounce', phase: label, verdict: 'vote-failed' }); return { status: 'bounced', phasesRun, transcript, artifact, verdicts, approved }; }
    }

    else if (phase.kind === 'propose' || phase.kind === 'execute') {
      const actor = resolveAgents(deps.roster, [phase.by ?? '@judge'], deps.assignment)[0];
      const diff = extractDiff(artifact);
      if (deps.executor) {
        const p = phase.kind === 'execute' && !diff && actor && deps.executor.delegate
          ? await deps.executor.delegate(actor, `Task:\n${deps.task}\n\nCouncil proposal:\n${artifact}\n\nEdit the working tree directly to implement the smallest correct fix. Keep changes focused. When done, summarize what changed.`)
          : await deps.executor.propose(artifact, diff);
        emit({ type: 'propose', phase: label, ok: p.ok, agentId: actor?.id });
        if (p.ok && phase.kind === 'execute') {
          const v = await deps.executor.validate();
          emit({ type: 'validate', phase: label, ok: v.ok });
          if (v.ok) { const ap = await deps.executor.approve(); approved = ap.ok; emit({ type: 'execute', phase: label, ok: ap.ok }); }
        }
      } else if (actor) {
        record(label, phase.kind, `(no executor bound; ${phase.kind} skipped)`, actor.id);
      }
    }

    // checkpoint after each completed phase → the run can be resumed from here
    deps.onCheckpoint?.({ phaseIndex: pi + 1, artifact, transcript, verdicts, approved });
  }

  emit({ type: 'done', status: 'completed' });
  return { status: 'completed', phasesRun, transcript, artifact, verdicts, approved };
}
