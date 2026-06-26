// Council run state machine (BOOTSTRAP §3 Phase 3). Executes a Protocol's phase
// graph over a SessionAssignment. The transport + executor are INJECTED so the
// whole machine is unit-testable with stubs (no network/CLI). Advisors run in
// parallel and degrade to k-of-n (Promise.allSettled). A scribe condenses each
// phase so raw transcripts never get dumped into the actors. Gates return a
// verdict; major/veto bounces the run.

import { RosterAgent, SessionAssignment, Msg, GateVerdict, resolveAgents } from './agents';
import { Protocol, Phase, parseGateVerdict, parseBlindVerdict, isConverged, extractDiff } from './protocol';
import { lintArtifact, formatFindings } from './fusionLint';
import { boundedRepair } from './fusionInfra';

export type TransportFn = (agent: RosterAgent, messages: Msg[], onDelta?: (chunk: string) => void) => Promise<string>;

export interface CouncilEvent { type: string; phase?: string; kind?: string; agentId?: string; content?: string; verdict?: string; round?: number; ok?: boolean; status?: string; questions?: string[] }

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
  forceBlind?: boolean;                     // make EVERY gate blind (judge never sees the consensus)
  atlasQuery?: (q: string) => Promise<string | null>;          // 'ingest' phase: Atlas code-brain lookup
  readFiles?: (paths: string[]) => Promise<Record<string, string>>; // 'ingest' phase: read the surfaced files
}

