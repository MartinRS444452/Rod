import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../server.js';
import { Snapshots } from '../lib/snapshots.js';

const uuid = () => crypto.randomUUID();
const person = (name, o = {}) => ({ id: uuid(), name, maidenName: '', marriages: [], sex: 'm', birth: '', death: '', birthPlace: '', deathPlace: '', school: '', education: '', occupation: '', workplace: '', bio: '', photo: '', parents: [], spouses: [], siblings: [], ...o });
async function boot(env = {}, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-snap-'))) {
  const app = await startServer({ port: 0, dataDir: dir, host: '127.0.0.1', env: { ROD_REGISTRATION: 'open', REG_LIMIT_PER_HOUR: '1000', ...env } });
  const base = `http://127.0.0.1:${app.port}`; let cookie = '';
  const call = async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-rod': '1', 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const reg = await call('POST', '/api/register', { username: 'snap' + uuid().slice(0, 6), password: 'password-123' });
  assert.equal(reg.status, 200);
  const tree = (await call('POST', '/api/trees', { name: 'Копии' })).json.id;
  const save = (people, base0 = 0, note = 'тест') => call('POST', `/api/trees/${tree}/save`, { ops: people.map(p => ({ op: 'put', person: p, base: base0 })), note });
  return { app, dir, call, tree, save, base, cookie: () => cookie };
}
const snapFiles = (dir, tree) => fs.existsSync(path.join(dir, 'versions', tree)) ? fs.readdirSync(path.join(dir, 'versions', tree)).filter(f => f.endsWith('.json')).sort() : [];

