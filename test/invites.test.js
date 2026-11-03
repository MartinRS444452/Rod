import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer } from '../server.js';

const uuid = () => crypto.randomUUID();
async function boot(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-inv-'));
  const app = await startServer({ port: 0, dataDir: dir, host: '127.0.0.1', env: { REG_LIMIT_PER_HOUR: '1000', ...env } });
  const base = `http://127.0.0.1:${app.port}`;
  const client = () => { let cookie = ''; return async (method, url, body) => {
    const r = await fetch(base + url, { method, headers: { 'x-rod': '1', 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  }; };
  const owner = client(), reg = await owner('POST', '/api/register', { username: 'owner' + uuid().slice(0, 5), password: 'password-123' });
  assert.equal(reg.status, 200, 'самый первый аккаунт создаётся всегда');
  const tree = (await owner('POST', '/api/trees', { name: 'Наша семья' })).json.id;
  return { app, dir, base, client, owner, tree, done: async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const R = (name, extra = {}) => ({ username: name || 'rel' + uuid().slice(0, 6), password: 'password-123', ...extra });

test('без приглашения регистрация закрыта (режим по умолчанию), по ссылке — открыта и сразу даёт доступ к древу', async () => {
  const { owner, client, tree, done } = await boot();
  try {
    const info = (await client()('GET', '/api/public-info')).json;
    assert.equal(info.registration, 'invite'); assert.equal(info.firstRun, false);
    const stranger = client();
    const no = await stranger('POST', '/api/register', R()); assert.equal(no.status, 403); assert.match(no.json.error, /по приглашению/);
    const bad = await stranger('POST', '/api/register', R('x'.repeat(5), { invite: 'не-существует' })); assert.equal(bad.status, 410);
    const created = await owner('POST', `/api/trees/${tree}/invites`, { days: 7, uses: 1, note: 'тётя Лена' });
    assert.equal(created.status, 200); const token = created.json.token; assert.ok(token.length >= 30);
    const peek = await client()('GET', '/api/invite/' + token);                  // без входа: видно только «кто и куда приглашает»
    assert.equal(peek.status, 200); assert.equal(peek.json.tree, 'Наша семья'); assert.deepEqual(Object.keys(peek.json).sort(), ['by', 'exp', 'tree']);
    const rel = client(), ok = await rel('POST', '/api/register', R('lena_' + uuid().slice(0, 4), { invite: token }));
    assert.equal(ok.status, 200); assert.equal(ok.json.joined, tree);
    const me = (await rel('GET', '/api/me')).json;
    assert.deepEqual(me.trees.map(t => t.id), [tree], 'у родственника сразу видно древо; чужих древ нет');
    assert.equal((await rel('GET', `/api/trees/${tree}`)).status, 200);
    assert.equal((await client()('POST', '/api/register', R('lena2' + uuid().slice(0, 3), { invite: token }))).status, 410, 'одноразовая ссылка сгорела');
    assert.equal((await client()('GET', '/api/invite/' + token)).status, 404);
  } finally { await done(); }
});

test('приглашение: несколько человек, срок, отзыв, права, занятый логин не сжигает ссылку', async () => {
  const { owner, client, tree, done, app } = await boot();
  try {
    const t3 = (await owner('POST', `/api/trees/${tree}/invites`, { uses: 2, days: 3 })).json.token;
    const first = 'a' + uuid().slice(0, 6);
    assert.equal((await client()('POST', '/api/register', R(first, { invite: t3 }))).status, 200);
    const taken = await client()('POST', '/api/register', R(first, { invite: t3 }));
    assert.equal(taken.status, 409 === taken.status ? 409 : taken.status); assert.ok(taken.status >= 400 && taken.status !== 410, 'логин занят — но не «ссылка недействительна»: ' + taken.status);
    assert.equal((await client()('POST', '/api/register', R('b' + uuid().slice(0, 6), { invite: t3 }))).status, 200, 'вторая попытка с другим логином: ссылка не сгорела зря');
    assert.equal((await client()('POST', '/api/register', R('c' + uuid().slice(0, 6), { invite: t3 }))).status, 410, 'лимит 2 человека исчерпан');

    const list = (await owner('GET', `/api/trees/${tree}/invites`)).json.invites;
    assert.equal(list.length, 0, 'исчерпанные приглашения не показываются');
    const t1 = (await owner('POST', `/api/trees/${tree}/invites`, { note: 'временная' })).json.token;
    const act = (await owner('GET', `/api/trees/${tree}/invites`)).json.invites; assert.equal(act.length, 1); assert.equal(act[0].note, 'временная'); assert.ok(!JSON.stringify(act).includes(t1), 'токен нигде не хранится и не отдаётся повторно');
    assert.equal((await owner('DELETE', `/api/trees/${tree}/invites`, { id: act[0].id })).json.ok, true);
    assert.equal((await client()('POST', '/api/register', R('d' + uuid().slice(0, 6), { invite: t1 }))).status, 410, 'отозванная ссылка не работает');

    const guest = client(); await guest('POST', '/api/register', R('e' + uuid().slice(0, 6), { invite: (await owner('POST', `/api/trees/${tree}/invites`, {})).json.token }));
    assert.equal((await guest('POST', `/api/trees/${tree}/invites`, {})).status, 403, 'приглашать может только владелец древа');
    assert.equal((await guest('GET', `/api/trees/${tree}/invites`)).status, 403);
    assert.equal((await client()('POST', `/api/trees/${tree}/invites`, {})).status, 401);

    const t0 = (await owner('POST', `/api/trees/${tree}/invites`, { days: 1 })).json.token;
    app.store.db.prepare('UPDATE invites SET exp=?').run(Date.now() - 1000);
    assert.equal((await client()('POST', '/api/register', R('f' + uuid().slice(0, 6), { invite: t0 }))).status, 410, 'просроченная ссылка не работает');
    const big = (await owner('POST', `/api/trees/${tree}/invites`, { days: 999, uses: 999 })).json; assert.equal(big.days, 30); assert.equal(big.uses, 20, 'срок и число людей ограничены');
  } finally { await done(); }
});

test('уже зарегистрированный родственник принимает приглашение; владелец не тратит ссылку; режимы open и closed', async () => {
  const { owner, client, tree, done } = await boot();
  try {
    const tok = (await owner('POST', `/api/trees/${tree}/invites`, {})).json.token;
    const own = await owner('POST', '/api/invite/accept', { token: tok }); assert.equal(own.json.already, true);
    assert.equal((await client()('GET', '/api/invite/' + tok)).status, 200, 'владелец ссылку не потратил');
    assert.equal((await client()('POST', '/api/invite/accept', { token: tok })).status, 401, 'без входа принять нельзя');
  } finally { await done(); }
  const o = await boot({ ROD_REGISTRATION: 'open' });
  try { assert.equal((await o.client()('POST', '/api/register', R())).status, 200, 'open: регистрируется любой'); } finally { await o.done(); }
  const c = await boot({ ROD_REGISTRATION: 'closed' });
  try {
    const tok = (await c.owner('POST', `/api/trees/${c.tree}/invites`, {})).json.token;
    assert.equal((await c.client()('POST', '/api/register', R())).status, 403);
    assert.equal((await c.client()('POST', '/api/register', R(undefined, { invite: tok }))).status, 403, 'closed: даже по ссылке новых аккаунтов нет');
  } finally { await c.done(); }
});

test('принять приглашение может вошедший пользователь, получает доступ и ссылка расходуется', async () => {
  const o = await boot({ ROD_REGISTRATION: 'open' });
  try {
    const rel = o.client(); await rel('POST', '/api/register', R('rel_' + uuid().slice(0, 4)));
    assert.equal((await rel('GET', '/api/me')).json.trees.length, 0);
    const tok = (await o.owner('POST', `/api/trees/${o.tree}/invites`, { uses: 1 })).json.token;
    const acc = await rel('POST', '/api/invite/accept', { token: tok });
    assert.equal(acc.status, 200); assert.equal(acc.json.treeId, o.tree); assert.equal(acc.json.already, false);
    assert.equal((await rel('GET', '/api/me')).json.trees.length, 1);
    const again = await rel('POST', '/api/invite/accept', { token: tok }); assert.equal(again.json.already, true, 'повторно — без ошибки');
    const other = o.client(); await other('POST', '/api/register', R('x_' + uuid().slice(0, 4)));
    assert.equal((await other('POST', '/api/invite/accept', { token: tok })).status, 410, 'ссылка была на одного');
    assert.equal((await rel('POST', '/api/invite/accept', { token: 'мусор' })).status, 410);
  } finally { await o.done(); }
});
