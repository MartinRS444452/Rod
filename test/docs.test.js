import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startServer } from '../server.js';
import { cleanPerson, lenientPerson, DOC_KINDS } from '../lib/validate.js';
import { buildExportEntries, offlineHtml } from '../lib/export.js';
import { zipBuffer, readZip } from '../lib/zip.js';

const uuid = () => crypto.randomUUID();
const T = 'b'.repeat(8) + '-bbbb-4bbb-8bbb-' + 'b'.repeat(12), ID = 'a'.repeat(8) + '-aaaa-4aaa-8aaa-' + 'a'.repeat(12);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n'), JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
const base = o => ({ id: ID, name: 'Иван Родов', sex: 'm', ...o });
const doc = (o = {}) => ({ id: 'd1', file: `/media/${T}/${'c'.repeat(8)}.pdf`, kind: 'Свидетельство о смерти', title: 'Свидетельство', name: 'scan.pdf', size: 1234, added: 1700000000000, ...o });

test('документы: корректная запись сохраняется, лишнее отбрасывается', () => {
  const p = cleanPerson(base({ docs: [doc(), doc({ file: `/media/OTHER/x.pdf`, id: 'd2' }), doc({ file: `/media/${T}/y.exe`, id: 'd3' }), doc({ id: 'd1' })] }), T);
  assert.equal(p.docs.length, 1, 'чужое дерево, неверное расширение и повтор — отброшены');
  assert.deepEqual(Object.keys(p.docs[0]).sort(), ['added', 'file', 'id', 'kind', 'name', 'size', 'title', 'type']);
  assert.equal(p.docs[0].type, 'application/pdf');
  const q = cleanPerson(base({ docs: [doc({ kind: 'Выдуманный вид', title: '  Диплом\u0000\n  ', name: '../../etc/passwd', size: -5, id: 'плохой id!' })] }), T);
  assert.equal(q.docs[0].kind, ''); assert.equal(q.docs[0].title, 'Диплом'); assert.ok(!q.docs[0].name.includes('/'), q.docs[0].name); assert.equal(q.docs[0].size, 0);
  assert.match(q.docs[0].id, /^[\w-]+$/);
  assert.deepEqual(cleanPerson(base(), T).docs, []);
  assert.throws(() => cleanPerson(base({ docs: 'строка' }), T), /списком/);
  assert.throws(() => cleanPerson(base({ docs: Array.from({ length: 41 }, (_, i) => doc({ id: 'd' + i, file: `/media/${T}/${String(i).padStart(8, '0')}.pdf` })) }), T), /не больше 40/);
  assert.equal(lenientPerson(base({ docs: 'мусор' }), T, ID).docs.length, 0, 'импорт не падает на мусоре');
  assert.ok(DOC_KINDS.includes('Свидетельство о смерти'));
});
test('документы попадают в Obsidian (ссылки + файлы) и в офлайн-страницу', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-docx-'));
  fs.writeFileSync(path.join(dir, 'cccccccc.pdf'), PDF);
  const people = { [ID]: { ...cleanPerson(base({ docs: [doc()] }), T), parents: [], spouses: [], siblings: [], marriages: [] } };
  const entries = buildExportEntries({ id: T, name: 'Семья', rev: 3, people }, dir);
  const md = String(entries.find(e => e.name.includes('People/')).data);
  assert.match(md, /## Документы/); assert.match(md, /\[\[cccccccc\.pdf\|Свидетельство\]\] — Свидетельство о смерти/);
  assert.ok(entries.some(e => e.name === 'Obsidian/media/cccccccc.pdf'), 'сам файл — в архиве');
  assert.match(offlineHtml({ id: T, name: 'Семья', rev: 3, people }), /href="Obsidian\/media\/cccccccc\.pdf">Свидетельство</);
  fs.rmSync(dir, { recursive: true, force: true });
});

