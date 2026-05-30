import { ipcMain } from 'electron';
import { getDb } from './db';

export interface PromptRow {
  id: number;
  name: string;
  template: string;
  tags: string;
  defaults: string;
  updated_at: number;
}

export function registerPromptHandlers() {
  ipcMain.handle('prompts:list', () => {
    return getDb().prepare('SELECT * FROM prompts ORDER BY name ASC').all();
  });

  ipcMain.handle('prompts:upsert', (_e, p: { id?: number; name: string; template: string; tags?: string[]; defaults?: Record<string, string> }) => {
    const db = getDb();
    const tags = JSON.stringify(p.tags ?? []);
    const defaults = JSON.stringify(p.defaults ?? {});
    const ts = Date.now();
    if (p.id) {
      db.prepare('UPDATE prompts SET name=?, template=?, tags=?, defaults=?, updated_at=? WHERE id=?')
        .run(p.name, p.template, tags, defaults, ts, p.id);
      return p.id;
    }
    const info = db.prepare('INSERT INTO prompts(name,template,tags,defaults,updated_at) VALUES(?,?,?,?,?)')
      .run(p.name, p.template, tags, defaults, ts);
    return info.lastInsertRowid as number;
  });

  ipcMain.handle('prompts:delete', (_e, id: number) => {
    getDb().prepare('DELETE FROM prompts WHERE id=?').run(id);
    return true;
  });
}
