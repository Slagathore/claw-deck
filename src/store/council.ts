import { create } from 'zustand';

export interface Assignment { panelists: string[]; judge: string; qaGate: string; scribe?: string }
export interface SessionConfig { protocolId: string; assignment: Assignment; task: string }
export interface CouncilEvt { runId: string; type: string; phase?: string; kind?: string; agentId?: string; content?: string; verdict?: string; round?: number; ok?: boolean; status?: string; questions?: string[] }
export interface LiveLane { phase?: string; text: string }

interface CouncilState {
  configs: Record<string, SessionConfig>;                          // by workspace path
  runByWs: Record<string, string>;                                 // active runId per workspace
  events: Record<string, CouncilEvt[]>;                            // finalized events, by runId
  live: Record<string, Record<string, LiveLane>>;                  // in-flight streaming text, by runId → agentId
  questions: Record<string, string[]>;                             // prologue questions awaiting answers, by runId
  running: Record<string, boolean>;                                // by runId
  setConfig: (ws: string, c: SessionConfig) => void;
  startRun: (ws: string, runId: string) => void;
  loadRun: (ws: string, runId: string, events: CouncilEvt[]) => void;   // replay a past session in the theater
  appendEvent: (ev: CouncilEvt) => void;
  clearQuestions: (runId: string) => void;
  markRunning: (runId: string) => void;
  newSession: (ws: string) => void;
  finishRun: (runId: string) => void;
}

export const useCouncil = create<CouncilState>((set) => ({
  configs: {},
  runByWs: {},
  events: {},
  live: {},
  questions: {},
  running: {},
  setConfig: (ws, c) => set((s) => ({ configs: { ...s.configs, [ws]: c } })),
  startRun: (ws, runId) => set((s) => ({ runByWs: { ...s.runByWs, [ws]: runId }, events: { ...s.events, [runId]: [] }, live: { ...s.live, [runId]: {} }, questions: { ...s.questions, [runId]: [] }, running: { ...s.running, [runId]: true } })),
  loadRun: (ws, runId, events) => set((s) => ({ runByWs: { ...s.runByWs, [ws]: runId }, events: { ...s.events, [runId]: events }, live: { ...s.live, [runId]: {} }, questions: { ...s.questions, [runId]: [] }, running: { ...s.running, [runId]: false } })),
  clearQuestions: (runId) => set((s) => ({ questions: { ...s.questions, [runId]: [] } })),
  markRunning: (runId) => set((s) => ({ running: { ...s.running, [runId]: true } })),
  newSession: (ws) => set((s) => { const runByWs = { ...s.runByWs }; delete runByWs[ws]; return { runByWs }; }),
  appendEvent: (ev) => set((s) => {
    const runId = ev.runId;
    // prologue questions arrived → pause (not "running") and stash them for the answer panel
    if (ev.type === 'questions') return { running: { ...s.running, [runId]: false }, questions: { ...s.questions, [runId]: ev.questions ?? [] }, events: { ...s.events, [runId]: [...(s.events[runId] ?? []), ev] } };
    // streaming lifecycle: agent-start opens a live lane, agent-delta appends, the
    // final 'agent'/'agent-error' event closes it (and the discrete event lands in events[]).
    if (ev.type === 'agent-start') {
      const lanes = { ...(s.live[runId] ?? {}) };
      if (ev.agentId) lanes[ev.agentId] = { phase: ev.phase, text: '' };
      return { live: { ...s.live, [runId]: lanes } };
    }
    if (ev.type === 'agent-delta') {
      const lanes = { ...(s.live[runId] ?? {}) };
      if (ev.agentId) { const cur = lanes[ev.agentId] ?? { phase: ev.phase, text: '' }; lanes[ev.agentId] = { phase: ev.phase ?? cur.phase, text: cur.text + (ev.content ?? '') }; }
      return { live: { ...s.live, [runId]: lanes } };
    }
    let live = s.live;
    if ((ev.type === 'agent' || ev.type === 'agent-error') && ev.agentId) {
      const lanes = { ...(s.live[runId] ?? {}) }; delete lanes[ev.agentId]; live = { ...s.live, [runId]: lanes };
    }
    return { events: { ...s.events, [runId]: [...(s.events[runId] ?? []), ev] }, live };
  }),
  finishRun: (runId) => set((s) => ({ running: { ...s.running, [runId]: false }, live: { ...s.live, [runId]: {} } })),
}));
