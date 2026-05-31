import { create } from 'zustand';

/**
 * Central store for every subprocess "session" in the app — whether launched
 * from the Console tab, kicked off by a Library tool-install, or otherwise.
 *
 * A single global `runner.onEvent` subscription (wired once in App.tsx) routes
 * stdout/stderr/exit/error into here. Events for ids we don't track are ignored,
 * so internal one-shot runners (e.g. the Agent's per-step shell) don't leak in
 * unless they explicitly call `add()`.
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
  /** True when backed by a real pseudo-terminal (rendered with xterm). */
  pty?: boolean;
}

// ANSI/VT escape matchers, built with fromCharCode so no literal control bytes
// live in this source file. Used to keep PTY output readable in History.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const RE_CSI = new RegExp(ESC + '\\[[0-9;?]*[ -/]*[@-~]', 'g');
const RE_OSC = new RegExp(ESC + '\\][^' + BEL + ESC + ']*(?:' + BEL + '|' + ESC + '\\\\)', 'g');
const RE_ESC = new RegExp(ESC + '[@-Z\\\\-_]', 'g');

function stripAnsi(s: string): string {
  return s.replace(RE_CSI, '').replace(RE_OSC, '').replace(RE_ESC, '');
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
    const sess = get().sessions.find(s => s.id === ev.id);
    if (!sess) return;
    set(prev => ({
      sessions: prev.sessions.map(s => {
        if (s.id !== ev.id) return s;
        if (ev.kind === 'stdout' || ev.kind === 'stderr') return { ...s, output: s.output + ev.data };
        if (ev.kind === 'error') return { ...s, output: s.output + `\n[error] ${ev.data}\n` };
        if (ev.kind === 'exit') return { ...s, exited: ev.data, output: s.output + `\n[exit ${ev.data}]\n` };
        return s;
      })
    }));
    // Record finished sessions in History so the Console isn't a black hole.
    if (ev.kind === 'exit') {
      const finalOutput = get().sessions.find(s => s.id === ev.id)?.output ?? sess.output;
      const clean = sess.pty ? stripAnsi(finalOutput) : finalOutput;
      try {
        window.api.history.add({
          backend: `console:${sess.kind}`,
          model: null,
          prompt: sess.detail || sess.label,
          response: clean.slice(-4000),
          meta: { source: 'console', kind: sess.kind, cwd: sess.cwd, exit: ev.data, pty: !!sess.pty }
        });
      } catch { /* history is best-effort */ }
    }
  }
}));
