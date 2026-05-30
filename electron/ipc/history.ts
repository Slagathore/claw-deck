import { ipcMain } from 'electron';
import { getDb } from './db';

export function registerHistoryHandlers() {
  ipcMain.handle('history:list', (_e, q?: { search?: string; limit?: number }) => {
    const db = getDb();
    const limit = q?.limit ?? 200;
    if (q?.search) {
      return db
        .prepare('SELECT * FROM history WHERE prompt LIKE ? OR response LIKE ? ORDER BY ts DESC LIMIT ?')
        .all(`%${q.search}%`, `%${q.search}%`, limit);
    }
    return db.prepare('SELECT * FROM history ORDER BY ts DESC LIMIT ?').all(limit);
  });

  ipcMain.handle('history:add', (_e, entry: any) => {
    const db = getDb();
    const info = db
      .prepare(
        `INSERT INTO history(ts,backend,model,prompt,response,thinking,tags,meta)
         VALUES(?,?,?,?,?,?,?,?)`
      )
      .run(
        Date.now(),
        entry.backend ?? 'chat',
        entry.model ?? null,
        entry.prompt ?? '',
        entry.response ?? '',
        entry.thinking ?? '',
        JSON.stringify(entry.tags ?? []),
        JSON.stringify(entry.meta ?? {})
      );
    return info.lastInsertRowid;
  });

  ipcMain.handle('history:delete', (_e, id: number) => {
    getDb().prepare('DELETE FROM history WHERE id = ?').run(id);
    return true;
  });

  ipcMain.handle('history:clear', () => {
    getDb().prepare('DELETE FROM history').run();
    return true;
  });
}
