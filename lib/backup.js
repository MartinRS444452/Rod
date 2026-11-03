// Полная копия «Рода» одним ZIP: база (все древа, аккаунты, история), все фото, файлы версий.
// Используется и командой tools/backup.mjs, и кнопкой в приложении (только для владельца сервера).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const pad = n => String(n).padStart(2, '0');
export const backupName = (d = new Date()) =>
  `rod-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.zip`;

/** Готовит список записей для zipStream. База копируется согласованно (VACUUM INTO) — можно при работающем сервере. cleanup() обязателен. */
export function prepareBackup(store, dataDir, now = new Date()) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-bk-')), dbCopy = path.join(tmp, 'rod.db');
  const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
  try {
    store.backupTo(dbCopy);
    const counts = { users: store.userCount(), trees: store.db.prepare('SELECT COUNT(*) n FROM trees').get().n, people: store.db.prepare('SELECT COUNT(*) n FROM people').get().n };
    const entries = [{ name: 'rod.db', file: dbCopy }];
    const walk = (rel, skip = () => false) => {
      const abs = path.join(dataDir, rel); if (!fs.existsSync(abs)) return;
      for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
        const r = path.posix.join(rel, e.name);
        if (skip(r)) continue;
        if (e.isDirectory()) walk(r, skip); else if (e.isFile() && !e.name.endsWith('.tmp')) entries.push({ name: r, file: path.join(dataDir, r) });
      }
    };
    walk('media'); walk('versions', r => r === 'versions/db');           // ежедневные копии базы в архив не кладём — там уже свежая
    counts.photos = entries.filter(e => e.name.startsWith('media/')).length;
    counts.versionFiles = entries.filter(e => e.name.startsWith('versions/')).length;
    entries.unshift({ name: 'manifest.json', data: JSON.stringify({ format: 'rod-backup', version: 1, createdAt: now.toISOString(), ...counts }, null, 2) },
      { name: 'ЧИТАЙ-МЕНЯ.txt', data: 'Полная копия «Рода».\nВосстановление: остановите сервер, затем в папке проекта:\n  node tools/restore.mjs full <этот файл>.zip\nТекущие данные не удаляются: папка data переименуется в data.before-restore-…\n' });
    return { entries, counts, name: backupName(now), cleanup };
  } catch (e) { cleanup(); throw e; }
}