test('каждая правка сразу сохраняется отдельным файлом вне базы, в формате tree.json', async () => {
  const { app, dir, call, tree, save } = await boot();
  try {
    const a = person('Иван Родов'), b = person('Пётр Родов', { parents: [a.id] });
    assert.equal((await save([a])).status, 200);
    assert.equal((await save([b])).status, 200);
    assert.equal((await save([{ ...a, bio: 'Часовщик' }], 2)).status, 200);
    const files = snapFiles(dir, tree);
    assert.equal(files.length, 3, 'по файлу на каждую из трёх правок: ' + files.join(','));
    assert.match(files[0], /^r000002_\d{8}-\d{6}_snap/);
    const last = JSON.parse(fs.readFileSync(path.join(dir, 'versions', tree, files[2]), 'utf8'));
    assert.equal(last.format, 'rod-tree'); assert.equal(last.id, tree); assert.equal(last.rev, 4);
    assert.equal(Object.keys(last.people).length, 2); assert.equal(last.people[a.id].bio, 'Часовщик');
    assert.ok(!('r' in last.people[a.id]), 'служебное поле r не попадает в файл');
    const first = JSON.parse(fs.readFileSync(path.join(dir, 'versions', tree, files[0]), 'utf8'));
    assert.equal(Object.keys(first.people).length, 1, 'ранняя версия хранит ранее состояние, а не текущее');
    assert.equal(fs.readdirSync(path.join(dir, 'versions', tree)).filter(f => f.endsWith('.tmp')).length, 0, 'временных файлов не остаётся');
    // файл-копию понимает «Импорт» (как новое древо)
    const imp = await fetch(`http://127.0.0.1:${app.port}/api/trees/import?name=copy`, { method: 'POST', headers: { 'x-rod': '1', cookie: '' }, body: fs.readFileSync(path.join(dir, 'versions', tree, files[2])) });
    assert.equal(imp.status, 401, 'без сессии импорт закрыт (проверка, что файл не открывает доступ)');
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ROD_SNAPSHOTS=0 выключает копии; ROD_BACKUP_DIR переносит их', async () => {
  const off = await boot({ ROD_SNAPSHOTS: '0' });
  try { await off.save([person('A')]); assert.equal(snapFiles(off.dir, off.tree).length, 0); assert.ok(!fs.existsSync(path.join(off.dir, 'versions'))); }
  finally { await off.app.close(); fs.rmSync(off.dir, { recursive: true, force: true }); }
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-ext-'));
  const on = await boot({ ROD_BACKUP_DIR: ext });
  try { await on.save([person('B')]); assert.equal(fs.readdirSync(path.join(ext, on.tree)).length, 1); assert.ok(!fs.existsSync(path.join(on.dir, 'versions'))); }
  finally { await on.app.close(); fs.rmSync(on.dir, { recursive: true, force: true }); fs.rmSync(ext, { recursive: true, force: true }); }
});

test('прореживание: последние N целиком, старше — по одной на день, совсем старые удаляются', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-rot-')), t = path.join(dir, 'versions', 'T'); fs.mkdirSync(t, { recursive: true });
  const mk = (rev, day, time = '120000') => fs.writeFileSync(path.join(t, `r${String(rev).padStart(6, '0')}_${day}-${time}_u.json`), '{}');
  const now = new Date(2026, 9, 31, 12).getTime();
  mk(1, '20240101'); mk(2, '20240101', '130000');                                   // старше keepDays → удалить
  mk(3, '20260901', '090000'); mk(4, '20260901', '180000'); mk(5, '20260902');      // одни сутки — одна запись; ещё сутки
  for (let i = 6; i <= 9; i++) mk(i, '20261030');                                    // «последние»
  const s = new Snapshots({}, dir, { ROD_SNAPSHOT_KEEP: '4', ROD_SNAPSHOT_DAYS: '120' });
  s.rotate(t, now);
  const left = fs.readdirSync(t).map(f => Number(f.slice(1, 7)));
  assert.deepEqual(left, [4, 5, 6, 7, 8, 9], 'остались: последняя за 01.09, единственная за 02.09 и 4 последние');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ежедневная копия базы создаётся, открывается и хранит данные; лишние удаляются', async () => {
  const { app, dir, save } = await boot({ ROD_DB_BACKUPS: '2' });
  try {
    await save([person('База')]);
    const dbDir = path.join(dir, 'versions', 'db');
    assert.equal(fs.readdirSync(dbDir).length, 1, 'копия делается при запуске');
    app.snaps.maybeDbBackup(Date.now() + 86400e3);                       // «наступили следующие сутки» — новая копия уже с данными
    const fresh = fs.readdirSync(dbDir).sort().pop(); assert.match(fresh, /^rod-\d{8}\.db$/);
    const db = new DatabaseSync(path.join(dbDir, fresh));
    assert.ok(db.prepare('SELECT COUNT(*) n FROM users').get().n >= 1); assert.equal(db.prepare('SELECT COUNT(*) n FROM people').get().n, 1); db.close();
    for (const d of [2, 3]) app.snaps.maybeDbBackup(Date.now() + d * 86400e3);
    assert.equal(fs.readdirSync(dbDir).length, 2, 'хранятся только последние 2');
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('откат из файла командой: древо возвращается к версии, история не стирается', async () => {
  const { app, dir, tree, save } = await boot();
  const a = person('Иван Родов'), b = person('Пётр Родов', { parents: [a.id] });
  await save([a]); await save([b]); await save([{ ...a, name: 'Испорчено по ошибке' }], 2);      // r2, r3, r4
  const files = snapFiles(dir, tree), good = path.join(dir, 'versions', tree, files[1]);       // состояние r3
  await app.close();
  const out = execFileSync(process.execPath, ['tools/restore.mjs', 'apply', good, '--data', dir], { encoding: 'utf8' });
  assert.match(out, /возвращено к состоянию r3; создана новая ревизия r5/);
  const list = execFileSync(process.execPath, ['tools/restore.mjs', 'list', tree, '--data', dir], { encoding: 'utf8' });
  assert.ok(list.includes(files[0]) && list.includes(files[2]), 'list показывает версии');
  const app2 = await startServer({ port: 0, dataDir: dir, host: '127.0.0.1', env: { ROD_REGISTRATION: 'open', REG_LIMIT_PER_HOUR: '1000' } });
  try {
    const t = app2.store.treeMeta(tree), people = app2.store.loadPeople(tree);
    assert.equal(t.rev, 5);
    assert.equal(people[a.id].name, 'Иван Родов', 'порча отменена');
    assert.equal(Object.keys(people).length, 2);
    const hist = app2.store.p('SELECT rev,note FROM history WHERE tree_id=? ORDER BY rev').all(tree);
    assert.deepEqual(hist.map(h => h.rev), [2, 3, 4, 5], 'вся история на месте');
    assert.match(hist[3].note, /Восстановление из файла r3/);
    assert.ok(snapFiles(dir, tree).length >= 4, 'откат тоже сохранён отдельной копией (его можно откатить)');
  } finally { await app2.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('откат: чужой/повреждённый файл отклоняется, база подменяется копией с сохранением старой', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-bad-')); fs.writeFileSync(path.join(dir, 'rod.db'), 'старая');
  const bad = path.join(dir, 'bad.json'); fs.writeFileSync(bad, '{"x":1}');
  assert.throws(() => execFileSync(process.execPath, ['tools/restore.mjs', 'apply', bad, '--data', dir], { stdio: 'pipe' }), /не файл-копия/);
  const copy = path.join(dir, 'copy.db'); fs.writeFileSync(copy, 'новая');
  execFileSync(process.execPath, ['tools/restore.mjs', 'db', copy, '--data', dir]);
  assert.equal(fs.readFileSync(path.join(dir, 'rod.db'), 'utf8'), 'новая');
  assert.equal(fs.readFileSync(path.join(dir, 'rod.db.before-restore'), 'utf8'), 'старая');
  fs.rmSync(dir, { recursive: true, force: true });
});

import { zipBuffer, readZip } from '../lib/zip.js';
test('полная копия одним файлом при работающем сервере и восстановление всего (с фото)', async () => {
  const { app, dir, call, tree, save } = await boot();
  const a = person('Иван Родов', { bio: 'Часовщик' });
  await save([a]);
  const photoDir = path.join(dir, 'media', tree); fs.mkdirSync(photoDir, { recursive: true });
  fs.writeFileSync(path.join(photoDir, 'face.jpg'), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
  const out = path.join(dir, '..', 'bk-' + uuid().slice(0, 6)); fs.mkdirSync(out);
  const log = execFileSync(process.execPath, ['tools/backup.mjs', '--data', dir, '--out', out], { encoding: 'utf8' });   // сервер ещё работает
  const zipFile = fs.readdirSync(out).find(f => /^rod-backup-\d{8}-\d{6}\.zip$/.test(f));
  assert.ok(zipFile, log); assert.match(log, /древ: 1, людей: 1, фото: 1/);
  assert.ok(!fs.readdirSync(out).some(f => f.endsWith('.part')), 'временных файлов нет');
  const z = readZip(fs.readFileSync(path.join(out, zipFile)));
  for (const n of ['manifest.json', 'rod.db', `media/${tree}/face.jpg`]) assert.ok(z.get(n), 'в архиве есть ' + n);
  assert.ok([...z].every(([n]) => !n.startsWith('versions/db')), 'ежедневные копии базы не раздувают архив');
  await app.close();
  fs.rmSync(path.join(dir, 'rod.db')); fs.rmSync(path.join(dir, 'media'), { recursive: true });                          // «потеряли телефон»
  const res = execFileSync(process.execPath, ['tools/restore.mjs', 'full', path.join(out, zipFile), '--data', dir], { encoding: 'utf8' });
  assert.match(res, /древ 1, людей 1, фото 1/); assert.match(res, /Прежние данные сохранены/);
  const app2 = await startServer({ port: 0, dataDir: dir, host: '127.0.0.1', env: { ROD_REGISTRATION: 'open', REG_LIMIT_PER_HOUR: '1000' } });
  try {
    assert.equal(app2.store.loadPeople(tree)[a.id].bio, 'Часовщик');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'media', tree, 'face.jpg')), Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    assert.equal(app2.store.userCount(), 1, 'аккаунты тоже вернулись');
  } finally { await app2.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true });
    for (const f of fs.readdirSync(path.dirname(dir))) if (f.startsWith(path.basename(dir) + '.before-restore')) fs.rmSync(path.join(path.dirname(dir), f), { recursive: true, force: true }); }
});
test('восстановление: архив с чужими путями или не от «Рода» отклоняется, данные не трогаются', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-evil-')); fs.mkdirSync(path.join(dir, 'data')); fs.writeFileSync(path.join(dir, 'data', 'rod.db'), 'мои данные');
  const evil = path.join(dir, 'evil.zip');
  fs.writeFileSync(evil, await zipBuffer([{ name: 'manifest.json', data: '{}' }, { name: 'rod.db', data: 'x' }, { name: '../outside.txt', data: 'пробой' }]));
  assert.throws(() => execFileSync(process.execPath, ['tools/restore.mjs', 'full', evil, '--data', path.join(dir, 'data')], { stdio: 'pipe' }), /неожиданный путь/);
  assert.equal(fs.readFileSync(path.join(dir, 'data', 'rod.db'), 'utf8'), 'мои данные'); assert.ok(!fs.existsSync(path.join(dir, 'outside.txt')));
  const foreign = path.join(dir, 'foreign.zip'); fs.writeFileSync(foreign, await zipBuffer([{ name: 'a.txt', data: 'a' }]));
  assert.throws(() => execFileSync(process.execPath, ['tools/restore.mjs', 'full', foreign, '--data', path.join(dir, 'data')], { stdio: 'pipe' }), /не полная копия/);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function second(base, name = 'other' + uuid().slice(0, 5)) {
  const r = await fetch(base + '/api/register', { method: 'POST', headers: { 'x-rod': '1', 'content-type': 'application/json' }, body: JSON.stringify({ username: name, password: 'password-123' }) });
  assert.equal(r.status, 200); return { cookie: r.headers.get('set-cookie').split(';')[0], name };
}
test('кнопка полной копии в приложении: скачивает владелец сервера, остальным отказ', async () => {
  const privTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-privtmp-')), oldTmp = process.env.TMPDIR;
  const { app, dir, base, cookie, tree, save } = await boot();
  process.env.TMPDIR = privTmp;                      // с этого момента временные файлы копии — в своём каталоге: соседние тесты не мешают проверке
  try {
    await save([person('Иван Родов')]);
    const other = await second(base);
    const get = (u, ck) => fetch(base + u, { headers: { 'x-rod': '1', ...(ck ? { cookie: ck } : {}) } });
    assert.equal((await get('/api/admin/backup')).status, 401, 'без входа — нет');
    assert.equal((await (await get('/api/me', cookie())).json()).user.admin, true, 'первый аккаунт — владелец');
    assert.equal((await (await get('/api/me', other.cookie)).json()).user.admin, false);
    const denied = await get('/api/admin/backup', other.cookie);
    assert.equal(denied.status, 403); assert.ok(!(denied.headers.get('content-type') || '').includes('zip'));
    const ok = await get('/api/admin/backup', cookie());
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('content-type'), 'application/zip');
    assert.match(ok.headers.get('content-disposition'), /attachment; filename="rod-backup-\d{8}-\d{6}\.zip"/);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    const z = readZip(Buffer.from(await ok.arrayBuffer()));
    const man = JSON.parse(z.get('manifest.json')().toString());
    assert.equal(man.format, 'rod-backup'); assert.equal(man.users, 2); assert.equal(man.people, 1);
    const f = path.join(dir, 'check.db'); fs.writeFileSync(f, z.get('rod.db')());
    const db = new DatabaseSync(f);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n, 2, 'в копии аккаунты обоих'); assert.equal(db.prepare('SELECT COUNT(*) n FROM people').get().n, 1); db.close();
    assert.deepEqual(fs.readdirSync(privTmp), [], 'временная копия базы удалена');
    assert.equal((await get('/api/admin/backup', cookie())).status, 200, 'после завершения можно снова');
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); if (oldTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = oldTmp; fs.rmSync(privTmp, { recursive: true, force: true }); }
});
test('ROD_ADMINS задаёт владельцев явно', async () => {
  const name = 'boss' + uuid().slice(0, 5);
  const { app, dir, base, cookie } = await boot({ ROD_ADMINS: name });
  try {
    const boss = await second(base, name);
    const me = async ck => (await (await fetch(base + '/api/me', { headers: { 'x-rod': '1', cookie: ck } })).json()).user.admin;
    assert.equal(await me(cookie()), false, 'первый аккаунт больше не владелец, раз список задан');
    assert.equal(await me(boss.cookie), true);
    assert.equal((await fetch(base + '/api/admin/backup', { headers: { 'x-rod': '1', cookie: cookie() } })).status, 403);
    assert.equal((await fetch(base + '/api/admin/backup', { headers: { 'x-rod': '1', cookie: boss.cookie } })).status, 200);
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('assetlinks.json для APK: отдаётся только если файл положен в data/, иначе 404', async () => {
  const { app, dir, base } = await boot();
  try {
    const url = base + '/.well-known/assetlinks.json';
    assert.equal((await fetch(url)).status, 404);
    const body = JSON.stringify([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: 'org.rod.genealogy', sha256_cert_fingerprints: ['AA:BB'] } }]);
    fs.writeFileSync(path.join(dir, 'assetlinks.json'), body);
    const r = await fetch(url); assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /application\/json/); assert.equal(await r.text(), body);
    assert.equal((await fetch(base + '/icons/screenshot-mobile.webp')).headers.get('content-type'), 'image/webp');
    assert.equal((await fetch(base + '/.well-known/../server.js')).status, 404, 'обход путей не работает');
  } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
