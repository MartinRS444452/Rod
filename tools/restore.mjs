#!/usr/bin/env node
// Откат древа из файла-копии (data/versions/…). Останавливайте сервер на время работы команды.
//   node tools/restore.mjs list [id-древа]        — список древ и сохранённых версий (новые сверху)
//   node tools/restore.mjs apply <файл.json>      — вернуть древо к состоянию из файла (НОВОЙ ревизией, историю не стирает)
//   node tools/restore.mjs full <rod-backup-….zip> — восстановить ВСЁ из полной копии (tools/backup.mjs); текущая папка data сохраняется рядом
//   node tools/restore.mjs db <файл.db>           — подменить базу копией (старая сохраняется рядом как rod.db.before-restore)
// Папка данных: --data <путь> или переменная DATA_DIR (по умолчанию ./data).
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../lib/store.js';
import { normalizePeople } from '../lib/migrate.js';
import { Snapshots } from '../lib/snapshots.js';
import { readZip } from '../lib/zip.js';

const argv = process.argv.slice(2), flag = n => { const i = argv.indexOf(n); if (i < 0) return null; return argv.splice(i, 2)[1]; };
const data = path.resolve(flag('--data') || process.env.DATA_DIR || './data');
const backupDir = path.resolve(process.env.ROD_BACKUP_DIR || path.join(data, 'versions'));
const [cmd, arg] = argv;
const fail = m => { console.error('Ошибка: ' + m); process.exit(1); };
const fmt = f => { try { const j = JSON.parse(fs.readFileSync(f, 'utf8')); return `${path.basename(f)}  ·  ${Object.keys(j.people || {}).length} чел.  ·  ${j.savedBy || '?'}  ·  ${j.note || ''}`; } catch { return path.basename(f) + '  (повреждён)'; } };

if (cmd === 'list') {
  if (!fs.existsSync(backupDir)) fail('нет папки ' + backupDir);
  const dirs = fs.readdirSync(backupDir).filter(d => d !== 'db' && fs.statSync(path.join(backupDir, d)).isDirectory() && (!arg || d === arg));
  if (!dirs.length) fail('копий не найдено в ' + backupDir);
  for (const d of dirs) {
    const files = fs.readdirSync(path.join(backupDir, d)).filter(f => f.endsWith('.json')).sort().reverse();
    console.log(`\nДрево ${d}  (${files.length} версий)`);
    for (const f of files.slice(0, 30)) console.log('  ' + path.join(backupDir, d, f) + '\n      ' + fmt(path.join(backupDir, d, f)));
    if (files.length > 30) console.log(`  … ещё ${files.length - 30}`);
  }
  const dbs = path.join(backupDir, 'db');
  if (fs.existsSync(dbs) && !arg) console.log('\nКопии базы:\n' + fs.readdirSync(dbs).sort().reverse().map(f => '  ' + path.join(dbs, f)).join('\n'));
} else if (cmd === 'apply') {
  if (!arg || !fs.existsSync(arg)) fail('укажите существующий файл версии');
  let j; try { j = JSON.parse(fs.readFileSync(arg, 'utf8')); } catch (e) { fail('файл повреждён: ' + e.message); }
  if (j.format !== 'rod-tree' || !j.id || !j.people) fail('это не файл-копия «Рода»');
  if (!fs.existsSync(path.join(data, 'rod.db'))) fail('нет базы ' + path.join(data, 'rod.db'));
  const store = new Store(data), snaps = new Snapshots(store, data, process.env);
  store.onCommit = (id, patch) => snaps.onCommit(id, patch);   // сам откат тоже сохраняется файлом
  try {
    if (!store.treeMeta(j.id)) fail(`древо ${j.id} в базе не найдено (возможно, удалено). Загрузите этот файл через «Импорт из архива» — получится новая копия древа.`);
    const people = normalizePeople(j.people, j.id);
    const p = store.restoreState(j.id, 'Восстановление из файла', `Восстановление из файла r${j.rev} (${path.basename(arg)})`, people, j.name);
    console.log(`Готово: древо «${p.name}» возвращено к состоянию r${j.rev}; создана новая ревизия r${p.rev}. Запустите сервер.`);
  } finally { store.close(); }
} else if (cmd === 'full') {
  if (!arg || !fs.existsSync(arg)) fail('укажите существующий файл rod-backup-….zip');
  let zip; try { zip = readZip(fs.readFileSync(arg), { maxTotal: 3.5 * 1024 ** 3, maxFiles: 60000 }); } catch (e) { fail('архив повреждён или не ZIP: ' + e.message); }
  if (!zip.get('manifest.json') || !zip.get('rod.db')) fail('это не полная копия «Рода» (нет manifest.json / rod.db)');
  const entries = [...zip].filter(([n]) => !n.endsWith('/'));
  for (const [n] of entries) if (n.includes('..') || n.startsWith('/') || n.includes('\\') || !/^(rod\.db|media\/|versions\/|manifest\.json$|ЧИТАЙ-МЕНЯ\.txt$)/.test(n)) fail('в архиве неожиданный путь: ' + n);
  let prev = null;
  if (fs.existsSync(data)) { prev = `${data}.before-restore-${Date.now()}`; fs.renameSync(data, prev); }
  try {
    for (const [n, get] of entries) { if (n === 'manifest.json' || n.endsWith('.txt')) continue; const f = path.join(data, n); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, get()); }
    fs.mkdirSync(path.join(data, 'media'), { recursive: true });
  } catch (e) { fs.rmSync(data, { recursive: true, force: true }); if (prev) fs.renameSync(prev, data); fail('не удалось распаковать, данные не тронуты: ' + e.message); }
  const m = JSON.parse(zip.get('manifest.json')().toString('utf8'));
  console.log(`Восстановлено из копии от ${m.createdAt}: древ ${m.trees}, людей ${m.people}, фото ${m.photos}.${prev ? `\nПрежние данные сохранены: ${prev}` : ''}\nЗапустите сервер.`);
} else if (cmd === 'db') {
  if (!arg || !fs.existsSync(arg)) fail('укажите существующий файл копии базы');
  const cur = path.join(data, 'rod.db');
  fs.mkdirSync(data, { recursive: true });
  if (fs.existsSync(cur)) fs.copyFileSync(cur, cur + '.before-restore');
  for (const ext of ['-wal', '-shm']) fs.rmSync(cur + ext, { force: true });
  fs.copyFileSync(arg, cur);
  console.log('База заменена копией. Прежняя сохранена как ' + cur + '.before-restore. Запустите сервер.');
} else {
  console.log(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 7).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(cmd ? 1 : 0);
}
