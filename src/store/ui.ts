import { create } from 'zustand';

type Tab = 'chat' | 'cli' | 'history' | 'settings' | 'upgrades' | 'self' | 'security';

interface UIState {
  tab: Tab;
  setTab: (t: Tab) => void;
  paletteOpen: boolean;
  togglePalette: () => void;
  pendingPrompt: string | null;
  branchFromHistory: (prompt: string) => void;
  consumePending: () => string | null;
}

export const useUI = create<UIState>(set => ({
  tab: 'chat',
  setTab: (t) => set({ tab: t }),
  paletteOpen: false,
  togglePalette: () => set(s => ({ paletteOpen: !s.paletteOpen })),
  pendingPrompt: null,
  branchFromHistory: (prompt) => set({ pendingPrompt: prompt, tab: 'chat' }),
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
