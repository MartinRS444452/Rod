#!/usr/bin/env node
// Полная копия «Рода» одним ZIP-файлом: база (все древа, аккаунты, история правок), все фотографии, файлы версий.
//   node tools/backup.mjs [--data ./data] [--out <папка или имя.zip>]
// Можно запускать при работающем сервере: база копируется согласованно (VACUUM INTO), а не простым копированием файла.
// Папка по умолчанию: $ROD_BACKUP_DIR/manual, иначе ~/storage/shared/RodBackups (Termux), иначе текущая.
// Восстановление: node tools/restore.mjs full <файл.zip>   (сервер остановить)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Store } from '../lib/store.js';
import { zipStream } from '../lib/zip.js';
import { prepareBackup, backupName } from '../lib/backup.js';

const argv = process.argv.slice(2), flag = n => { const i = argv.indexOf(n); return i < 0 ? null : argv.splice(i, 2)[1]; };
const data = path.resolve(flag('--data') || process.env.DATA_DIR || './data');
const outArg = flag('--out');
const fail = m => { console.error('Ошибка: ' + m); process.exit(1); };
if (!fs.existsSync(path.join(data, 'rod.db'))) fail('нет базы ' + path.join(data, 'rod.db') + ' (укажите --data)');

const name = backupName();
const home = os.homedir(), shared = path.join(home, 'storage', 'shared', 'RodBackups');
let out;
if (outArg && outArg.endsWith('.zip')) out = path.resolve(outArg);
else {
  const dir = path.resolve(outArg || (process.env.ROD_BACKUP_DIR ? path.join(process.env.ROD_BACKUP_DIR, 'manual') : fs.existsSync(path.join(home, 'storage', 'shared')) ? shared : '.'));
  fs.mkdirSync(dir, { recursive: true }); out = path.join(dir, name);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
if (out.startsWith(data + path.sep)) fail('не сохраняйте копию внутрь папки данных');

const store = new Store(data);
let bk;
try { bk = prepareBackup(store, data); } finally { store.close(); }
const { entries, counts } = bk;
try {
  await pipeline(Readable.from(zipStream(entries)), fs.createWriteStream(out + '.part'));
  fs.renameSync(out + '.part', out);                       // файл появляется под своим именем только когда записан целиком
} catch (e) { fs.rmSync(out + '.part', { force: true }); fail(e.message); }
finally { bk.cleanup(); }
const mb = fs.statSync(out).size / 1048576;
console.log(`Готово: ${out}\n  ${mb.toFixed(mb < 10 ? 1 : 0)} МБ · древ: ${counts.trees}, людей: ${counts.people}, фото: ${counts.photos}, файлов версий: ${counts.versionFiles}`);
