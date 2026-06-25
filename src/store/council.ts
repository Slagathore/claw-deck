import { create } from 'zustand';

export interface Assignment { panelists: string[]; judge: string; qaGate: string; scribe?: string }
export interface SessionConfig { protocolId: string; assignment: Assignment; task: string }
export interface CouncilEvt { runId: string; type: string; phase?: string; kind?: string; agentId?: string; content?: string; verdict?: string; round?: number; ok?: boolean; status?: string }

interface CouncilState {
  configs: Record<string, SessionConfig>;      // by workspace path
  runByWs: Record<string, string>;             // active runId per workspace
  events: Record<string, CouncilEvt[]>;        // by runId
  running: Record<string, boolean>;            // by runId
  setConfig: (ws: string, c: SessionConfig) => void;
  startRun: (ws: string, runId: string) => void;
  appendEvent: (ev: CouncilEvt) => void;
  finishRun: (runId: string) => void;
}

export const useCouncil = create<CouncilState>((set) => ({
  configs: {},
  runByWs: {},
  events: {},
  running: {},
  setConfig: (ws, c) => set((s) => ({ configs: { ...s.configs, [ws]: c } })),
  startRun: (ws, runId) => set((s) => ({ runByWs: { ...s.runByWs, [ws]: runId }, events: { ...s.events, [runId]: [] }, running: { ...s.running, [runId]: true } })),
  appendEvent: (ev) => set((s) => ({ events: { ...s.events, [ev.runId]: [...(s.events[ev.runId] ?? []), ev] } })),
  finishRun: (runId) => set((s) => ({ running: { ...s.running, [runId]: false } })),
}));
