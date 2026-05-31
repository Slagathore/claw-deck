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
        start: (opts: any) => Promise<{ id: string; pty?: boolean }>;
        stop: (id: string) => Promise<boolean>;
        input: (id: string, data: string, raw?: boolean) => Promise<boolean>;
        resize: (id: string, cols: number, rows: number) => Promise<boolean>;
        onEvent: (cb: (e: any) => void) => () => void;
      };
      ollama: {
        listModels: (baseUrl?: string) => Promise<{ models: string[]; error?: string }>;
        ps: (baseUrl?: string) => Promise<{ running: { name: string; size?: number; sizeVram?: number; expiresAt?: number }[]; error?: string }>;
        chat: (req: any) => Promise<{ content: string; thinking?: string; raw?: any }>;
        vision: (req: any) => Promise<{ content: string; raw?: any }>;
        pull: (opts: { baseUrl?: string; model: string; id: string }) => Promise<{ ok: boolean; error?: string }>;
        stop: (opts: { baseUrl?: string; model: string }) => Promise<{ ok: boolean; error?: string }>;
        delete: (opts: { baseUrl?: string; model: string }) => Promise<{ ok: boolean; error?: string; status?: number }>;
        onChunk: (cb: (c: any) => void) => () => void;
        onPullProgress: (cb: (c: { id: string; status?: string; completed?: number; total?: number; error?: string }) => void) => () => void;
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
      };
      app: {
        pickPath: (opts?: any) => Promise<string | null>;
        version: () => Promise<{ version: string; platform: string; arch: string; closeToTray?: boolean }>;
        setCloseToTray: (value: boolean) => Promise<{ ok: boolean; closeToTray: boolean }>;
        quit: () => Promise<void>;
        show: () => Promise<{ ok: boolean }>;
      };
      audit: {
        scan: (path: string) => Promise<import('../electron/lib/scanner').AuditReport>;
        pickAndScan: () => Promise<import('../electron/lib/scanner').AuditReport>;
      };
      extensions: {
        install: (opts: { id: string; kind: 'npm' | 'github' | 'local'; ref: string }) => Promise<{ ok: boolean; path?: string; report?: import('../electron/lib/scanner').AuditReport; reason?: string }>;
        uninstall: (id: string) => Promise<{ ok: boolean; reason?: string }>;
        open: (id: string) => Promise<{ ok: boolean; path?: string }>;
        dir: () => Promise<string>;
      };
      skills: {
        list: (workspace: string) => Promise<{ ok: boolean; skills?: { slug: string; name: string; description: string; dir: string; skillMd: string; hasScripts: boolean }[]; reason?: string }>;
        read: (skillMd: string) => Promise<{ ok: boolean; content?: string; reason?: string }>;
        write: (skillMd: string, content: string) => Promise<{ ok: boolean; reason?: string }>;
        create: (workspace: string, slug: string, content: string) => Promise<{ ok: boolean; dir?: string; skillMd?: string; reason?: string }>;
        delete: (dir: string) => Promise<{ ok: boolean; reason?: string }>;
        open: (target: string) => Promise<{ ok: boolean }>;
        scanRegistry: (slug: string, clawhubPath?: string) => Promise<{ ok: boolean; report?: import('../electron/lib/scanner').AuditReport; reason?: string }>;
      };
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
        stopAll: () => Promise<{ stopped: number }>;
      };
      terminal: {
        shells: () => Promise<{ id: string; label: string; binary: string; args: string[]; available: boolean }[]>;
        launchElevated: (opts: { binary: string; args?: string[]; cwd?: string }) => Promise<{ ok: boolean; pid?: number; reason?: string }>;
      };
      selfUpgrade: {
        status: () => Promise<any>;
        facts: () => Promise<any>;
        baselineAudit: () => Promise<any>;
        reflect: (opts: any) => Promise<any>;
        parseManualPatch: (text: string) => Promise<any>;
        run: (opts: any) => Promise<any>;
        rollback: (snapshotId: string) => Promise<{ ok: boolean; reason?: string }>;
        snapshot: (label?: string) => Promise<{ ok: boolean; snapshot?: any; reason?: string }>;
        setOrigin: (url: string) => Promise<{ ok: boolean; reason?: string }>;
        openSourceRoot: () => Promise<{ ok: boolean; path: string }>;
        onEvent: (cb: (e: any) => void) => () => void;
      };
    };
  }
}
export {};
