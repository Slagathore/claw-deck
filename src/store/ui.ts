import { create } from 'zustand';

type Tab = 'chat' | 'library' | 'console' | 'history' | 'prompts' | 'settings' | 'upgrades' | 'self' | 'security';

/** A prompt handed to the Chat tab, optionally requesting Agent (plan & execute) mode. */
export interface PendingPrompt { prompt: string; agent: boolean; }

interface UIState {
  tab: Tab;
  setTab: (t: Tab) => void;
  paletteOpen: boolean;
  togglePalette: () => void;
  pending: PendingPrompt | null;
  /** Drop a prior prompt back into Chat (plain chat mode). */
  branchFromHistory: (prompt: string) => void;
  /** Hand a prompt to Chat in Agent (plan & execute) mode. */
  branchToAssistant: (prompt: string) => void;
  consumePending: () => PendingPrompt | null;
}

export const useUI = create<UIState>(set => ({
  tab: 'chat',
  setTab: (t) => set({ tab: t }),
  paletteOpen: false,
  togglePalette: () => set(s => ({ paletteOpen: !s.paletteOpen })),
  pending: null,
  branchFromHistory: (prompt) => set({ pending: { prompt, agent: false }, tab: 'chat' }),
  branchToAssistant: (prompt) => set({ pending: { prompt, agent: true }, tab: 'chat' }),
  consumePending: () => {
    let p: PendingPrompt | null = null;
    set(s => { p = s.pending; return { pending: null }; });
    return p;
  }
}));

interface SettingsState {
  loaded: boolean;
  data: any;
  load: () => Promise<void>;
  save: (patch: any) => Promise<void>;
}
export const useSettings = create<SettingsState>((set, get) => ({
  loaded: false,
  data: {},
  load: async () => {
    const data = await window.api.settings.get();
    set({ data, loaded: true });
  },
  save: async (patch) => {
    await window.api.settings.set(patch);
    set({ data: { ...get().data, ...patch } });
  }
}));
