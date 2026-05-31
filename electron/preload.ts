import { contextBridge, ipcRenderer } from 'electron';

const invoke = (channel: string, ...args: any[]) => ipcRenderer.invoke(channel, ...args);
const on = (channel: string, cb: (...a: any[]) => void) => {
  const listener = (_e: any, ...args: any[]) => cb(...args);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('api', {
  settings: {
    get: () => invoke('settings:get'),
    set: (patch: any) => invoke('settings:set', patch)
  },
  history: {
    list: (q?: any) => invoke('history:list', q),
    add: (entry: any) => invoke('history:add', entry),
    delete: (id: number) => invoke('history:delete', id),
    clear: () => invoke('history:clear')
  },
  runner: {
    start: (opts: any) => invoke('runner:start', opts),
    stop: (id: string) => invoke('runner:stop', id),
    input: (id: string, data: string, raw?: boolean) => invoke('runner:input', id, data, raw),
    resize: (id: string, cols: number, rows: number) => invoke('runner:resize', id, cols, rows),
    onEvent: (cb: (e: any) => void) => on('runner:event', cb)
  },
  ollama: {
    listModels: (baseUrl?: string) => invoke('ollama:listModels', baseUrl),
    ps: (baseUrl?: string) => invoke('ollama:ps', baseUrl),
    chat: (req: any) => invoke('ollama:chat', req),
    vision: (req: any) => invoke('ollama:vision', req),
    pull: (opts: { baseUrl?: string; model: string; id: string }) => invoke('ollama:pull', opts),
    stop: (opts: { baseUrl?: string; model: string }) => invoke('ollama:stop', opts),
    delete: (opts: { baseUrl?: string; model: string }) => invoke('ollama:delete', opts),
    onChunk: (cb: (c: any) => void) => on('ollama:chunk', cb),
    onPullProgress: (cb: (c: any) => void) => on('ollama:pull', cb)
  },
  upgrades: {
    check: (kind: 'openclaw' | 'self') => invoke('upgrades:check', kind),
    install: (manifest: any) => invoke('upgrades:install', manifest),
    list: () => invoke('upgrades:list'),
    rollback: (id: number) => invoke('upgrades:rollback', id)
  },
  security: {
    scanFile: (filePath: string) => invoke('security:scan', filePath),
    hashFile: (filePath: string) => invoke('security:hash', filePath),
    auditLog: () => invoke('security:audit')
  },
  screenshot: {
    listSources: () => invoke('screenshot:sources'),
    captureScreen: (sourceId?: string) => invoke('screenshot:capture', sourceId)
  },
  app: {
    pickPath: (opts?: any) => invoke('app:pickPath', opts ?? {}),
    version: () => invoke('app:version'),
    setCloseToTray: (value: boolean) => invoke('app:setCloseToTray', value),
    quit: () => invoke('app:quit'),
    show: () => invoke('app:show')
  },
  audit: {
    scan: (path: string) => invoke('audit:scan', { path }),
    pickAndScan: () => invoke('audit:pickAndScan')
  },
  extensions: {
    install: (opts: { id: string; kind: 'npm' | 'github' | 'local'; ref: string }) => invoke('extensions:install', opts),
    uninstall: (id: string) => invoke('extensions:uninstall', { id }),
    open: (id: string) => invoke('extensions:open', { id }),
    dir: () => invoke('extensions:dir')
  },
  skills: {
    list: (workspace: string) => invoke('skills:list', { workspace }),
    read: (skillMd: string) => invoke('skills:read', { skillMd }),
    write: (skillMd: string, content: string) => invoke('skills:write', { skillMd, content }),
    create: (workspace: string, slug: string, content: string) => invoke('skills:create', { workspace, slug, content }),
    delete: (dir: string) => invoke('skills:delete', { dir }),
    open: (target: string) => invoke('skills:open', { target })
  },
  prompts: {
    list: () => invoke('prompts:list'),
    upsert: (p: any) => invoke('prompts:upsert', p),
    delete: (id: number) => invoke('prompts:delete', id)
  },
  mcp: {
    list: () => invoke('mcp:list'),
    start: (name: string) => invoke('mcp:start', name),
    stop: (name: string) => invoke('mcp:stop', name),
    startAll: () => invoke('mcp:startAll'),
    stopAll: () => invoke('mcp:stopAll')
  },
  terminal: {
    shells: () => invoke('terminal:shells'),
    launchElevated: (opts: { binary: string; args?: string[]; cwd?: string }) => invoke('terminal:launchElevated', opts)
  },
  selfUpgrade: {
    status: () => invoke('selfUpgrade:status'),
    facts: () => invoke('selfUpgrade:facts'),
    baselineAudit: () => invoke('selfUpgrade:baselineAudit'),
    reflect: (opts: any) => invoke('selfUpgrade:reflect', opts),
    parseManualPatch: (text: string) => invoke('selfUpgrade:parseManualPatch', text),
    run: (opts: any) => invoke('selfUpgrade:run', opts),
    rollback: (snapshotId: string) => invoke('selfUpgrade:rollback', { snapshotId }),
    snapshot: (label?: string) => invoke('selfUpgrade:snapshot', { label }),
    setOrigin: (url: string) => invoke('selfUpgrade:setOrigin', { url }),
    openSourceRoot: () => invoke('selfUpgrade:openSourceRoot'),
    onEvent: (cb: (e: any) => void) => on('selfUpgrade:event', cb)
  }
});
