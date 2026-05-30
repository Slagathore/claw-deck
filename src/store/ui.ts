import { create } from 'zustand';

type Tab = 'chat' | 'assistant' | 'library' | 'cli' | 'terminal' | 'history' | 'prompts' | 'settings' | 'upgrades' | 'self' | 'security';

interface UIState {
  tab: Tab;
  setTab: (t: Tab) => void;
  paletteOpen: boolean;
  togglePalette: () => void;
  pendingPrompt: string | null;
  pendingTarget: Tab;
  branchFromHistory: (prompt: string) => void;
  branchToAssistant: (prompt: string) => void;
  consumePending: () => string | null;
}

export const useUI = create<UIState>(set => ({
  tab: 'chat',
  setTab: (t) => set({ tab: t }),
  paletteOpen: false,
  togglePalette: () => set(s => ({ paletteOpen: !s.paletteOpen })),
  pendingPrompt: null,
  pendingTarget: 'chat',
  branchFromHistory: (prompt) => set({ pendingPrompt: prompt, pendingTarget: 'chat', tab: 'chat' }),
  branchToAssistant: (prompt) => set({ pendingPrompt: prompt, pendingTarget: 'assistant', tab: 'assistant' }),
  consumePending: () => {
    let p: string | null = null;
    set(s => { p = s.pendingPrompt; return { pendingPrompt: null }; });
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
