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
    onEvent: (cb: (e: any) => void) => on('runner:event', cb)
  },
  ollama: {
    listModels: (baseUrl?: string) => invoke('ollama:listModels', baseUrl),
    ps: (baseUrl?: string) => invoke('ollama:ps', baseUrl),
    chat: (req: any) => invoke('ollama:chat', req),
    vision: (req: any) => invoke('ollama:vision', req),
    onChunk: (cb: (c: any) => void) => on('ollama:chunk', cb)
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
    captureScreen: (sourceId?: string) => invoke('screenshot:capture', sourceId),
    captureRegion: () => invoke('screenshot:region')
  },
  app: {
    pickPath: (opts?: any) => invoke('app:pickPath', opts ?? {})
  }
});
