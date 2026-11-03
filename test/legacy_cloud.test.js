import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { startServer } from '../server.js';
import { signV4 } from '../lib/cloud.js';

const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(base, cookie, method, url, body, raw) {
  const h = { 'x-rod': '1' }; if (cookie) h.cookie = cookie;
  if (body !== undefined) h['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers: h, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const buf = Buffer.from(await r.arrayBuffer()); let json = null; try { json = JSON.parse(buf.toString()); } catch { /* бинарные */ }
  return { status: r.status, json, buf, headers: r.headers };
}

test('миграция старого формата (JSON-файлы прежней версии) → SQLite', async () => {
  const dir = tmp('rod-legacy-');
  // --- данные в формате старого server.js
  const salt = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const hash = crypto.scryptSync('old-password', salt, 64).toString('hex');
  const U1 = crypto.randomUUID(), U2 = crypto.randomUUID(), T = crypto.randomUUID();
  const pid = () => crypto.randomUUID();
  const [a, b, c] = [pid(), pid(), pid()];
  const mk = (id, name, sex, extra) => ({ id, name, sex, birth: '1900', death: '', bio: '', photo: '', parents: [], spouses: [], ...extra });
  const P = {
    [a]: mk(a, 'Иван Родов', 'm', { bio: '[Тверь]\nМастер-часовщик', spouses: [b], photo: `/media/${T}/old.jpg` }),
    [b]: mk(b, 'Мария Родова', 'f', { spouses: [] }), // односторонняя связь — должна стать двусторонней
    [c]: mk(c, 'Пётр Родов', 'm', { parents: [a, b, 'ghost-id-xx'] }),
  };
  const P1 = structuredClone(P); delete P1[c];
  const sessionToken = 'deadbeef'.repeat(6);
  fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify([{ id: U1, username: 'Роман', pass: { salt, hash }, created: 1 }, { id: U2, username: 'guest', pass: { salt, hash }, created: 2 }]));
  fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify({ [sessionToken]: { userId: U1, exp: Date.now() + 1e9 }, expired0: { userId: U1, exp: 5 } }));
  fs.writeFileSync(path.join(dir, 'trees.json'), JSON.stringify({ [T]: { id: T, name: 'Старое древо', owner: U1, collaborators: [U2, 'nobody'], rev: 3, people: P, updatedAt: 1700000000000 } }));
  fs.writeFileSync(path.join(dir, `history-${T}.json`), JSON.stringify([
    { id: 'h1', rev: 1, ts: 1, author: 'Система', note: 'Первичное древо', snapshot: { name: 'Старое древо', people: {} } },
    { id: 'h2', rev: 2, ts: 2, author: 'Роман', note: 'Правка: Иван', snapshot: { name: 'Старое древо', people: P1 } },
    { id: 'h3', rev: 3, ts: 3, author: 'Роман', note: 'Правка: Пётр', snapshot: { name: 'Старое древо', people: P } },
  ]));
  fs.mkdirSync(path.join(dir, 'media', T), { recursive: true });
  const jpg = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#0a0' } }).jpeg().toBuffer();
  fs.writeFileSync(path.join(dir, 'media', T, 'old.jpg'), jpg);

  const app = await startServer({ port: 0, dataDir: dir, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    // старый пароль работает (те же параметры scrypt)
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'x-rod': '1', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'роман', password: 'old-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    // старая сессия тоже жива (токен перехеширован), просроченная — нет
    assert.equal((await call(base, 'rod=' + sessionToken, 'GET', '/api/me')).status, 200);
    const me = (await call(base, cookie, 'GET', '/api/me')).json;
    assert.equal(me.trees.length, 1); assert.equal(me.trees[0].count, 3); assert.equal(me.trees[0].rev, 3);
    const t = (await call(base, cookie, 'GET', `/api/trees/${T}`)).json;
    assert.equal(t.people[a].birthPlace, 'Тверь', 'место из префикса биографии вынесено в отдельное поле');
    assert.equal(t.people[a].bio, 'Мастер-часовщик');
    assert.deepEqual(t.people[b].spouses, [a], 'связь супругов симметризована');
    assert.deepEqual(t.people[c].parents.sort(), [a, b].sort(), 'битая ссылка убрана');
    assert.deepEqual(t.collaborators.map(x => x.username), ['guest']);
    assert.equal(t.isOwner, true);
    for (const p of Object.values(t.people)) { assert.deepEqual(Object.keys(p).sort(), ['address', 'bio', 'birth', 'birthPlace', 'death', 'deathPlace', 'docs', 'education', 'email', 'id', 'maidenName', 'marriages', 'name', 'occupation', 'parents', 'phone', 'photo', 'r', 'school', 'sex', 'siblings', 'spouses', 'workplace']); }
    // старое фото доступно, в т.ч. миниатюра
    assert.ok((await call(base, cookie, 'GET', t.people[a].photo)).buf.equals(jpg));
    assert.equal((await call(base, cookie, 'GET', `/thumb/${T}/old.jpg?s=s`)).headers.get('content-type'), 'image/webp');
    // история сконвертирована из снимков в диффы и откатывается
    const h = (await call(base, cookie, 'GET', `/api/trees/${T}/history`)).json.items;
    assert.deepEqual(h.map(x => x.rev), [3, 2, 1]);
    assert.deepEqual(h[0].changes.map(x => [x.name, x.kind]), [['Пётр Родов', 'add']]);
    const rs = await call(base, cookie, 'POST', `/api/trees/${T}/restore`, { rev: 2 });
    assert.equal(rs.status, 200, JSON.stringify(rs.json));
    const t2 = (await call(base, cookie, 'GET', `/api/trees/${T}`)).json;
    assert.equal(Object.keys(t2.people).length, 2); assert.equal(t2.rev, 4);
    // исходные файлы сохранены под новым именем
    assert.ok(fs.existsSync(path.join(dir, 'users.json.migrated')) && !fs.existsSync(path.join(dir, 'users.json')));
  } finally { await app.close(); }
  // повторный запуск не мигрирует заново и не ломается
  const app2 = await startServer({ port: 0, dataDir: dir, host: '127.0.0.1' });
  assert.equal(app2.store.userCount(), 2);
  await app2.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('облако: подпись SigV4 проверяется «сервером», повтор при сбое, файлы и бэкап БД', async () => {
  const received = new Map(); let failNext = 1, badSig = 0;
  const KEY = 'AKIATEST', SECRET = 'secret/KEY+test', REGION = 'ru-central1';
  const s3 = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if (failNext > 0) { failNext--; res.writeHead(500); return res.end('boom'); }
      // независимая перепроверка подписи по присланным заголовкам
      const h = req.headers, amz = h['x-amz-date'];
      const expected = signV4({ method: 'PUT', url: `http://${h.host}${req.url}`, headers: { host: h.host, 'content-type': h['content-type'], 'x-amz-content-sha256': h['x-amz-content-sha256'], 'x-amz-date': amz },
        payloadHash: crypto.createHash('sha256').update(body).digest('hex'), accessKey: KEY, secret: SECRET, region: REGION, amzDate: amz });
      if (h.authorization !== expected || h['x-amz-content-sha256'] !== crypto.createHash('sha256').update(body).digest('hex')) { badSig++; res.writeHead(403); return res.end(); }
      received.set(decodeURIComponent(req.url), { body, ctype: h['content-type'] });
      res.writeHead(200); res.end();
    });
  });
  await new Promise(r => s3.listen(0, '127.0.0.1', r));
  const dir = tmp('rod-cloud-');
  const app = await startServer({ port: 0, dataDir: dir, host: '127.0.0.1', env: { ROD_REGISTRATION: 'open', REG_LIMIT_PER_HOUR: '100', S3_ENDPOINT: `http://127.0.0.1:${s3.address().port}`, S3_BUCKET: 'bk', S3_KEY: KEY, S3_SECRET: SECRET, S3_REGION: REGION, S3_PREFIX: 'rod/', S3_DB_BACKUP_INTERVAL_MS: '1' } });
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const reg = await fetch(base + '/api/register', { method: 'POST', headers: { 'x-rod': '1', 'content-type': 'application/json' }, body: JSON.stringify({ username: 'cloudy', password: 'password-123' }) });
    const cookie = reg.headers.get('set-cookie').split(';')[0];
    const tid = (await call(base, cookie, 'POST', '/api/trees', { name: 'Облачное' })).json.id;
    const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#123' } }).png().toBuffer();
    const up = (await call(base, cookie, 'POST', `/api/trees/${tid}/photo`, undefined, png)).json.url;
    const pidv = crypto.randomUUID();
    const person = { id: pidv, name: 'Облако Облаков', photo: up };
    const sv = await call(base, cookie, 'POST', `/api/trees/${tid}/save`, { ops: [{ op: 'put', person, base: 0 }], note: 'в облако' });
    assert.equal(sv.status, 200);
    // первый PUT получил 500 → запись осталась в очереди с ошибкой
    for (let i = 0; i < 20 && failNext > 0; i++) await sleep(50);
    await app.cloud.drain();
    assert.ok(app.store.outboxCount() > 0, 'после сбоя элемент не потерян');
    assert.equal(app.store.db.prepare('SELECT MAX(tries) t FROM outbox').get().t, 1, 'неудачная попытка учтена, повтор запланирован');
    // пауза до повтора не наступила → сразу не уйдёт; «перематываем» время
    app.store.db.exec('UPDATE outbox SET next_at=0');
    for (let i = 0; i < 10 && app.store.outboxCount() > 0; i++) { await app.cloud.drain(); await sleep(30); }
    assert.equal(app.store.outboxCount(), 0, 'очередь опустела');
    assert.equal(badSig, 0, 'все подписи верны');
    const keys = [...received.keys()];
    const head = received.get(`/bk/rod/trees/${tid}/head.json`);
    assert.ok(head, 'head.json: ' + keys.join(', '));
    assert.equal(JSON.parse(head.body).people[pidv].name, 'Облако Облаков');
    const ver = JSON.parse(received.get(`/bk/rod/versions/${tid}/r2.json`).body);
    assert.equal(ver.author, 'cloudy'); assert.equal(ver.note, 'в облако');
    const media = received.get(`/bk/rod/media/${tid}/${up.split('/').pop()}`);
    assert.ok(media.body.equals(png)); assert.equal(media.ctype, 'image/png', 'Content-Type фото — image/png (раньше было application/json)');
    const dbKey = keys.find(k => k.startsWith('/bk/rod/db/rod-'));
    assert.ok(dbKey, 'бэкап БД выгружен');
    assert.equal(received.get(dbKey).body.subarray(0, 15).toString(), 'SQLite format 3');
    assert.equal((await call(base, cookie, 'GET', '/healthz')).json.cloud.queue, 0);
  } finally { await app.close(); s3.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
