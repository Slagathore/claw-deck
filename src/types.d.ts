declare global {
  interface Window {
    api: {
      settings: {
        get: () => Promise<any>;
        set: (patch: any) => Promise<boolean>;
      };
      history: {
        list: (q?: { search?: string; limit?: number }) => Promise<any[]>;
        add: (entry: any) => Promise<number>;
        delete: (id: number) => Promise<boolean>;
        clear: () => Promise<boolean>;
      };
      runner: {
        start: (opts: any) => Promise<{ id: string }>;
        stop: (id: string) => Promise<boolean>;
        onEvent: (cb: (e: any) => void) => () => void;
      };
      ollama: {
        listModels: (baseUrl?: string) => Promise<{ models: string[]; error?: string }>;
        ps: (baseUrl?: string) => Promise<{ running: { name: string; size?: number; sizeVram?: number; expiresAt?: number }[]; error?: string }>;
        chat: (req: any) => Promise<{ content: string; thinking?: string; raw?: any }>;
        vision: (req: any) => Promise<{ content: string; raw?: any }>;
        onChunk: (cb: (c: any) => void) => () => void;
      };
      upgrades: {
        check: (kind: 'openclaw' | 'self') => Promise<any>;
        install: (manifest: any) => Promise<any>;
        list: () => Promise<any[]>;
        rollback: (id: number) => Promise<{ ok: boolean; changed?: boolean; reason?: string }>;
      };
      security: {
        scanFile: (file: string) => Promise<any[]>;
        hashFile: (file: string) => Promise<string>;
        auditLog: () => Promise<any[]>;
      };
      screenshot: {
        listSources: () => Promise<any[]>;
        captureScreen: (sourceId?: string) => Promise<{ dataUrl?: string; error?: string; name?: string }>;
        captureRegion: () => Promise<{ dataUrl?: string; error?: string }>;
      };
      app: { pickPath: (opts?: any) => Promise<string | null> };
      prompts: {
        list: () => Promise<{ id: number; name: string; template: string; tags: string; defaults: string; updated_at: number }[]>;
        upsert: (p: { id?: number; name: string; template: string; tags?: string[]; defaults?: Record<string, string> }) => Promise<number>;
        delete: (id: number) => Promise<boolean>;
      };
      mcp: {
        list: () => Promise<{ name: string; command: string; args: string[]; enabled: boolean; status: string; pid?: number; startedAt?: number; exitCode?: number | null; lastError?: string }[]>;
        start: (name: string) => Promise<{ ok: boolean; status?: string; pid?: number; reason?: string }>;
        stop: (name: string) => Promise<{ ok: boolean }>;
        startAll: () => Promise<{ name: string; ok: boolean; status?: string; pid?: number; reason?: string }[]>;
      };
    };
  }
}
export {};
