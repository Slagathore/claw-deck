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
        verifyAuditLog: () => Promise<{ ok: boolean; checked: number; brokenAtId?: number; reason?: string }>;
      };
      screenshot: {
        listSources: () => Promise<any[]>;
        captureScreen: (sourceId?: string) => Promise<{ dataUrl?: string; error?: string; name?: string }>;
      };
      app: {
        pickPath: (opts?: any) => Promise<string | null>;
        version: () => Promise<{ version: string; platform: string; arch: string; closeBehavior?: 'tray' | 'minimize' | 'quit' }>;
        setCloseToTray: (value: boolean) => Promise<{ ok: boolean; closeBehavior: string }>;
        setCloseBehavior: (mode: 'tray' | 'minimize' | 'quit') => Promise<{ ok: boolean; closeBehavior: string }>;
        quit: () => Promise<void>;
        show: () => Promise<{ ok: boolean }>;
        openPath: (target: string) => Promise<{ ok: boolean; reason?: string }>;
        openExternal: (url: string) => Promise<{ ok: boolean; reason?: string }>;
        showItemInFolder: (target: string) => Promise<{ ok: boolean }>;
        which: (binary: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
        traceInfo: () => Promise<{ ok: boolean; path: string }>;
        openTraceLog: () => Promise<{ ok: boolean; path: string; reason?: string }>;
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
      bridge: {
        status: (workspace?: string) => Promise<{ connected: boolean; version?: string; folders?: string[]; matched?: boolean }>;
        diagnostics: (workspace?: string, file?: string) => Promise<{ file: string; line: number; severity: string; message: string; source?: string }[]>;
        selection: (workspace?: string) => Promise<{ file: string; text: string; line: number } | null>;
        lmModels: (workspace?: string) => Promise<{ id: string; vendor?: string; family?: string; name?: string; maxInputTokens?: number }[]>;
        invoke: (model: string, messages: { role: string; content: string }[], workspace?: string) => Promise<string | null>;
        mcp: (workspace?: string) => Promise<{ name: string; command: string; args?: string[] }[]>;
      };
      council: {
        start: (opts: { repo?: string; protocolId: string; assignment: import('../electron/council/agents').SessionAssignment; task: string; context?: string; hot?: { agents?: string[]; temperature?: number; top_p?: number }; prologue?: boolean; personas?: Record<string, string>; forceBlind?: boolean; groundInRepo?: boolean }) => Promise<{ ok: boolean; runId?: string; awaiting?: boolean; error?: string }>;
        methods: () => Promise<{ ok: boolean; methods: { id: string; name: string; use: string; endPrompt: string; budget: string; card: string }[] }>;
        runMethod: (opts: { repo?: string; methodId: string; task: string; focus?: string; context?: string; seed?: { contract?: string; artifacts?: string[]; focus?: string }; groundInRepo?: boolean }) => Promise<{ ok: boolean; runId?: string; error?: string }>;
        methodResult: (runId: string) => Promise<{ ok: boolean; isMethod: boolean; methodId?: string; status?: string; result?: { report?: string; scores?: { agentId: string; verdict: string }[]; warnings?: string[]; findings?: string[]; seed?: { task: string; focus?: string; contract: string; artifacts: string[] }; endPrompt?: string; confidence?: 'high' | 'low'; humanDecision?: string[] } | null }>;
        roleEligibility: () => Promise<{ ok: boolean; rows: { id: string; displayName: string; key: string; eligible: string[]; notEligible: string[]; context: string; maxCalls?: number; optional: boolean }[] }>;
        startLoop: (opts: { repo: string; protocolId: string; assignment: import('../electron/council/agents').SessionAssignment; goal: string; maxIterations?: number; costCeiling?: number; context?: string; hot?: { agents?: string[]; temperature?: number; top_p?: number }; personas?: Record<string, string>; forceBlind?: boolean; methodId?: string; groundInRepo?: boolean }) => Promise<{ ok: boolean; runId?: string; error?: string }>;
        startCampaign: (opts: { repo: string; concept: string; design?: boolean; maxIterations?: number; batchSize?: number; consolidatorId?: string; builderId?: string; lean?: boolean; cycles?: number; context?: string; disableProviders?: string[]; retryLimit?: number }) => Promise<{ ok: boolean; runId?: string; error?: string }>;
        campaignInfo: (runId: string) => Promise<{ ok: boolean; isCampaign: boolean; design?: boolean; repo?: string | null; status?: string; result?: { loop?: string; iterations?: number; stats?: { total: number; done: number; blocked: number; todo: number; question: number; ready: number }; gdd?: string } | null }>;
        campaignReadGdd: (repo: string) => Promise<{ ok: boolean; content: string; stats: { total: number; done: number; blocked: number; todo: number; question: number; ready: number } | null }>;
        campaignWriteGdd: (repo: string, content: string) => Promise<{ ok: boolean; stats?: { total: number; done: number; blocked: number; todo: number; question: number; ready: number }; error?: string }>;
        campaignBibleActive: (runId: string, active: boolean) => Promise<{ ok: boolean }>;
        campaignFlushAck: (runId: string) => Promise<{ ok: boolean }>;
        probeCapabilities: (caps?: string[]) => Promise<{ ok: boolean; probed?: Record<string, Record<string, string>>; error?: string }>;
        answerQuestions: (runId: string, answers: string[]) => Promise<{ ok: boolean; runId?: string; error?: string }>;
        detectEnv: (repo: string) => Promise<{ ok: boolean; facts: string; error?: string }>;
        resume: (runId: string) => Promise<{ ok: boolean; runId?: string; fromPhase?: number; error?: string }>;
        continueBounced: (runId: string, target: 'group' | 'qa', note?: string) => Promise<{ ok: boolean; runId?: string; fromPhase?: number; error?: string }>;
        ask: (runId: string, agentId: string, question: string) => Promise<{ ok: boolean; answer?: string; error?: string }>;
        askRoom: (runId: string, question: string) => Promise<{ ok: boolean; answers: { agentId: string; answer: string }[]; error?: string }>;
        prDescription: (runId: string) => Promise<{ ok: boolean; markdown?: string; error?: string }>;
        snapshots: (runId: string) => Promise<{ ok: boolean; snapshots: { phaseIndex: number; label: string; artifact: string }[] }>;
        events: (runId: string) => Promise<{ ok: boolean; events: import('../store/council').CouncilEvt[] }>;
        salvageBounced: (runId: string, note?: string) => Promise<{ ok: boolean; runId?: string; error?: string }>;
        cancel: (runId: string) => Promise<{ ok: boolean }>;
        list: () => Promise<{ ok: boolean; runs: { runId: string; repo: string | null; protocol: string; task: string; assignment: string; status: string; approved: number; phaseIndex: number | null; resumable: number | null; hasEvents: number; started: number; finished: number | null }[] }>;
        probeAgent: (agent: import('../electron/council/agents').RosterAgent, repo?: string) => Promise<{ ok: boolean; detail: string }>;
        onEvent: (cb: (e: { runId: string; type: string; phase?: string; kind?: string; agentId?: string; content?: string; verdict?: string; round?: number; ok?: boolean; status?: string }) => void) => () => void;
      };
      exec: {
        beginRun: (repo: string, mode?: 'delegate' | 'apply') => Promise<{ ok: boolean; runId?: string; wtDir?: string; branch?: string; error?: string }>;
        proposal: (runId: string, plan: string, diff?: string) => Promise<{ ok: boolean; plan?: string; diff?: string; planPath?: string; diffPath?: string; empty?: boolean; error?: string }>;
        validate: (runId: string) => Promise<{ ok: boolean; result?: import('../electron/selfUpgrade/sandbox').SandboxResult; error?: string }>;
        approve: (runId: string) => Promise<{ ok: boolean; snapshotId?: string; error?: string }>;
        reject: (runId: string) => Promise<{ ok: boolean; error?: string }>;
        list: (limit?: number) => Promise<{ ok: boolean; runs: { run_id: string; repo: string; mode: string; status: string; wt_dir?: string; branch?: string; plan_path?: string; diff_path?: string; diff_bytes: number; validation_ok?: number | null; snapshot_id?: string | null; started: number; updated: number; error?: string | null }[] }>;
        rollback: (snapshotId: string) => Promise<{ ok: boolean; error?: string }>;
      };
      atlas: {
        open: (workspace: string) => Promise<{ ok: boolean; dbPath?: string; mcpServer?: string; error?: string }>;
        index: (workspace: string) => Promise<{ ok: boolean; counts?: import('../electron/atlas/index').IndexCounts; error?: string }>;
        status: (workspace: string) => Promise<{ ok: boolean; counts?: ReturnType<typeof import('../electron/atlas/query').statusCounts>; lastRun?: { started: number; finished: number; files: number; symbols: number; mode: string } | null; vecAvailable?: boolean; error?: string }>;
        query: (workspace: string, tool: string, arg: string) => Promise<{ ok: boolean; result?: any; error?: string }>;
        graph: (workspace: string, statuses?: string[], file?: string, search?: string, limit?: number) => Promise<{ ok: boolean; graph?: { nodes: import('../electron/atlas/query').GraphNode[]; edges: import('../electron/atlas/query').GraphEdge[] }; error?: string }>;
        metrics: (workspace: string) => Promise<{ ok: boolean; churn: Record<string, number>; owner: Record<string, string>; error?: string }>;
        card: (workspace: string, ref: string) => Promise<{ ok: boolean; card?: import('../electron/atlas/types').SymbolCard | null; error?: string }>;
        enrich: (workspace: string, kind: 'embed' | 'summarize') => Promise<{ ok: boolean; embedded?: number; summarized?: number; remaining?: number; superseded?: number; reason?: string }>;
        close: (workspace: string) => Promise<{ ok: boolean }>;
        onEvent: (cb: (e: { kind: string; workspace: string; counts?: import('../electron/atlas/index').IndexCounts; [k: string]: any }) => void) => () => void;
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
        promotedStatus: () => Promise<any>;
        revertPromotion: () => Promise<{ ok: boolean; reverted?: string; note?: string; reason?: string }>;
        dismissRollbackNotice: () => Promise<{ ok: boolean }>;
        relaunch: () => Promise<{ ok: boolean }>;
        onEvent: (cb: (e: any) => void) => () => void;
      };
    };
  }
}
export {};
