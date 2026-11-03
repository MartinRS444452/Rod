// Автоматические файловые копии: КАЖДАЯ правка древа сразу сохраняется отдельным файлом вне базы данных
// (формат такой же, как tree.json в архиве — его понимает и «Импорт», и tools/restore.mjs),
// плюс ежедневная копия самой базы. Это страховка на случай потери/порчи rod.db.
//
// Папка: data/versions (или ROD_BACKUP_DIR — например, общий раздел телефона, переживающий удаление Termux).
// Настройки (переменные окружения):
//   ROD_SNAPSHOTS=0        выключить
//   ROD_BACKUP_DIR=…       куда писать
//   ROD_SNAPSHOT_KEEP=300  сколько последних правок хранить все
//   ROD_SNAPSHOT_DAYS=120  более старые — по одной (последней) на день за столько дней
//   ROD_DB_BACKUPS=14      сколько ежедневных копий базы хранить
import fs from 'node:fs';
import path from 'node:path';

const pad = (n, w = 2) => String(n).padStart(w, '0');
const stamp = ts => { const d = new Date(ts); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; };
const dayOf = ts => stamp(ts).slice(0, 8);
const slug = s => String(s || 'user').replace(/[^\wа-яёіїєґ-]+/gi, '_').slice(0, 24) || 'user';
const stripR = people => Object.fromEntries(Object.entries(people).map(([id, { r, ...p }]) => [id, p])); // eslint-disable-line no-unused-vars

export class Snapshots {
  constructor(store, dataDir, env = process.env) {
    this.store = store;
    this.enabled = env.ROD_SNAPSHOTS !== '0';
    this.dir = path.resolve(env.ROD_BACKUP_DIR || path.join(dataDir, 'versions'));
    this.keepRecent = Math.max(1, Number(env.ROD_SNAPSHOT_KEEP) || 300);
    this.keepDays = Math.max(0, Number(env.ROD_SNAPSHOT_DAYS) || 120);
    this.dbKeep = Math.max(1, Number(env.ROD_DB_BACKUPS) || 14);
    this.lastError = null; this.timer = null;
  }

  /** Вызывается после каждой успешной правки. Ошибки записи не должны ломать сохранение древа. */
  onCommit(treeId, patch) {
    if (!this.enabled) return;
    try {
      const meta = this.store.treeMeta(treeId); if (!meta) return;
      const dir = path.join(this.dir, treeId); fs.mkdirSync(dir, { recursive: true });
      const body = JSON.stringify({ format: 'rod-tree', version: 2, savedAt: new Date(patch.ts).toISOString(), id: treeId, name: patch.name ?? meta.name,
        rev: patch.rev, savedBy: patch.by, note: patch.note, people: stripR(this.store.loadPeople(treeId)) });
      const file = path.join(dir, `r${pad(patch.rev, 6)}_${stamp(patch.ts)}_${slug(patch.by)}.json`), tmp = file + '.tmp';
      fs.writeFileSync(tmp, body); fs.renameSync(tmp, file);   // атомарно: недописанных файлов не бывает
      this.rotate(dir); this.lastError = null;
    } catch (e) { this.lastError = e.message; console.error('snapshots:', e.message); }
  }

  /** Все последние + по одной на день за keepDays; остальное удаляется. */
  rotate(dir, now = Date.now()) {
    const files = fs.readdirSync(dir).filter(f => /^r\d+_\d{8}-\d{6}_.*\.json$/.test(f)).sort();
    const old = files.slice(0, Math.max(0, files.length - this.keepRecent)), lastOfDay = new Map();
    for (const f of old) lastOfDay.set(f.split('_')[1].slice(0, 8), f);          // файлы отсортированы: побеждает последний за день
    const limit = dayOf(now - this.keepDays * 86400e3);
    for (const f of old) {
      const day = f.split('_')[1].slice(0, 8);
      if (lastOfDay.get(day) === f && day >= limit) continue;
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* уже удалён */ }
    }
  }

  /** Раз в сутки — согласованная копия всей базы. */
  maybeDbBackup(now = Date.now()) {
    if (!this.enabled) return;
    try {
      const dir = path.join(this.dir, 'db'); fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `rod-${dayOf(now)}.db`);
      if (!fs.existsSync(file)) this.store.backupTo(file);
      const all = fs.readdirSync(dir).filter(f => /^rod-\d{8}\.db$/.test(f)).sort();
      for (const f of all.slice(0, Math.max(0, all.length - this.dbKeep))) fs.unlinkSync(path.join(dir, f));
    } catch (e) { this.lastError = e.message; console.error('db backup:', e.message); }
  }

  start() {
    if (!this.enabled) return;
    this.maybeDbBackup();
    this.timer = setInterval(() => this.maybeDbBackup(), 3600e3); this.timer.unref();
  }
  stop() { clearInterval(this.timer); }
}
