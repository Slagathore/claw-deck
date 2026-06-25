import { create } from 'zustand';

export interface Workspace { path: string; name: string }

interface WorkspacesState {
  workspaces: Workspace[];
  active: string | null;
  add: (path: string) => void;
  setActive: (path: string) => void;
  remove: (path: string) => void;
}

const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() || p;

/** Open target folders, one per Council tab (locked: multiple open at once). */
export const useWorkspaces = create<WorkspacesState>((set) => ({
  workspaces: [],
  active: null,
  add: (path) => set((s) => s.workspaces.some((w) => w.path === path)
    ? { active: path }
    : { workspaces: [...s.workspaces, { path, name: baseName(path) }], active: path }),
  setActive: (path) => set({ active: path }),
  remove: (path) => set((s) => {
    const workspaces = s.workspaces.filter((w) => w.path !== path);
    return { workspaces, active: s.active === path ? (workspaces[0]?.path ?? null) : s.active };
  }),
}));
