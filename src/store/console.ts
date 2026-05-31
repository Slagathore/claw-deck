import { create } from 'zustand';

/**
 * Central store for every subprocess "session" in the app — whether launched
 * from the Console tab, kicked off by a Library tool-install, or otherwise.
 *
 * A single global `runner.onEvent` subscription (wired once in App.tsx) routes
 * stdout/stderr/exit/error into here. Events for ids we don't track are ignored,
 * so internal one-shot runners (e.g. the Assistant's per-step shell) don't leak
 * in unless they explicitly call `add()`.
 */

export type SessionKind = 'openclaw' | 'claude' | 'shell' | 'tool';

export interface ConsoleSession {
  id: string;
  kind: SessionKind;
  label: string;
  detail?: string;        // e.g. "winget install --id Git.Git"
  cwd?: string;
  startedAt: number;
  exited?: number | null; // null = running, number = exit code
  output: string;
  /** Whether the input bar can pipe stdin to this process. */
  supportsInput: boolean;
}

interface RunnerEvent {
  id: string;
  kind: 'stdout' | 'stderr' | 'exit' | 'error';
  data: any;
}

interface ConsoleState {
  sessions: ConsoleSession[];
  activeId: string | null;
  setActive: (id: string | null) => void;
  add: (s: Omit<ConsoleSession, 'output' | 'exited'> & { output?: string; exited?: number | null }) => void;
  remove: (id: string) => void;
  handleEvent: (ev: RunnerEvent) => void;
}

export const useConsole = create<ConsoleState>((set, get) => ({
  sessions: [],
  activeId: null,

  setActive: (id) => set({ activeId: id }),

  add: (s) => set(prev => ({
    sessions: [{ output: '', exited: null, ...s }, ...prev.sessions],
    activeId: s.id
  })),

  remove: (id) => set(prev => ({
    sessions: prev.sessions.filter(p => p.id !== id),
    activeId: prev.activeId === id ? null : prev.activeId
  })),

  handleEvent: (ev) => {
    // Only update sessions we already track; ignore unknown ids.
    if (!get().sessions.some(s => s.id === ev.id)) return;
    set(prev => ({
      sessions: prev.sessions.map(s => {
        if (s.id !== ev.id) return s;
        if (ev.kind === 'stdout' || ev.kind === 'stderr') return { ...s, output: s.output + ev.data };
        if (ev.kind === 'error') return { ...s, output: s.output + `\n[error] ${ev.data}\n` };
        if (ev.kind === 'exit') return { ...s, exited: ev.data, output: s.output + `\n[exit ${ev.data}]\n` };
        return s;
      })
    }));
  }
}));
