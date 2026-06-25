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
const STORE_KEY = 'clawdeck:fusion:workspaces';

function loadInitial(): { workspaces: Workspace[]; active: string | null } {
  try {
    const j = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    const workspaces = Array.isArray(j.workspaces) ? j.workspaces.filter((w: any) => typeof w.path === 'string') : [];
    return { workspaces, active: typeof j.active === 'string' ? j.active : (workspaces[0]?.path ?? null) };
  } catch {
    return { workspaces: [], active: null };
  }
}

function persist(workspaces: Workspace[], active: string | null): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ workspaces, active })); } catch { /* ignore */ }
}

const initial = loadInitial();

/** Open target folders, one per Council tab (locked: multiple open at once). */
export const useWorkspaces = create<WorkspacesState>((set) => ({
  workspaces: initial.workspaces,
  active: initial.active,
  add: (path) => set((s) => s.workspaces.some((w) => w.path === path)
    ? (persist(s.workspaces, path), { active: path })
    : (() => { const workspaces = [...s.workspaces, { path, name: baseName(path) }]; persist(workspaces, path); return { workspaces, active: path }; })()),
  setActive: (path) => set((s) => { persist(s.workspaces, path); return { active: path }; }),
  remove: (path) => set((s) => {
    const workspaces = s.workspaces.filter((w) => w.path !== path);
    const active = s.active === path ? (workspaces[0]?.path ?? null) : s.active;
    persist(workspaces, active);
    return { workspaces, active };
  }),
}));
