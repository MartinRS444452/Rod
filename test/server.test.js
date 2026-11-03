import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import WebSocket from 'ws';
import sharp from 'sharp';
import { startServer } from '../server.js';
import { readZip } from '../lib/zip.js';

let app, base, dir;
const uuid = () => crypto.randomUUID();

class Client {
  constructor() { this.cookie = ''; }
  async req(method, url, body, o = {}) {
    const h = { ...(o.noCsrf ? {} : { 'x-rod': '1' }), ...(o.headers || {}) };
    if (this.cookie) h.cookie = this.cookie;
    let b;
    if (o.raw) b = o.raw; else if (body !== undefined) { h['content-type'] = 'application/json'; b = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers: h, body: b, redirect: 'manual' });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const buf = Buffer.from(await r.arrayBuffer());
    let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* не JSON */ }
    return { status: r.status, headers: r.headers, json, buf };
  }
  get(u, o) { return this.req('GET', u, undefined, o); }
  post(u, b, o) { return this.req('POST', u, b ?? {}, o); }
}
const person = (name, o = {}) => ({ id: uuid(), name, maidenName: '', marriages: [], sex: 'm', birth: '', death: '', birthPlace: '', deathPlace: '', school: '', education: '', occupation: '', workplace: '', bio: '', photo: '', parents: [], spouses: [], siblings: [], ...o });
const put = (p, base = 0) => ({ op: 'put', person: p, base });
async function register(name) { const c = new Client(); const r = await c.post('/api/register', { username: name, password: 'password-123' }); assert.equal(r.status, 200, JSON.stringify(r.json)); return c; }
async function newTree(c, name = 'Тест') { const r = await c.post('/api/trees', { name }); assert.equal(r.status, 200); return r.json.id; }
const save = (c, id, ops, extra = {}) => c.post(`/api/trees/${id}/save`, { ops, ...extra });

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-test-'));
  app = await startServer({ port: 0, dataDir: dir, host: '127.0.0.1', env: { ROD_REGISTRATION: 'open', REG_LIMIT_PER_HOUR: '1000' } });
  base = `http://127.0.0.1:${app.port}`;
});
after(async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); });