async function boot(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-doc-'));
  const app = await startServer({ port: 0, dataDir: dir, host: '127.0.0.1', env: { ROD_REGISTRATION: 'open', REG_LIMIT_PER_HOUR: '1000', ...env } });
  const base0 = `http://127.0.0.1:${app.port}`;
  const client = () => { let cookie = ''; return async (method, url, body, raw) => {
    const r = await fetch(base0 + url, { method, headers: { 'x-rod': '1', ...(raw ? { 'content-type': 'application/octet-stream' } : { 'content-type': 'application/json' }), cookie }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, ct, json: ct.includes('json') ? await r.json().catch(() => null) : null, buf: ct.includes('json') ? null : Buffer.from(await r.arrayBuffer()) };
  }; };
  const owner = client(); await owner('POST', '/api/register', { username: 'o' + uuid().slice(0, 6), password: 'password-123' });
  const tree = (await owner('POST', '/api/trees', { name: 'Документы' })).json.id;
  return { app, dir, base0, client, owner, tree, done: async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const P = (name, o = {}) => ({ id: uuid(), name, sex: 'm', birth: '', death: '', birthPlace: '', deathPlace: '', school: '', education: '', occupation: '', workplace: '', phone: '', email: '', address: '', bio: '', photo: '', docs: [], parents: [], spouses: [], siblings: [], marriages: [], ...o });

test('загрузка документа: PDF и фото принимаются, подделки и чужие — нет; файл отдаётся только участникам древа', async () => {
  const { owner, client, tree, done } = await boot();
  try {
    const up = await owner('POST', `/api/trees/${tree}/doc`, undefined, PDF);
    assert.equal(up.status, 200); assert.match(up.json.url, new RegExp(`^/media/${tree}/[\\w-]+\\.pdf$`)); assert.equal(up.json.type, 'application/pdf'); assert.equal(up.json.size, PDF.length);
    const img = await owner('POST', `/api/trees/${tree}/doc`, undefined, JPG); assert.match(img.json.url, /\.jpg$/);
    assert.equal((await owner('POST', `/api/trees/${tree}/doc`, undefined, Buffer.from('MZ\x90\x00 это exe'))).status, 400, 'исполняемый файл не принимается');
    assert.equal((await owner('POST', `/api/trees/${tree}/doc`, undefined, Buffer.from('<html><script>alert(1)</script>'))).status, 400, 'HTML под видом документа — нет');
    const got = await owner('GET', up.json.url); assert.equal(got.status, 200); assert.equal(got.ct, 'application/pdf'); assert.deepEqual(got.buf, PDF);
    const anon = client();
    assert.equal((await anon('GET', up.json.url)).status, 401, 'без входа — нет');
    assert.equal((await anon('POST', `/api/trees/${tree}/doc`, undefined, PDF)).status, 401);
    const stranger = client(); await stranger('POST', '/api/register', { username: 'x' + uuid().slice(0, 6), password: 'password-123' });
    assert.equal((await stranger('GET', up.json.url)).status, 403, 'вошедший, но не участник древа — нет');
    assert.equal((await stranger('POST', `/api/trees/${tree}/doc`, undefined, PDF)).status, 403, 'и загружать в чужое древо нельзя');
    assert.equal((await owner('GET', up.json.url.replace('/media/', '/thumb/'))).status, 404, 'у PDF нет миниатюры');
    assert.equal((await owner('GET', img.json.url.replace('/media/', '/thumb/'))).status, 200, 'у фото-документа миниатюра есть');
    // сохранение карточки с документом и откат из истории вместе с документом
    const person = P('Иван Родов', { docs: [{ id: 'd1', file: up.json.url, kind: 'Свидетельство о смерти', title: 'Метрика', name: 'm.pdf', size: PDF.length, added: Date.now() }] });
    const saved = await owner('POST', `/api/trees/${tree}/save`, { ops: [{ op: 'put', person, base: 0 }], note: 'док' });
    assert.equal(saved.status, 200);
    const fresh = (await owner('GET', `/api/trees/${tree}`)).json.people[person.id]; assert.equal(fresh.docs[0].title, 'Метрика'); assert.equal(fresh.docs[0].type, 'application/pdf');
    const del = await owner('POST', `/api/trees/${tree}/save`, { ops: [{ op: 'put', person: { ...fresh, docs: [] }, base: fresh.r }], note: 'убрали' });
    assert.equal(del.status, 200);
    const rest = await owner('POST', `/api/trees/${tree}/restore`, { rev: saved.json.rev });
    assert.equal(rest.status, 200);
    assert.equal((await owner('GET', `/api/trees/${tree}`)).json.people[person.id].docs.length, 1, 'откат вернул документ');
    assert.equal((await owner('GET', up.json.url)).status, 200, 'файл при удалении из карточки остаётся (нужен истории)');
    const bk = await owner('GET', '/api/admin/backup'); assert.equal(bk.status, 200);
    assert.ok(readZip(bk.buf).get('media/' + up.json.url.split('/media/')[1]), 'документ попадает в полную копию');
  } finally { await done(); }
});
test('лимит размера PDF и импорт/экспорт: документы переезжают в новое древо', async () => {
  const { owner, tree, done } = await boot({ MAX_DOC_MB: '1' });
  try {
    assert.equal((await owner('POST', `/api/trees/${tree}/doc`, undefined, Buffer.concat([PDF, Buffer.alloc(1.2 * 1048576)]))).status, 413, 'PDF больше лимита');
  } finally { await done(); }
  const { owner: o2, tree: t2, done: d2 } = await boot();
  try {
    const up = (await o2('POST', `/api/trees/${t2}/doc`, undefined, PDF)).json;
    const person = P('Пётр', { docs: [{ id: 'dd', file: up.url, kind: 'Диплом / аттестат', title: 'Диплом', name: 'diploma.pdf', size: PDF.length, added: 1 }] });
    await o2('POST', `/api/trees/${t2}/save`, { ops: [{ op: 'put', person, base: 0 }], note: 'x' });
    // собираем архив как делает экспорт и загружаем обратно как новое древо
    const tree = (await o2('GET', `/api/trees/${t2}`)).json;
    const entries = buildExportEntries(tree, '/nonexistent');
    const treeJson = entries.find(e => e.name === 'tree.json').data;
    const z = await zipBuffer([{ name: 'tree.json', data: treeJson }, { name: `Obsidian/media/${up.url.split('/').pop()}`, data: PDF }]);
    const imp = await o2('POST', '/api/trees/import?name=copy', undefined, z); assert.equal(imp.status, 200, JSON.stringify(imp.json));
    const copy = (await o2('GET', `/api/trees/${imp.json.id}`)).json, cp = Object.values(copy.people)[0];
    assert.equal(cp.docs.length, 1); assert.match(cp.docs[0].file, new RegExp(`^/media/${imp.json.id}/`)); assert.equal(cp.docs[0].title, 'Диплом');
    assert.deepEqual((await o2('GET', cp.docs[0].file)).buf, PDF, 'файл скопирован в новое древо');
  } finally { await d2(); }
});