const SYS = {
  panelist: 'You are an expert engineer on a review council. Give your best concise technical take on the task. If revising, improve on the prior takes — do not just restate them.',
  scribe: 'You are the council scribe. Condense the discussion into ONE clear, actionable proposal. No preamble.',
  gate: 'You are a QA/judge gate. Reply with exactly one verdict word first — approve, minor, major, or veto — then a one-paragraph rationale. Include a fenced ```diff if you have concrete edits.',
  converge: 'Reply with exactly one word: CONVERGED if the panel substantially agrees and no new points remain, else CONTINUE.',
  relay: 'You are pairing on a fix. Build on the other agent\'s last message; move toward a concrete, minimal change. Include a fenced ```diff when you have one.',
  // Adversarial — but constructive too: find anything NEW that makes the result
  // better, not only what's "wrong". Still requires NEW substance per turn or stop.
  adversary: 'You are a rigorous reviewer on a council that must NOT simply agree. Examine the current proposal AND the prior responses and surface ONE NEW, substantive contribution the others missed — ANY of: a real bug / removed-or-deprecated API / wrong version assumption / missing edge case / security hole; OR something under-specified or not covered deeply enough; OR a needed clarification; OR a genuinely valuable addition (e.g. a helper/function/structure) that would make the app meaningfully better. Be specific and concrete. Do NOT restate prior points or pad. If, after genuine analysis, there is truly nothing of new value to add, reply with EXACTLY: NO_FURTHER_ISSUES',
  // Steelman: strengthen the proposal first, then flag what still remains.
  steelman: 'You are improving a proposal, not just critiquing it. FIRST, make it STRONGER: add what is missing, tighten weak spots, fill in under-specified parts, add a genuinely useful function/structure if it helps. THEN, briefly note any remaining real flaw. Output the improved proposal followed by a short "Remaining:" note. Be substantive — do not merely restate it.',
  // Blind judge: never shown the consensus — only the original task + the patch.
  blindJudge: 'You are a BLIND reviewer. You are NOT shown any prior discussion, agreement, or consensus — only the original task and the proposed change. Do not assume the change is correct because someone proposed it. Answer ONE question: what is STILL wrong, missing, or risky AFTER this change is applied? List concrete problems (and a corrected ```diff if you have one). If, after careful review, there is genuinely nothing wrong, reply with EXACTLY: LGTM',
  // Tournament: pick one winner, no merging.
  select: 'You are a judge selecting the single BEST proposal from several candidates. Choose exactly ONE — the most correct, complete, and runnable — and restate it IN FULL as the chosen proposal, with a one-line reason. Do NOT merge, average, or blend candidates.',
  // Repair-hand: fix ONLY the deterministic findings, return the whole artifact.
  repair: 'You are a repair hand. You are given an artifact and a list of DETERMINISTIC defects (truncated code, a wrong line left under a "BUG/should be/CORRECTION" note, an unclosed code fence, unbalanced brackets). Fix EXACTLY those defects and nothing else: complete truncated code, delete the known-wrong line and keep only the corrected value, close fences, balance brackets. Do not redesign. Output the COMPLETE corrected artifact, ready to ship — no commentary.',
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
  let repoMap = '';   // populated by an 'ingest' phase; threaded into deliberation prompts
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

    if (phase.kind === 'ingest') {
      // Ground the panel in the real code: Atlas symbols for the task + source of the top
      // files it surfaces. Deterministic (no model call); threaded into deliberation prompts.
      const parts: string[] = [];
      let atlas: string | null = null;
      if (deps.atlasQuery) { try { atlas = await deps.atlasQuery(deps.task); } catch { /* none */ } }
      if (atlas) {
        parts.push(`## Atlas — relevant symbols\n${atlas}`);
        if (deps.readFiles) {
          const files = [...new Set(atlas.split('\n').map((l) => l.split(' — ')[0].replace(/:\d+$/, '').trim()).filter(Boolean))].slice(0, 6);
          try { const contents = await deps.readFiles(files); const fp = Object.entries(contents).filter(([, c]) => c).map(([f, c]) => `### ${f}\n${c.slice(0, 6000)}`); if (fp.length) parts.push(`## Source of key files\n${fp.join('\n\n')}`); } catch { /* skip */ }
        }
      }
      repoMap = parts.join('\n\n');
      emit({ type: 'agent', phase: label, kind: 'ingest', content: repoMap ? `Grounded the panel in ${(atlas ?? '').split('\n').filter(Boolean).length} symbol(s) + the source of the key files.` : 'No Atlas index for this workspace — run Project Brain → Index to ground the panel. Proceeding without it.' });
    }

    else if (phase.kind === 'independent') {
      const agents = resolveAgents(deps.roster, phase.agents, deps.assignment);
      const settled = await Promise.allSettled(agents.map((a) => ask(deps, a, SYS.panelist, `Task:\n${deps.task}${repoMap ? `\n\nRepo context:\n${repoMap}` : ''}\n\nCurrent artifact:\n${artifact || '(none yet)'}`, label)));
      const takes: string[] = [];
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled' && s.value) { takes.push(`### ${agents[i].displayName}\n${s.value}`); record(label, phase.kind, s.value, agents[i].id); }
      });
      if (takes.length < agents.length) emit({ type: 'warn', phase: label, content: `${agents.length - takes.length} advisor(s) dropped (fetch failed); quorum now ${takes.length}/${agents.length}`, ok: takes.length >= minAdvisors });
      if (takes.length < minAdvisors && takes.length === 0) { /* degrade: keep prior artifact */ }
      else artifact = takes.join('\n\n');
    }

    else if (phase.kind === 'debate') {
      const agents = resolveAgents(deps.roster, phase.agents, deps.assignment);
      const rounds = phase.rounds ?? 3;
      for (let r = 0; r < rounds; r++) {
        if (deps.signal?.aborted) break;
        emit({ type: 'debate-round', phase: label, round: r + 1 });
        const settled = await Promise.allSettled(agents.map((a) => ask(deps, a, SYS.panelist, `Task:\n${deps.task}${repoMap ? `\n\nRepo context:\n${repoMap}` : ''}\n\nDiscussion so far:\n${artifact}\n\nYour refined take:`, label)));
        const takes: string[] = [];
        settled.forEach((s, i) => { if (s.status === 'fulfilled' && s.value) { takes.push(`### ${agents[i].displayName}\n${s.value}`); record(label, phase.kind, s.value, agents[i].id); } });
        if (takes.length) artifact = takes.join('\n\n');
        if (phase.stopOn === 'converge' && agents.length) {
          const check = await ask(deps, agents[0], SYS.converge, artifact, label);
          if (check && isConverged(check)) { emit({ type: 'converged', phase: label, round: r + 1 }); break; }
        }
      }
    }

    else if (phase.kind === 'gauntlet') {
      // adversarial: agents take turns trying to break the proposal; each must
      // find a NEW issue or say NO_FURTHER_ISSUES. Stops when an agent finds
      // nothing further (or maxTurns). Findings are appended for the synthesizer.
      const agents = resolveAgents(deps.roster, phase.agents, deps.assignment);
      const maxTurns = phase.maxTurns ?? Math.max(agents.length * 2, 4);
      const issues: string[] = [];
      let clears = 0;
      for (let t = 0; t < maxTurns && agents.length; t++) {
        if (deps.signal?.aborted) break;
        const agent = agents[t % agents.length];
        const prior = issues.length ? `Issues already raised (do NOT repeat these):\n${issues.join('\n')}` : '(no issues raised yet)';
        const reply = await ask(deps, agent, SYS.adversary, `Task:\n${deps.task}${repoMap ? `\n\nRepo context:\n${repoMap}` : ''}\n\nCurrent proposal:\n${artifact}\n\n${prior}\n\nFind a NEW concrete problem, or reply NO_FURTHER_ISSUES.`, label);
        if (!reply) continue;
        record(label, phase.kind, reply, agent.id);
        if (/NO_FURTHER_ISSUES/i.test(reply)) { if (++clears >= 1) { emit({ type: 'converged', phase: label, round: t + 1 }); break; } continue; }
        clears = 0;
        issues.push(`- (${agent.displayName}) ${reply.replace(/\s+/g, ' ').slice(0, 400)}`);
      }
      if (issues.length) artifact += `\n\n## Adversarial findings (must be addressed)\n${issues.join('\n')}`;
    }

    else if (phase.kind === 'steelman') {
      // constructive rounds: each agent strengthens the proposal, then flags what remains
      const agents = resolveAgents(deps.roster, phase.agents, deps.assignment);
      const rounds = phase.rounds ?? 2;
      for (let r = 0; r < rounds; r++) {
        if (deps.signal?.aborted) break;
        emit({ type: 'debate-round', phase: label, round: r + 1 });
        const settled = await Promise.allSettled(agents.map((a) => ask(deps, a, SYS.steelman, `Task:\n${deps.task}${repoMap ? `\n\nRepo context:\n${repoMap}` : ''}\n\nCurrent proposal:\n${artifact}\n\nStrengthen it, then note what remains.`, label)));
        const takes: string[] = [];
        settled.forEach((s, i) => { if (s.status === 'fulfilled' && s.value) { takes.push(`### ${agents[i].displayName}\n${s.value}`); record(label, phase.kind, s.value, agents[i].id); } });
        if (takes.length < agents.length) emit({ type: 'warn', phase: label, content: `${agents.length - takes.length} advisor(s) dropped this round; quorum ${takes.length}/${agents.length}`, ok: takes.length > 0 });
        if (takes.length) artifact = takes.join('\n\n');
      }
    }

    else if (phase.kind === 'select') {
      const judge = resolveAgents(deps.roster, [phase.by ?? '@judge'], deps.assignment)[0];
      if (judge) {
        const out = await ask(deps, judge, SYS.select, `Task:\n${deps.task}${repoMap ? `\n\nRepo context:\n${repoMap}` : ''}\n\nCandidate proposals:\n${artifact}\n\nPick the single strongest and restate it in full.`, label);
        if (out) { artifact = out; record(label, phase.kind, out, judge.id); }
      }
    }

    else if (phase.kind === 'synthesize') {
      const scribe = resolveAgents(deps.roster, [phase.by ?? '@scribe'], deps.assignment)[0];
      if (scribe) { const out = await ask(deps, scribe, SYS.scribe, artifact, label); if (out) { artifact = out; record(label, phase.kind, out, scribe.id); } }
    }

    else if (phase.kind === 'gate') {
      const gate = resolveAgents(deps.roster, [phase.by ?? '@qa-gate'], deps.assignment)[0];
      if (!gate) continue;
      // §1.4 pre-gate: deterministic, free lint runs BEFORE the QA model call. It
      // catches the truncation/dead-code/imbalance defects (incl. the bounce cause).
      let lint = lintArtifact(artifact);
      if (lint.findings.length) emit({ type: 'lint', phase: label, content: formatFindings(lint), ok: lint.passed });
      // §1.4/§2.3 — blocking findings route into a bounded repair loop (≤2 rounds)
      // BEFORE spending the QA model call. Still failing → ship + surface (no abort).
      if (!lint.passed) {
        const repairHand = resolveAgents(deps.roster, ['@scribe'], deps.assignment)[0] ?? gate;
        const rr = await boundedRepair(
          artifact,
          { passed: false, findings: lint.findings, report: formatFindings(lint) },
          async (art, report) => (await ask(deps, repairHand, SYS.repair, `Artifact:\n${art}\n\nDeterministic findings to fix (change nothing else):\n${report}\n\nReturn the COMPLETE corrected artifact.`, `${label} · repair`)) || art,
          (art) => { const l = lintArtifact(art); return { passed: l.passed, findings: l.findings, report: formatFindings(l) }; },
          { maxRounds: 2 },
        );
        artifact = rr.artifact;
        lint = lintArtifact(artifact);
        emit({ type: 'lint', phase: `${label} · repaired`, content: rr.passed ? `repaired clean in ${rr.rounds} round(s)` : formatFindings(lint), ok: rr.passed });
      }
      const lintNote = lint.passed ? '' : `\n\n[DETERMINISTIC PRE-GATE — free lint, not a content verdict; ${lint.blockCount} residual after auto-repair]\n${formatFindings(lint)}\nIf a finding is pure truncation/plumbing, judge the work itself, not the cut.`;
      // blind: judge sees ONLY (task + the patch), never the discussion/consensus.
      const blind = phase.blind || deps.forceBlind;
      const diff = extractDiff(artifact);
      const reviewBody = (blind
        ? `Original task:\n${deps.task}\n\nProposed change:\n${diff ?? `(no diff fenced; proposal text follows)\n${artifact.slice(0, 6000)}`}`
        : `Proposal to review:\n${artifact}`) + lintNote;
      const reply = await ask(deps, gate, blind ? SYS.blindJudge : SYS.gate, reviewBody, label);
      if (!reply) {
        const verdict: GateVerdict = { verdict: 'major', notes: `${gate.displayName} failed to respond; see agent-error event above.` };
        verdicts.push(verdict);
        emit({ type: 'verdict', phase: label, agentId: gate.id, verdict: verdict.verdict, content: verdict.notes });
        emit({ type: 'bounce', phase: label, verdict: verdict.verdict });
        return { status: 'bounced', phasesRun, transcript, artifact, verdicts, approved };
      }
      const verdict = blind ? parseBlindVerdict(reply) : parseGateVerdict(reply);
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
      let msg = `Task:\n${deps.task}${repoMap ? `\n\nRepo context:\n${repoMap}` : ''}\n\nStarting point:\n${artifact || '(none)'}`;
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
        // Prefer the agentic editor for an editing-capable actor: it writes real files and
        // reconciles any proposed diff against the actual tree — more robust than blindly
        // applying a model-emitted diff (which may be illustrative/partial). Fall back to
        // diff-apply only when the actor can't edit (or there's no delegate hook).
        const useDelegate = phase.kind === 'execute' && actor && deps.executor.delegate && actor.capabilities?.canEdit;
        const p = useDelegate
          ? await deps.executor.delegate!(actor!, `Task:\n${deps.task}${repoMap ? `\n\nRepo context:\n${repoMap}` : ''}\n\nCouncil proposal:\n${artifact}\n\nImplement this in the working tree. Create/overwrite whatever files are needed. Keep changes focused. When done, summarize what changed.`)
          : await deps.executor.propose(artifact, diff);
        emit({ type: 'propose', phase: label, ok: p.ok, agentId: actor?.id });
        if (!p.ok) {
          // Loud, actionable warning so a "deliberating but never writing" run is obvious.
          const hint = diff ? '' : ' No fenced diff in the proposal and the actor could not edit — assign an editing-capable judge (Kimi with "edits" on, or Claude/Codex/OpenClaw) so the council can write files.';
          emit({ type: 'warn', phase: label, content: `⚠ NOTHING WAS WRITTEN TO DISK: ${p.error ?? 'the executor could not apply changes'}.${hint}`, ok: false });
        }
        if (p.ok && phase.kind === 'execute') {
          const v = await deps.executor.validate();
          emit({ type: 'validate', phase: label, ok: v.ok });
          if (v.ok) { const ap = await deps.executor.approve(); approved = ap.ok; emit({ type: 'execute', phase: label, ok: ap.ok }); }
          else emit({ type: 'warn', phase: label, content: '⚠ changes written to the worktree FAILED validation — not applied to your tree. See the Run ledger for the diff.', ok: false });
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