test('статика и заголовки безопасности; healthz', async () => {
  const c = new Client();
  const r = await c.get('/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await c.get('/js/layout.js')).status, 200);
  assert.equal((await c.get('/../server.js')).status, 404);
  assert.equal((await c.get('/%2e%2e/server.js')).status, 404);
  assert.equal((await c.get('/lib/store.js')).status, 404, 'код сервера недоступен');
  const gz = await fetch(base + '/js/layout.js', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(gz.headers.get('content-encoding'), 'gzip');
  assert.equal((await c.get('/healthz')).json.ok, true);
});

test('регистрация, вход, куки HttpOnly, CSRF и защита API', async () => {
  const c = new Client();
  assert.equal((await c.get('/api/me')).status, 401);
  assert.equal((await c.post('/api/register', { username: 'ab', password: 'password-123' })).status, 400);
  assert.equal((await c.post('/api/register', { username: 'anna', password: 'short' })).status, 400);
  const noCsrf = await c.req('POST', '/api/register', { username: 'anna', password: 'password-123' }, { noCsrf: true });
  assert.equal(noCsrf.status, 403, 'без X-Rod запрос отклоняется');
  const evil = await c.req('POST', '/api/register', { username: 'anna', password: 'password-123' }, { headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403, 'чужой Origin отклоняется');
  const ok = await fetch(base + '/api/register', { method: 'POST', headers: { 'x-rod': '1', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'Anna', password: 'password-123' }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Lax/); assert.doesNotMatch(cookie, /Secure/);
  assert.equal((await c.post('/api/register', { username: 'anna', password: 'password-123' })).status, 409, 'логин без учёта регистра');
  const l = await c.post('/api/login', { username: 'ANNA', password: 'password-123' });
  assert.equal(l.status, 200);
  assert.equal((await c.get('/api/me')).json.user.username, 'Anna');
  await c.post('/api/logout');
  assert.equal((await c.get('/api/me')).status, 401);
  // Secure при HTTPS за прокси включается только по настройке
  const bad = await new Client().post('/api/login', { username: 'anna', password: 'wrong-password' });
  assert.equal(bad.status, 401);
});

test('токены сессий в БД хранятся только в виде хеша', async () => {
  const c = await register('hasher');
  const token = c.cookie.split('=')[1];
  const rows = app.store.db.prepare('SELECT token_hash FROM sessions').all().map(r => r.token_hash);
  assert.ok(!rows.includes(token));
  assert.ok(rows.includes(crypto.createHash('sha256').update(token).digest('hex')));
});

test('ограничение попыток входа (брутфорс)', async () => {
  await register('victim');
  const c = new Client(); let last;
  for (let i = 0; i < 9; i++) last = await c.post('/api/login', { username: 'victim', password: 'nope-nope-' + i });
  assert.equal(last.status, 429);
  assert.equal((await c.post('/api/login', { username: 'victim', password: 'password-123' })).status, 429, 'и правильный пароль блокируется на время окна');
});

test('создание людей, симметрия связей и УДАЛЕНИЕ связи супруга', async () => {
  const c = await register('rel1'); const id = await newTree(c);
  const a = person('Иван'), b = person('Мария', { sex: 'f', spouses: [a.id] });
  let r = await save(c, id, [put(a), put(b)]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  let t = (await c.get(`/api/trees/${id}`)).json;
  assert.deepEqual(t.people[a.id].spouses, [b.id], 'у Ивана супруга добавилась автоматически');
  // убираем супруга у Марии → должен исчезнуть и у Ивана (баг №2 из разбора)
  r = await save(c, id, [put({ ...t.people[b.id], spouses: [] }, t.people[b.id].r)]);
  assert.equal(r.status, 200);
  t = (await c.get(`/api/trees/${id}`)).json;
  assert.deepEqual(t.people[a.id].spouses, []);
  assert.deepEqual(t.people[b.id].spouses, []);
  assert.equal(t.rev, 3);
  // братья/сёстры тоже симметричны
  const x = person('Пётр', { siblings: [a.id] });
  await save(c, id, [put(x)]);
  t = (await c.get(`/api/trees/${id}`)).json;
  assert.deepEqual(t.people[a.id].siblings, [x.id]);
});

test('без реальных изменений ревизия не создаётся', async () => {
  const c = await register('noop1'); const id = await newTree(c);
  const a = person('Иван');
  await save(c, id, [put(a)]);
  const t = (await c.get(`/api/trees/${id}`)).json;
  const r = await save(c, id, [put(t.people[a.id], t.people[a.id].r)]);
  assert.equal(r.json.noop, true);
  assert.equal((await c.get(`/api/trees/${id}`)).json.rev, t.rev);
});

test('слияние: параллельные правки РАЗНЫХ людей не конфликтуют, одного — 409', async () => {
  const c = await register('merge1'); const id = await newTree(c);
  const a = person('Иван'), b = person('Мария', { sex: 'f' });
  await save(c, id, [put(a), put(b)]);
  const t0 = (await c.get(`/api/trees/${id}`)).json;
  const pa = t0.people[a.id], pb = t0.people[b.id];
  // «устройство 1» правит Ивана, «устройство 2» (старая ревизия) правит Марию
  assert.equal((await save(c, id, [put({ ...pa, occupation: 'Часовщик' }, pa.r)])).status, 200);
  const r2 = await save(c, id, [put({ ...pb, occupation: 'Учитель' }, pb.r)]);
  assert.equal(r2.status, 200, 'правка другой карточки проходит поверх чужой ревизии');
  // а вот вторая правка Ивана со старой базой — конфликт именно по нему
  const r3 = await save(c, id, [put({ ...pa, occupation: 'Врач' }, pa.r)]);
  assert.equal(r3.status, 409);
  assert.deepEqual(r3.json.conflicts, [a.id]);
  const t = (await c.get(`/api/trees/${id}`)).json;
  assert.equal(t.people[a.id].occupation, 'Часовщик'); assert.equal(t.people[b.id].occupation, 'Учитель');
  // удаление изменённой кем-то карточки со старой базой — тоже конфликт
  assert.equal((await c.post(`/api/trees/${id}/save`, { ops: [{ op: 'del', id: a.id, base: pa.r }] })).status, 409);
  // атомарность: конфликт в пачке откатывает всё
  const fresh = person('Новый');
  const rr = await save(c, id, [put(fresh), put({ ...pa, bio: 'x' }, pa.r)]);
  assert.equal(rr.status, 409);
  assert.equal((await c.get(`/api/trees/${id}`)).json.people[fresh.id], undefined);
});

test('валидация: поля, фото-URL, циклы родства, чужие id', async () => {
  const c = await register('valid1'); const id = await newTree(c);
  assert.equal((await save(c, id, [put(person(''))])).status, 400);
  assert.equal((await save(c, id, [put(person('X'.repeat(121)))])).status, 400);
  assert.equal((await save(c, id, [put(person('Ок', { birth: '<script>' }))])).status, 400);
  assert.equal((await save(c, id, [put({ ...person('Ок'), id: 'bad id!' })])).status, 400);
  assert.equal((await save(c, id, [put(person('Ок', { parents: ['не-uuid'] }))])).status, 400);
  assert.equal((await save(c, id, [{ op: 'rm', id: 'x' }])).status, 400);
  assert.equal((await save(c, id, [])).status, 400);
  const evil = person('Фото', { photo: 'https://evil.example/x.jpg' });
  await save(c, id, [put(evil)]);
  assert.equal((await c.get(`/api/trees/${id}`)).json.people[evil.id].photo, '', 'внешний URL фото отбрасывается');
  const other = person('Чужое', { photo: '/media/00000000-0000-0000-0000-000000000000/a.jpg' });
  await save(c, id, [put(other)]);
  assert.equal((await c.get(`/api/trees/${id}`)).json.people[other.id].photo, '', 'фото из чужого древа отбрасывается');
  const g = person('Дед'), f = person('Отец', { parents: [g.id] });
  await save(c, id, [put(g), put(f)]);
  const t = (await c.get(`/api/trees/${id}`)).json;
  const cyc = await save(c, id, [put({ ...t.people[g.id], parents: [f.id] }, t.people[g.id].r)]);
  assert.equal(cyc.status, 400, 'дед не может быть ребёнком собственного сына');
  const dangling = person('Висит', { parents: [uuid()], spouses: [uuid()] });
  await save(c, id, [put(dangling)]);
  const d = (await c.get(`/api/trees/${id}`)).json.people[dangling.id];
  assert.deepEqual([d.parents, d.spouses], [[], []], 'ссылки на несуществующих убираются');
  const x = person('Страннаяполя'); x.isAdmin = true; x.__proto__ = { evil: 1 };
  await save(c, id, [put(x)]);
  assert.equal((await c.get(`/api/trees/${id}`)).json.people[x.id].isAdmin, undefined);
});

test('предок/потомок не может быть супругом или братом/сестрой', async () => {
  const c = await register('anc1'); const id = await newTree(c);
  const g = person('Дед'), f = person('Отец', { parents: [g.id] }), k = person('Внук', { parents: [f.id] });
  await save(c, id, [put(g), put(f), put(k)]);
  const t = (await c.get(`/api/trees/${id}`)).json;
  const r1 = await save(c, id, [put({ ...t.people[f.id], siblings: [g.id] }, t.people[f.id].r)]);
  assert.equal(r1.status, 400); assert.match(r1.json.error, /Дед.*прямой предок или потомок.*братом\/сестрой/);
  assert.equal((await save(c, id, [put({ ...t.people[g.id], spouses: [k.id] }, t.people[g.id].r)])).status, 400, 'внук не может быть супругом деда');
  assert.equal((await c.get(`/api/trees/${id}`)).json.rev, t.rev, 'ничего не записано');
});

test('девичья фамилия сохраняется; даты свадьбы зеркалятся у супругов и чистятся', async () => {
  const c = await register('wed1'); const id = await newTree(c);
  const h = person('Иван'), w = person('Анна Соколова', { sex: 'f', maidenName: 'Иванова', spouses: [h.id] });
  await save(c, id, [put(h), put(w)]);
  let t = (await c.get(`/api/trees/${id}`)).json;
  assert.equal(t.people[w.id].maidenName, 'Иванова');
  // дата свадьбы, внесённая у жены, появляется и у мужа
  let r = await save(c, id, [put({ ...t.people[w.id], marriages: [{ with: h.id, date: '14.06.1958' }] }, t.people[w.id].r)]);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  t = (await c.get(`/api/trees/${id}`)).json;
  assert.deepEqual(t.people[h.id].marriages, [{ with: w.id, date: '14.06.1958' }]);
  assert.deepEqual(t.people[w.id].marriages, [{ with: h.id, date: '14.06.1958' }]);
  // исправление даты у мужа обновляет жену
  await save(c, id, [put({ ...t.people[h.id], marriages: [{ with: w.id, date: '15.06.1958' }] }, t.people[h.id].r)]);
  t = (await c.get(`/api/trees/${id}`)).json;
  assert.equal(t.people[w.id].marriages[0].date, '15.06.1958');
  // очистка даты у одного — исчезает у обоих
  await save(c, id, [put({ ...t.people[h.id], marriages: [] }, t.people[h.id].r)]);
  t = (await c.get(`/api/trees/${id}`)).json;
  assert.deepEqual([t.people[h.id].marriages, t.people[w.id].marriages], [[], []]);
  // развод (убрали супруга) — дата не остаётся «висеть»
  await save(c, id, [put({ ...t.people[h.id], marriages: [{ with: w.id, date: '1958' }] }, t.people[h.id].r)]);
  t = (await c.get(`/api/trees/${id}`)).json;
  await save(c, id, [put({ ...t.people[h.id], spouses: [], marriages: [{ with: w.id, date: '1958' }] }, t.people[h.id].r)]);
  t = (await c.get(`/api/trees/${id}`)).json;
  assert.deepEqual([t.people[h.id].spouses, t.people[h.id].marriages, t.people[w.id].spouses, t.people[w.id].marriages], [[], [], [], []]);
  // удаление супруга чистит дату у оставшегося
  await save(c, id, [put({ ...t.people[h.id], spouses: [w.id], marriages: [{ with: w.id, date: '1958' }] }, t.people[h.id].r)]);
  t = (await c.get(`/api/trees/${id}`)).json;
  await c.post(`/api/trees/${id}/save`, { ops: [{ op: 'del', id: w.id, base: t.people[w.id].r }] });
  t = (await c.get(`/api/trees/${id}`)).json;
  assert.deepEqual(t.people[h.id].marriages, []);
  // валидация
  const bad = await save(c, id, [put({ ...t.people[h.id], spouses: [], marriages: [{ with: uuid(), date: '<b>' }] }, t.people[h.id].r)]);
  assert.equal(bad.status, 400);
  assert.equal((await save(c, id, [put(person('Х', { maidenName: 'Я'.repeat(121) }))])).status, 400);
});

test('старые записи без новых полей не порождают фиктивных правок', async () => {
  const c = await register('oldrows'); const id = await newTree(c);
  const a = person('Старый'); await save(c, id, [put(a)]);
  // эмулируем запись, сделанную версией до появления полей
  const row = app.store.db.prepare('SELECT data FROM people WHERE tree_id=? AND id=?').get(id, a.id), o = JSON.parse(row.data);
  delete o.maidenName; delete o.marriages;
  app.store.db.prepare('UPDATE people SET data=? WHERE tree_id=? AND id=?').run(JSON.stringify(o), id, a.id);
  const t = (await c.get(`/api/trees/${id}`)).json;
  assert.equal(t.people[a.id].maidenName, ''); assert.deepEqual(t.people[a.id].marriages, []);
  const r = await save(c, id, [put(t.people[a.id], t.people[a.id].r)]);
  assert.equal(r.json.noop, true, 'повторное сохранение без изменений — не ревизия');
});

test('удаление человека чистит ссылки; история и откат (в т.ч. имени древа)', async () => {
  const c = await register('hist1'); const id = await newTree(c, 'Исходное');
  const a = person('Иван'), b = person('Мария', { sex: 'f', spouses: [a.id] }), k = person('Ребёнок', { parents: [a.id, b.id] });
  await save(c, id, [put(a), put(b), put(k)], { note: 'Первичный ввод' });                  // r2
  let t = (await c.get(`/api/trees/${id}`)).json;
  await save(c, id, [put({ ...t.people[a.id], bio: 'Часовщик' }, t.people[a.id].r)], { name: 'Переименовано' }); // r3
  t = (await c.get(`/api/trees/${id}`)).json;
  assert.equal(t.name, 'Переименовано');
  await c.post(`/api/trees/${id}/save`, { ops: [{ op: 'del', id: a.id, base: t.people[a.id].r }] });             // r4
  t = (await c.get(`/api/trees/${id}`)).json;
  assert.equal(t.people[a.id], undefined);
  assert.deepEqual(t.people[b.id].spouses, []); assert.deepEqual(t.people[k.id].parents, [b.id]);
  const h = (await c.get(`/api/trees/${id}/history`)).json;
  assert.deepEqual(h.items.map(i => i.rev), [4, 3, 2]);
  assert.equal(h.items[0].changes.find(x => x.kind === 'del').name, 'Иван');
  assert.equal(h.items[0].author, 'rel1' === 'x' ? '' : 'hist1');
  assert.equal(h.items[2].note, 'Первичный ввод');
  // откат к r2: Иван возвращается со всеми связями, имя древа — прежнее
  const rs = await c.post(`/api/trees/${id}/restore`, { rev: 2 });
  assert.equal(rs.status, 200, JSON.stringify(rs.json));
  t = (await c.get(`/api/trees/${id}`)).json;
  assert.equal(t.rev, 5); assert.equal(t.name, 'Исходное');
  assert.equal(t.people[a.id].bio, ''); assert.deepEqual(t.people[a.id].spouses, [b.id]);
  assert.deepEqual(t.people[k.id].parents.sort(), [a.id, b.id].sort());
  const h2 = (await c.get(`/api/trees/${id}/history`)).json.items;
  assert.equal(h2.length, 4, 'история не стирается: откат — новая ревизия');
  assert.match(h2[0].note, /Восстановление версии r2/);
  // откат вперёд к r4 (то, что было «до отката»)
  assert.equal((await c.post(`/api/trees/${id}/restore`, { rev: 4 })).status, 200);
  assert.equal((await c.get(`/api/trees/${id}`)).json.people[a.id], undefined);
  assert.equal((await c.post(`/api/trees/${id}/restore`, { rev: 999 })).status, 400);
  assert.equal((await c.post(`/api/trees/${id}/restore`, { rev: 6 })).status, 400, 'текущая версия');
});

test('ограничение глубины истории: слишком старая версия не восстанавливается', async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-hl-'));
  const app2 = await startServer({ port: 0, dataDir: dir2, host: '127.0.0.1', env: { HISTORY_LIMIT: '3', ROD_REGISTRATION: 'open', REG_LIMIT_PER_HOUR: '1000' } });
  const b0 = base; base = `http://127.0.0.1:${app2.port}`;
  try {
    const c = await register('lim1'); const id = await newTree(c);
    const a = person('A'); await save(c, id, [put(a)]);
    for (let i = 0; i < 5; i++) { const t = (await c.get(`/api/trees/${id}`)).json; await save(c, id, [put({ ...t.people[a.id], bio: 'v' + i }, t.people[a.id].r)]); }
    assert.equal((await c.get(`/api/trees/${id}/history`)).json.items.length, 3);
    assert.equal((await c.post(`/api/trees/${id}/restore`, { rev: 2 })).status, 410);
    assert.equal((await c.post(`/api/trees/${id}/restore`, { rev: 4 })).status, 200);
  } finally { base = b0; await app2.close(); fs.rmSync(dir2, { recursive: true, force: true }); }
});

test('права: чужое древо недоступно, приглашение/исключение, только владелец удаляет', async () => {
  const owner = await register('own1'), guest = await register('guest1'), stranger = await register('stranger1');
  const id = await newTree(owner);
  assert.equal((await stranger.get(`/api/trees/${id}`)).status, 403);
  assert.equal((await stranger.post(`/api/trees/${id}/save`, { ops: [put(person('Хакер'))] })).status, 403);
  assert.equal((await owner.post(`/api/trees/${id}/share`, { username: 'nobody-here' })).status, 404);
  assert.equal((await owner.post(`/api/trees/${id}/share`, { username: 'own1' })).status, 400);
  assert.equal((await guest.post(`/api/trees/${id}/share`, { username: 'stranger1' })).status, 403);
  const sh = await owner.post(`/api/trees/${id}/share`, { username: 'GUEST1' });
  assert.deepEqual(sh.json.collaborators.map(x => x.username), ['guest1']);
  assert.equal((await guest.get(`/api/me`)).json.trees.length, 1);
  const p = person('Гость добавил');
  assert.equal((await save(guest, id, [put(p)])).status, 200);
  assert.equal((await guest.req('DELETE', `/api/trees/${id}`)).status, 403);
  const uid = sh.json.collaborators[0].id;
  await owner.post(`/api/trees/${id}/unshare`, { userId: uid });
  assert.equal((await guest.get(`/api/trees/${id}`)).status, 403);
  assert.equal((await owner.req('DELETE', `/api/trees/${id}`)).status, 200);
  assert.equal((await owner.get(`/api/trees/${id}`)).status, 403);
});

test('смена пароля: старый нужен, другие сессии закрываются', async () => {
  const a = await register('pw1'), b = new Client();
  await b.post('/api/login', { username: 'pw1', password: 'password-123' });
  assert.equal((await a.post('/api/password', { oldPassword: 'wrong', newPassword: 'new-password-1' })).status, 403);
  assert.equal((await a.post('/api/password', { oldPassword: 'password-123', newPassword: 'short' })).status, 400);
  assert.equal((await a.post('/api/password', { oldPassword: 'password-123', newPassword: 'new-password-1' })).status, 200);
  assert.equal((await a.get('/api/me')).status, 200, 'текущая сессия жива');
  assert.equal((await b.get('/api/me')).status, 401, 'остальные закрыты');
  assert.equal((await new Client().post('/api/login', { username: 'pw1', password: 'password-123' })).status, 401);
  assert.equal((await new Client().post('/api/login', { username: 'pw1', password: 'new-password-1' })).status, 200);
});

test('фото: загрузка оригинала без потерь, миниатюры, проверка содержимого и прав', async () => {
  const c = await register('photo1'), other = await register('photo2'); const id = await newTree(c);
  const png = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#cc3333' } }).png().toBuffer();
  const up = await c.req('POST', `/api/trees/${id}/photo`, undefined, { raw: png, headers: { 'content-type': 'image/png' } });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  const url = up.json.url; assert.match(url, new RegExp(`^/media/${id}/[\\w-]+\\.png$`));
  const orig = await c.get(url);
  assert.equal(orig.status, 200); assert.ok(orig.buf.equals(png), 'оригинал байт-в-байт');
  assert.match(orig.headers.get('cache-control'), /immutable/);
  const th = await c.get(url.replace('/media/', '/thumb/') + '?s=s');
  assert.equal(th.headers.get('content-type'), 'image/webp');
  const meta = await sharp(th.buf).metadata();
  assert.deepEqual([meta.width, meta.height], [360, 360]);
  const md = await sharp((await c.get(url.replace('/media/', '/thumb/') + '?s=m')).buf).metadata();
  assert.equal(md.width, 1280);
  assert.equal((await other.get(url)).status, 403);
  assert.equal((await other.get(url.replace('/media/', '/thumb/'))).status, 403);
  assert.equal((await new Client().get(url)).status, 401);
  const notImg = await c.req('POST', `/api/trees/${id}/photo`, undefined, { raw: Buffer.from('<?php evil ?>'), headers: { 'content-type': 'image/png' } });
  assert.equal(notImg.status, 400);
  const svg = await c.req('POST', `/api/trees/${id}/photo`, undefined, { raw: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), headers: { 'content-type': 'image/jpeg' } });
  assert.equal(svg.status, 400, 'SVG под видом JPEG не принимается');
  const p = person('С фото', { photo: url });
  await save(c, id, [put(p)]);
  assert.equal((await c.get(`/api/trees/${id}`)).json.people[p.id].photo, url);
  assert.equal((await c.get(`/media/${id}/..%2F..%2Frod.db`)).status, 404);
});

test('экспорт: валидный ZIP, рабочие [[ссылки]] Obsidian, фото, офлайн-страница; импорт возвращает то же древо', async () => {
  const c = await register('exp1'); const id = await newTree(c, 'Род Тестовых');
  const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#3366cc' } }).png().toBuffer();
  const up = await c.req('POST', `/api/trees/${id}/photo`, undefined, { raw: png });
  const a = person('Иван Тестов', { birth: '12.05.1902', death: '1978', birthPlace: 'Тверь', school: 'Гимназия №1', education: 'Часовое училище', occupation: 'Часовщик', workplace: 'Мастерская', bio: 'Строка 1\nСтрока 2 [[не-ссылка]]', photo: up.json.url });
  const b = person('Мария "Маша" Тестова', { sex: 'f', birth: '1905', maidenName: 'Кузнецова', spouses: [a.id], marriages: [{ with: a.id, date: '14.06.1925' }] });
  const k = person('Пётр <b>Тестов</b>', { parents: [a.id, b.id], birth: '1930' });
  const s = person('Сестра Пётра', { sex: 'f', parents: [a.id, b.id] });
  assert.equal((await save(c, id, [put(a), put(b), put(k), put(s)])).status, 200);
  const tree = (await c.get(`/api/trees/${id}`)).json;
  const r = await c.get(`/api/trees/${id}/export`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'application/zip');
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="rod-rod-testovykh-r2.zip"');
  const zf = path.join(dir, 'export.zip'); fs.writeFileSync(zf, r.buf);
  execFileSync('unzip', ['-tq', zf]); // сторонний распаковщик подтверждает валидность
  const z = readZip(r.buf), names = [...z.keys()];
  for (const must of ['README.md', 'tree.json', 'tree.html', 'Obsidian/.obsidian/app.json']) assert.ok(names.includes(must), must);
  assert.ok(names.includes(`Obsidian/media/${up.json.url.split('/').pop()}`));
  assert.ok(z.get(`Obsidian/media/${up.json.url.split('/').pop()}`)().equals(png), 'фото в архиве — оригинал');
  const md = names.filter(n => n.startsWith('Obsidian/People/'));
  assert.equal(md.length, 4);
  // каждая [[ссылка|имя]] должна указывать на реально существующий файл заметки
  const files = new Set(md.map(n => n.split('/').pop().replace(/\.md$/, '')));
  let links = 0;
  for (const n of md) {
    const text = z.get(n)().toString('utf8');
    for (const m of text.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
      if (m[1].includes('.')) continue; // встраивание картинки
      links++; assert.ok(files.has(m[1]) || m[1] === 'не-ссылка', `битая ссылка ${m[0]} в ${n}`);
    }
  }
  assert.ok(links >= 10, 'ссылок достаточно: ' + links);
  const ivan = z.get(md.find(n => n.includes('Иван_Тестов')))().toString('utf8');
  assert.match(ivan, /^---\ntitle: "Иван Тестов"/); assert.match(ivan, /children: \["\[\[Пётр_/); assert.match(ivan, /spouses: \["\[\[Мария_Маша_Тестова/);
  assert.match(ivan, /!\[\[[\w-]+\.png\|320\]\]/); assert.match(ivan, /Строка 2/);
  const mum = z.get(md.find(n => n.includes('/Мария')))().toString('utf8');
  assert.match(mum, /maiden_name: "Кузнецова"/); assert.match(mum, /marriages: \["\[\[Иван_Тестов-\w+\|Иван Тестов\]\] — 14\.06\.1925"\]/); assert.match(mum, /- Девичья фамилия: Кузнецова/); assert.match(mum, /— свадьба 14\.06\.1925/);
  assert.match(z.get('tree.html')().toString('utf8'), /свадьба 14\.06\.1925/);
  const kid = z.get(md.find(n => n.includes('/Пётр_b')))().toString('utf8');
  assert.match(kid, /siblings: \["\[\[Сестра_Пётра/, 'производные сёстры из общих родителей');
  const html = z.get('tree.html')().toString('utf8');
  assert.ok(!html.includes('<b>Тестов</b>'), 'HTML экранирован'); assert.match(html, /Obsidian\/media\//); assert.match(html, /<svg/);
  const tj = JSON.parse(z.get('tree.json')().toString('utf8'));
  assert.equal(tj.format, 'rod-tree'); assert.equal(Object.keys(tj.people).length, 4);

  // --- импорт того же архива → новое древо с теми же людьми, связями и фото
  const imp = await c.post('/api/trees/import', undefined, { raw: r.buf });
  assert.equal(imp.status, 200, JSON.stringify(imp.json));
  const t2 = (await c.get(`/api/trees/${imp.json.id}`)).json;
  assert.equal(t2.name, 'Род Тестовых'); assert.equal(Object.keys(t2.people).length, 4);
  const byName = n => Object.values(t2.people).find(p => p.name.startsWith(n));
  assert.deepEqual(byName('Пётр').parents.sort(), [byName('Иван').id, byName('Мария').id].sort());
  assert.deepEqual(byName('Иван').spouses, [byName('Мария').id]);
  assert.equal(byName('Иван').bio, a.bio); assert.equal(byName('Иван').birthPlace, 'Тверь');
  assert.match(byName('Иван').photo, new RegExp(`^/media/${imp.json.id}/`));
  assert.ok((await c.get(byName('Иван').photo)).buf.equals(png), 'фото после импорта то же');
  assert.notEqual(imp.json.id, id);
  // чистый JSON тоже принимается; мусор — нет
  const jimp = await c.req('POST', '/api/trees/import?name=' + encodeURIComponent('Из JSON'), undefined, { raw: Buffer.from(JSON.stringify(tree)) });
  assert.equal(jimp.status, 200); assert.equal(jimp.json.name, 'Из JSON');
  assert.equal((await c.req('POST', '/api/trees/import', undefined, { raw: Buffer.from('garbage') })).status, 400);
  assert.equal((await c.req('POST', '/api/trees/import', undefined, { raw: Buffer.from('PK\x03\x04broken-zip-data') })).status, 400);
  const emptyList = await c.get('/api/me');
  assert.ok(emptyList.json.trees.length >= 3);
});

test('образец древа создаётся по запросу, а не автоматически', async () => {
  const c = await register('sample1');
  assert.equal((await c.get('/api/me')).json.trees.length, 0, 'новый пользователь — без навязанного примера');
  const id = (await c.post('/api/trees', { name: 'Пример', sample: true })).json.id;
  const t = (await c.get(`/api/trees/${id}`)).json;
  assert.equal(Object.keys(t.people).length, 5);
  assert.ok(Object.values(t.people).every(p => p.r === 2));
});

test('WebSocket: hello, патчи в реальном времени, присутствие, проверка Origin и прав', async () => {
  const a = await register('ws1'), b = await register('ws2'), s = await register('ws3'); const id = await newTree(a);
  await a.post(`/api/trees/${id}/share`, { username: 'ws2' });
  const open = (client, extra = {}) => new Promise((res, rej) => {
    const w = new WebSocket(`ws://127.0.0.1:${app.port}/ws?tree=${id}`, { headers: { cookie: client.cookie, ...extra } });
    const msgs = []; w.on('message', d => msgs.push(JSON.parse(d)));
    w.on('open', () => res({ w, msgs })); w.on('error', rej); w.on('unexpected-response', (_q, r) => rej(new Error('HTTP ' + r.statusCode)));
  });
  const wait = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout'); };
  await assert.rejects(open(s), /socket hang up|ECONN|HTTP/, 'нет доступа → соединение закрыто');
  await assert.rejects(open(a, { origin: 'https://evil.example' }), /socket hang up|ECONN|HTTP/, 'чужой Origin отклонён');
  const wa = await open(a), wb = await open(b);
  const hello = await wait(() => wb.msgs.find(m => m.type === 'hello'));
  assert.equal(hello.doc.id, id); assert.equal(hello.doc.isOwner, false);
  const pres = await wait(() => wa.msgs.filter(m => m.type === 'presence').find(m => m.users.length === 2));
  assert.deepEqual(pres.users.map(u => u.username).sort(), ['ws1', 'ws2']);
  const p = person('Живая правка');
  const r = await a.post(`/api/trees/${id}/save`, { ops: [put(p)], cid: 'dev-A' });
  const patch = await wait(() => wb.msgs.find(m => m.type === 'patch'));
  assert.equal(patch.by, 'ws1'); assert.equal(patch.cid, 'dev-A'); assert.equal(patch.rev, r.json.rev); assert.equal(patch.baseRev, r.json.rev - 1);
  assert.equal(patch.upserts[p.id].name, 'Живая правка'); assert.equal(patch.diff, undefined, 'диффы истории клиентам не уходят');
  wb.w.close();
  await wait(() => wa.msgs.filter(m => m.type === 'presence').some(m => m.users.length === 1));
  await a.req('DELETE', `/api/trees/${id}`);
  await wait(() => wa.msgs.find(m => m.type === 'deleted'));
  wa.w.close();
});
