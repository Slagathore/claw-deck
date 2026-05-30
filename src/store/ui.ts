import { create } from 'zustand';

type Tab = 'chat' | 'history' | 'settings' | 'upgrades' | 'self' | 'security';

interface UIState {
  tab: Tab;
  setTab: (t: Tab) => void;
  paletteOpen: boolean;
  togglePalette: () => void;
}

export const useUI = create<UIState>(set => ({
  tab: 'chat',
  setTab: (t) => set({ tab: t }),
  paletteOpen: false,
  togglePalette: () => set(s => ({ paletteOpen: !s.paletteOpen }))
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
