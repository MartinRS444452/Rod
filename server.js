import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { Store } from './lib/store.js';
import { migrateLegacy, normalizePeople } from './lib/migrate.js';
import { Cloud } from './lib/cloud.js';
import { Snapshots } from './lib/snapshots.js';
import { prepareBackup } from './lib/backup.js';
import { HttpError, cleanTreeName, ID_RE, cleanDoc, MAX_DOCS } from './lib/validate.js';
import { zipStream, readZip } from './lib/zip.js';
import { buildExportEntries, exportFileName } from './lib/export.js';
import { strip } from './lib/tree.js';
import { startTelegramNotifier } from './lib/telegram.js';

const scrypt = promisify(crypto.scrypt);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

let sharp = null;
try { sharp = (await import('sharp')).default; } catch { /* миниатюры необязательны */ }

// ---------- вспомогательное ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.webmanifest', '.svg']);

class Limiter {
  constructor(windowMs, max) { this.w = windowMs; this.m = max; this.hits = new Map(); }
  recent(key) { const now = Date.now(), a = (this.hits.get(key) || []).filter(t => now - t < this.w); this.hits.set(key, a); return a; }
  /** секунд до разблокировки или 0 */
  blocked(key) { const a = this.recent(key); return a.length >= this.m ? Math.ceil((a[0] + this.w - Date.now()) / 1000) : 0; }
  add(key) { this.recent(key).push(Date.now()); }
  reset(key) { this.hits.delete(key); }
  sweep() { for (const k of [...this.hits.keys()]) if (!this.recent(k).length) this.hits.delete(k); }
}

const sniff = b => {
  if (b.length > 12 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpg';
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) return 'png';
  if (b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
};
const sniffDoc = b => (b.length > 8 && b.subarray(0, 1024).toString('latin1').includes('%PDF-') ? 'pdf' : sniff(b));   // PDF или изображение
const EXT_MIME = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };

export async function startServer(opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  const PORT = opts.port ?? Number(env.PORT || 3000);
  const DATA = path.resolve(opts.dataDir || env.DATA_DIR || './data');
  const MEDIA = path.join(DATA, 'media'), THUMBS = path.join(DATA, 'thumbs');
  const MAX_PHOTO = Number(env.MAX_PHOTO_MB || 40) * 1024 * 1024;
  const MAX_PDF = Number(env.MAX_DOC_MB || 25) * 1024 * 1024;
  const MAX_IMPORT = Number(env.MAX_IMPORT_MB || 300) * 1024 * 1024;
  const TRUST_PROXY = env.TRUST_PROXY === '1';
  // Кто может создавать аккаунты: invite (по умолчанию) — только по ссылке-приглашению; open — любой; closed — никто. Самый первый аккаунт создаётся всегда.
  const REG = ['open', 'invite', 'closed'].includes(env.ROD_REGISTRATION) ? env.ROD_REGISTRATION : 'invite';
  for (const d of [DATA, MEDIA, THUMBS]) fs.mkdirSync(d, { recursive: true });

  const store = new Store(DATA, { historyLimit: Number(env.HISTORY_LIMIT || 1000) });
  migrateLegacy(store, DATA);
  const cloud = new Cloud(store, env);
  startTelegramNotifier(store);
  const snaps = new Snapshots(store, DATA, env);
  store.onCommit = (treeId, patch) => {
    snaps.onCommit(treeId, patch);
    if (cloud.enabled) cloud.onCommit({ id: treeId, people: store.loadPeople(treeId) }, patch);
  };
  cloud.start(DATA); snaps.start();

  let backupBusy = false;
  const loginIp = new Limiter(15 * 60e3, 40), loginUser = new Limiter(15 * 60e3, 8), regIp = new Limiter(3600e3, Number(env.REG_LIMIT_PER_HOUR || 10)), apiIp = new Limiter(60e3, 900), inviteIp = new Limiter(10 * 60e3, 60);
  const sweeper = setInterval(() => { for (const l of [loginIp, loginUser, regIp, apiIp, inviteIp]) l.sweep(); store.purgeSessions(); }, 5 * 60e3);
  sweeper.unref();

  const ipOf = req => (TRUST_PROXY && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';
  const isSecure = req => env.COOKIE_SECURE === '1' || !!req.socket.encrypted || (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https');

  // ---------- ответы ----------
  function baseHeaders(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if (isSecure(req)) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  function send(res, code, obj) {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > limit) { req.resume(); return reject(new HttpError(413, 'Файл слишком большой')); }
      const parts = []; let size = 0, over = false;
      req.on('data', c => { size += c.length; if (size > limit) over = true; else parts.push(c); });
      req.on('end', () => (over ? reject(new HttpError(413, 'Файл слишком большой')) : resolve(Buffer.concat(parts))));
      req.on('error', reject);
    });
  }
  async function readJson(req, limit = 8 * 1024 * 1024) {
    const b = await readBody(req, limit);
    try { return b.length ? JSON.parse(b.toString('utf8')) : {}; } catch { throw new HttpError(400, 'Неверный JSON'); }
  }
  function checkMutation(req) {
    if (req.headers['x-rod'] !== '1') throw new HttpError(403, 'Запрос отклонён');
    const o = req.headers.origin;
    if (o) { let h; try { h = new URL(o).host; } catch { h = ''; } if (h !== req.headers.host) throw new HttpError(403, 'Запрос отклонён'); }
  }
  const tokenOf = req => /(?:^|;\s*)rod=([a-f0-9]{32,})/.exec(req.headers.cookie || '')?.[1] || null;
  const sessionOf = req => { const t = tokenOf(req); const u = store.sessionUser(t); return u ? { user: u, token: t } : null; };
  const publicUser = u => ({ id: u.id, username: u.username });
  const setCookie = (req, res, token, maxAge = 30 * 86400) =>
    res.setHeader('Set-Cookie', `rod=${token}; HttpOnly; Path=/; Max-Age=${maxAge}; SameSite=Lax${isSecure(req) ? '; Secure' : ''}`);

  // ---------- пароли ----------
  const hashPw = async (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: (await scrypt(pw, salt, 64)).toString('hex') });
  const DUMMY = await hashPw('dummy-password');
  async function checkPw(pw, u) {
    const rec = u || DUMMY; // выравниваем время ответа для несуществующих логинов
    const key = await scrypt(pw, rec.salt, 64), good = Buffer.from(rec.hash, 'hex');
    return !!u && key.length === good.length && crypto.timingSafeEqual(key, good);
  }

  // ---------- WebSocket ----------
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set();
  let closed = false;
  const broadcast = (treeId, msg) => {
    const s = JSON.stringify(msg);
    for (const c of clients) if (c.treeId === treeId && c.ws.readyState === 1) c.ws.send(s);
  };
  const presence = treeId => {
    const ids = [...new Set([...clients].filter(c => c.treeId === treeId).map(c => c.userId))];
    broadcast(treeId, { type: 'presence', users: ids.map(id => store.userById(id)).filter(Boolean).map(publicUser) });
  };
  const publish = (treeId, patch, cid) => {
    const { diff, entryId, ...pub } = patch; // eslint-disable-line no-unused-vars
    const out = { ...pub, cid: cid || null };
    broadcast(treeId, { type: 'patch', ...out });
    return out;
  };
  const heartbeat = setInterval(() => {
    for (const c of clients) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch { /* закрыт */ } }
  }, 30000);
  heartbeat.unref();

  // ---------- фото ----------
  const SIZES = { s: { w: 360, h: 360, fit: 'cover' }, m: { w: 1280, h: 1280, fit: 'inside' } };
  const inflight = new Map();
  async function thumbFile(treeId, file, size) {
    const orig = path.join(MEDIA, treeId, file);
    if (!fs.existsSync(orig)) return null;
    const ext = path.extname(file).slice(1);
    if (!sharp) return { file: orig, ctype: EXT_MIME[ext] };
    const out = path.join(THUMBS, treeId, `${file}.${size}.webp`);
    if (fs.existsSync(out)) return { file: out, ctype: 'image/webp' };
    if (!inflight.has(out)) {
      const S = SIZES[size];
      inflight.set(out, (async () => {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        const tmp = out + '.' + process.pid + '.tmp';
        await sharp(orig, { failOn: 'none', limitInputPixels: 400e6 }).rotate().resize({ width: S.w, height: S.h, fit: S.fit, withoutEnlargement: true }).webp({ quality: 82 }).toFile(tmp);
        fs.renameSync(tmp, out);
      })().finally(() => inflight.delete(out)));
    }
    try { await inflight.get(out); return { file: out, ctype: 'image/webp' }; }
    catch (e) { console.error('thumb:', e.message); return { file: orig, ctype: EXT_MIME[ext] }; }
  }
  function sendFile(req, res, file, ctype, cache) {
    const st = fs.statSync(file), etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': cache }); return res.end(); }
    res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': st.size, ETag: etag, 'Cache-Control': cache });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  // ---------- статика ----------
  const gzCache = new Map();
  function serveStatic(req, res, route) {
    let rel = route === '/' ? '/index.html' : route;
    let abs;
    try { abs = path.join(PUBLIC, decodeURIComponent(rel)); } catch { return false; }
    if (!abs.startsWith(PUBLIC + path.sep) || path.basename(abs).startsWith('.')) return false;
    let st; try { st = fs.statSync(abs); } catch { return false; }
    if (!st.isFile()) return false;
    const ext = path.extname(abs), etag = `"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    const cache = rel.startsWith('/icons/') ? 'public, max-age=86400' : 'no-cache';
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': cache }); res.end(); return true; }
    const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', ETag: etag, 'Cache-Control': cache, Vary: 'Accept-Encoding' };
    if (COMPRESSIBLE.has(ext) && st.size > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      const key = abs + etag;
      if (!gzCache.has(key)) { if (gzCache.size > 200) gzCache.clear(); gzCache.set(key, zlib.gzipSync(fs.readFileSync(abs))); }
      const body = gzCache.get(key);
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } else {
      res.writeHead(200, { ...headers, 'Content-Length': st.size });
      if (req.method === 'HEAD') res.end(); else fs.createReadStream(abs).pipe(res);
    }
    return true;
  }

  // ---------- образец древа ----------
  function sampleOps() {
    const id = () => crypto.randomUUID();
    const mk = (name, sex, birth, death, extra = {}) => ({ id: id(), name, sex, birth, death, birthPlace: '', deathPlace: '', school: '', education: '', occupation: '', workplace: '', bio: '', photo: '', parents: [], spouses: [], siblings: [], ...extra });
    const a = mk('Иван Родов', 'm', '1902', '1978', { birthPlace: 'Тверская губерния', occupation: 'Часовщик', bio: 'Основатель семьи. Мастер-часовщик.' });
    const b = mk('Мария Родова', 'f', '1905', '1989', { occupation: 'Учительница литературы', bio: 'Вела семейный дневник.' });
    const c = mk('Пётр Родов', 'm', '1930', '2011', { occupation: 'Инженер-мостостроитель', bio: 'Сын Ивана и Марии.' });
    const d = mk('Анна Соколова', 'f', '1933', '', { occupation: 'Врач-педиатр', bio: 'Супруга Петра.' });
    const e = mk('Елена Родова', 'f', '1960', '', { occupation: 'Архивист', bio: 'Дочь Петра и Анны. Собирает семейную историю.' });
    a.spouses = [b.id]; b.spouses = [a.id]; c.spouses = [d.id]; d.spouses = [c.id]; c.parents = [a.id, b.id]; e.parents = [c.id, d.id];
    return [a, b, c, d, e].map(person => ({ op: 'put', person, base: 0 }));
  }

  // ---------- импорт ----------
  function parseImport(buf, fallbackName) {
    let tree, media = new Map();
    if (buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4B) {
      let zip; try { zip = readZip(buf); } catch (e) { throw new HttpError(400, e.message); }
      const tj = zip.get('tree.json'); if (!tj) throw new HttpError(400, 'В архиве нет tree.json');
      try { tree = JSON.parse(tj().toString('utf8')); } catch (e) { throw new HttpError(400, 'tree.json повреждён: ' + e.message); }
      for (const [name, get] of zip) {
        const m = /(?:^|\/)media\/([^/]+)$/.exec(name);
        if (m) media.set(m[1], get);
      }
    } else {
      try { tree = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'Файл не похож на ZIP или JSON'); }
    }
    const raw = Array.isArray(tree?.people) ? Object.fromEntries(tree.people.map((p, i) => [p?.id || `i${i}`, p])) : tree?.people;
    if (!raw || typeof raw !== 'object') throw new HttpError(400, 'В файле нет списка людей');
    if (Object.keys(raw).length > 20000) throw new HttpError(400, 'Слишком много участников (максимум 20000)');
    return { name: String(tree.name || fallbackName || 'Импортированное древо'), raw, media };
  }

  // ---------- маршруты ----------
  const server = http.createServer(async (req, res) => {
    baseHeaders(req, res);
    const u = new URL(req.url, 'http://x'), route = u.pathname;
    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && !route.startsWith('/api/') && !route.startsWith('/media/') && !route.startsWith('/thumb/')) {
        if (route === '/healthz') return send(res, 200, { ok: true, users: store.userCount(), cloud: cloud.enabled ? { queue: store.outboxCount(), lastError: cloud.lastError } : null, snapshots: snaps.enabled ? { lastError: snaps.lastError } : null });
        if (route === '/.well-known/assetlinks.json') {   // подтверждение «приложение ↔ сайт» для APK (TWA): положите файл в data/assetlinks.json
          const f = path.join(DATA, 'assetlinks.json');
          if (!fs.existsSync(f)) return send(res, 404, { error: 'Не найдено' });
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' });
          return res.end(req.method === 'HEAD' ? undefined : fs.readFileSync(f));
        }
        if (serveStatic(req, res, route)) return;
        return send(res, 404, { error: 'Не найдено' });
      }
      if (apiIp.blocked(ipOf(req))) return send(res, 429, { error: 'Слишком много запросов. Подождите минуту.' });
      apiIp.add(ipOf(req));
      if (!['GET', 'HEAD'].includes(req.method)) checkMutation(req);

      // --- авторизация
      if (route === '/api/register' && req.method === 'POST') {
        const ip = ipOf(req), wait = regIp.blocked(ip);
        if (wait) return send(res, 429, { error: `Слишком много регистраций. Повторите через ${Math.ceil(wait / 60)} мин.` });
        const { username, password, invite } = await readJson(req, 10_000);
        const first = store.userCount() === 0, inv = invite ? store.inviteInfo(String(invite)) : null;
        if (invite && !inv) throw new HttpError(410, 'Приглашение недействительно или уже использовано. Попросите прислать новую ссылку.');
        if (!first && REG !== 'open' && !(inv && REG === 'invite'))
          throw new HttpError(403, REG === 'closed' ? 'Регистрация закрыта' : 'Регистрация только по приглашению: попросите родственника прислать ссылку');
        if (!/^[\p{L}\p{N}_.-]{3,32}$/u.test(String(username || ''))) throw new HttpError(400, 'Логин: 3–32 символа, буквы, цифры, _ . -');
        if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw new HttpError(400, 'Пароль должен быть от 8 символов');
        regIp.add(ip);
        const h = await hashPw(password);
        if (inv && !store.takeInvite(String(invite))) throw new HttpError(410, 'Приглашение уже использовано');
        let user;
        try { user = store.createUser({ username, salt: h.salt, hash: h.hash }); }
        catch (e) { if (inv) store.giveBackInvite(String(invite)); throw e; }          // логин занят — приглашение не сгорает
        if (inv) store.share(inv.treeId, user.id);
        setCookie(req, res, store.createSession(user.id));
        return send(res, 200, { user: publicUser(user), joined: inv ? inv.treeId : null });
      }
      if (route === '/api/public-info' && req.method === 'GET')       // для экрана входа: можно ли регистрироваться и адрес для ссылок
        return send(res, 200, { registration: REG, firstRun: store.userCount() === 0, publicUrl: env.PUBLIC_URL || null });
      if (route.startsWith('/api/invite/') && route !== '/api/invite/accept' && req.method === 'GET') {   // кто и куда приглашает (без входа)
        const ip = ipOf(req); if (inviteIp.blocked(ip)) return send(res, 429, { error: 'Слишком много запросов' });
        inviteIp.add(ip);
        const inv = store.inviteInfo(decodeURIComponent(route.slice('/api/invite/'.length)));
        return inv ? send(res, 200, { tree: inv.treeName, by: inv.by, exp: inv.exp }) : send(res, 404, { error: 'Приглашение недействительно или истекло' });
      }
      if (route === '/api/login' && req.method === 'POST') {
        const ip = ipOf(req), { username, password } = await readJson(req, 10_000), ukey = ip + '|' + String(username).toLowerCase();
        const wait = Math.max(loginIp.blocked(ip), loginUser.blocked(ukey));
        if (wait) return send(res, 429, { error: `Слишком много попыток входа. Повторите через ${Math.ceil(wait / 60)} мин.` });
        const user = store.userByName(String(username ?? ''));
        if (!(await checkPw(String(password ?? ''), user))) {
          loginIp.add(ip); loginUser.add(ukey);
          return send(res, 401, { error: 'Неверный логин или пароль' });
        }
        loginUser.reset(ukey);
        setCookie(req, res, store.createSession(user.id));
        return send(res, 200, { user: publicUser(user) });
      }
      if (route === '/api/logout' && req.method === 'POST') {
        store.deleteSession(tokenOf(req));
        setCookie(req, res, '', 0);
        return send(res, 200, {});
      }

      const sess = sessionOf(req);
      if (!sess) return send(res, 401, { error: 'auth' });
      const me = sess.user;

      // Владелец сервера: логины из ROD_ADMINS (через запятую), иначе — первый зарегистрированный аккаунт.
      const ADMINS = (env.ROD_ADMINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
      const isAdmin = u => (ADMINS.length ? ADMINS.includes(u.username.toLowerCase()) : u.id === store.firstUserId());

      if (route === '/api/me' && req.method === 'GET') {
        return send(res, 200, { user: { ...publicUser(me), admin: isAdmin(me) }, trees: store.treesFor(me.id) });
      }
      if (route === '/api/admin/backup' && req.method === 'GET') {   // полная копия ВСЕХ данных сервера: только владельцу
        if (!isAdmin(me)) return send(res, 403, { error: 'Полную копию может скачать только владелец сервера' });
        if (backupBusy) return send(res, 429, { error: 'Копия уже готовится — подождите минуту' });
        backupBusy = true;
        let bk;
        try { bk = prepareBackup(store, DATA); }
        catch (e) { backupBusy = false; console.error('backup:', e.message); return send(res, 500, { error: 'Не удалось подготовить копию: ' + e.message }); }
        res.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${bk.name}"` });
        try {
          for await (const chunk of zipStream(bk.entries)) if (!res.write(chunk)) await once(res, 'drain');
          res.end();
        } catch (e) { console.error('backup stream:', e.message); res.destroy(); }
        finally { bk.cleanup(); backupBusy = false; }
        return;
      }
      if (route === '/api/invite/accept' && req.method === 'POST') {
        const ip = ipOf(req); if (inviteIp.blocked(ip)) return send(res, 429, { error: 'Слишком много запросов' });
        inviteIp.add(ip);
        const token = String((await readJson(req, 10_000)).token ?? ''), anyTree = store.inviteTreeAny(token);
        if (anyTree && store.canAccess(me.id, anyTree))            // уже в древе (повторно открыли ссылку): ничего не тратим
          return send(res, 200, { treeId: anyTree, tree: store.treeMeta(anyTree).name, already: true });
        const inv = store.inviteInfo(token);
        if (!inv) throw new HttpError(410, 'Приглашение недействительно или истекло');
        if (!store.takeInvite(token)) throw new HttpError(410, 'Приглашение уже использовано');
        store.share(inv.treeId, me.id);
        return send(res, 200, { treeId: inv.treeId, tree: inv.treeName, already: false });
      }
      if (route === '/api/password' && req.method === 'POST') {
        const { oldPassword, newPassword } = await readJson(req, 10_000);
        if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) throw new HttpError(400, 'Новый пароль должен быть от 8 символов');
        const wait = loginUser.blocked('pw|' + me.id);
        if (wait) return send(res, 429, { error: 'Слишком много попыток. Повторите позже.' });
        if (!(await checkPw(String(oldPassword ?? ''), me))) { loginUser.add('pw|' + me.id); throw new HttpError(403, 'Текущий пароль неверный'); }
        const h = await hashPw(newPassword);
        store.setPassword(me.id, h.salt, h.hash);
        store.deleteUserSessions(me.id, sess.token); // остальные устройства разлогиниваются
        return send(res, 200, {});
      }

      // --- древа
      if (route === '/api/trees' && req.method === 'POST') {
        const b = await readJson(req, 100_000);
        const name = cleanTreeName(b.name || 'Новое древо');
        const id = store.createTree({ owner: me.id, name });
        if (b.sample) store.commit(id, me.username, 'Образец древа', sampleOps());
        return send(res, 200, { id });
      }
      if (route === '/api/trees/import' && req.method === 'POST') {
        const buf = await readBody(req, MAX_IMPORT);
        const { name, raw, media } = parseImport(buf, u.searchParams.get('name'));
        const id = store.createTree({ owner: me.id, name: cleanTreeName(String(u.searchParams.get('name') || name).slice(0, 120)) });
        try {
          const dir = path.join(MEDIA, id); fs.mkdirSync(dir, { recursive: true });
          const people = normalizePeople(raw, id), photoMap = new Map();
          for (const p of Object.values(people)) {
            const orig = String((raw[p.id] || {}).photo || '').split('/').pop();
            const get = media.get(orig);
            p.photo = '';
            if (!get) continue;
            if (photoMap.has(orig)) { p.photo = photoMap.get(orig); continue; }
            try {
              const data = get(), ext = sniff(data);
              if (!ext || data.length > MAX_PHOTO) continue;
              const fname = crypto.randomUUID() + '.' + ext;
              fs.writeFileSync(path.join(dir, fname), data);
              p.photo = `/media/${id}/${fname}`; photoMap.set(orig, p.photo);
              cloud.enqueue(`media/${id}/${fname}`, EXT_MIME[ext], { file: path.join(dir, fname) });
            } catch { /* битый файл фото пропускаем */ }
          }
          for (const p of Object.values(people)) {            // вложенные документы: файлы из архива переезжают в новое древо
            const out = [];
            for (const d of (Array.isArray((raw[p.id] || {}).docs) ? raw[p.id].docs : []).slice(0, MAX_DOCS)) {
              const get = media.get(String(d?.file || '').split('/').pop());
              if (!get) continue;
              try {
                const data = get(), ext = sniffDoc(data);
                if (!ext || data.length > (ext === 'pdf' ? MAX_PDF : MAX_PHOTO)) continue;
                const fname = crypto.randomUUID() + '.' + ext;
                fs.writeFileSync(path.join(dir, fname), data);
                cloud.enqueue(`media/${id}/${fname}`, EXT_MIME[ext], { file: path.join(dir, fname) });
                const c = cleanDoc({ ...d, file: `/media/${id}/${fname}`, size: data.length }, id);
                if (c) out.push(c);
              } catch { /* битый файл документа пропускаем */ }
            }
            p.docs = out;
          }
          const ops = Object.values(people).map(person => ({ op: 'put', person, base: 0 }));
          if (ops.length) store.commit(id, me.username, `Импорт: ${Object.keys(people).length} чел.`, ops);
        } catch (e) { store.deleteTree(id); fs.rmSync(path.join(MEDIA, id), { recursive: true, force: true }); throw e; }
        return send(res, 200, { id, name: store.treeMeta(id).name });
      }

      const m = /^\/api\/trees\/([\w-]+)(?:\/([\w-]+))?$/.exec(route);
      if (m) {
        const treeId = m[1], sub = m[2] || '';
        if (!ID_RE.test(treeId) || !store.canAccess(me.id, treeId)) return send(res, 403, { error: 'Нет доступа к древу' });
        const meta = store.treeMeta(treeId);

        if (!sub && req.method === 'GET') {
          return send(res, 200, { ...store.loadTree(treeId), isOwner: meta.owner === me.id, collaborators: store.collaborators(treeId) });
        }
        if (!sub && req.method === 'DELETE') {
          if (meta.owner !== me.id) throw new HttpError(403, 'Удалить древо может только владелец');
          for (const c of clients) if (c.treeId === treeId) { c.ws.send(JSON.stringify({ type: 'deleted' })); c.ws.close(); }
          store.deleteTree(treeId);
          fs.rmSync(path.join(MEDIA, treeId), { recursive: true, force: true });
          fs.rmSync(path.join(THUMBS, treeId), { recursive: true, force: true });
          return send(res, 200, {});
        }
        if (sub === 'save' && req.method === 'POST') {
          const b = await readJson(req);
          const name = b.name === undefined ? undefined : cleanTreeName(b.name);
          const ops = Array.isArray(b.ops) ? b.ops : [];
          if (!ops.length && name === undefined) throw new HttpError(400, 'Нет изменений');
          const note = String(b.note || (ops.length ? 'Правка' : 'Переименование')).replace(/[\u0000-\u001F]/g, ' ').slice(0, 200);
          const patch = store.commit(treeId, me.username, note, ops, name);
          if (patch.noop) return send(res, 200, { noop: true, rev: patch.rev });
          return send(res, 200, publish(treeId, patch, b.cid));
        }
        if (sub === 'history' && req.method === 'GET') {
          return send(res, 200, { rev: meta.rev, items: store.history(treeId, Math.min(500, Number(u.searchParams.get('limit')) || 100)) });
        }
        if (sub === 'restore' && req.method === 'POST') {
          const b = await readJson(req, 10_000);
          return send(res, 200, publish(treeId, store.restore(treeId, me.username, b.rev), b.cid));
        }
        if (sub === 'photo' && req.method === 'POST') {
          const data = await readBody(req, MAX_PHOTO);
          const ext = sniff(data);
          if (!ext) throw new HttpError(400, 'Нужен JPG, PNG или WebP');
          const dir = path.join(MEDIA, treeId); fs.mkdirSync(dir, { recursive: true });
          const name = crypto.randomUUID() + '.' + ext;
          fs.writeFileSync(path.join(dir, name), data);
          cloud.enqueue(`media/${treeId}/${name}`, EXT_MIME[ext], { file: path.join(dir, name) });
          if (sharp) thumbFile(treeId, name, 's').catch(() => {});
          return send(res, 200, { url: `/media/${treeId}/${name}` });
        }
        if (sub === 'doc' && req.method === 'POST') {       // вложенный документ: PDF или фото (без пережатия)
          const data = await readBody(req, Math.max(MAX_PHOTO, MAX_PDF));
          const ext = sniffDoc(data);
          if (!ext) throw new HttpError(400, 'Нужен PDF, JPG, PNG или WebP');
          if (ext === 'pdf' && data.length > MAX_PDF) throw new HttpError(413, `PDF больше ${Math.round(MAX_PDF / 1048576)} МБ`);
          if (ext !== 'pdf' && data.length > MAX_PHOTO) throw new HttpError(413, `Фото больше ${Math.round(MAX_PHOTO / 1048576)} МБ`);
          const dir = path.join(MEDIA, treeId); fs.mkdirSync(dir, { recursive: true });
          const name = crypto.randomUUID() + '.' + ext;
          fs.writeFileSync(path.join(dir, name), data);
          cloud.enqueue(`media/${treeId}/${name}`, EXT_MIME[ext], { file: path.join(dir, name) });
          if (sharp && ext !== 'pdf') thumbFile(treeId, name, 's').catch(() => {});
          return send(res, 200, { url: `/media/${treeId}/${name}`, type: EXT_MIME[ext], size: data.length });
        }
        if (sub === 'preview-merge' && req.method === 'POST') {
          const buf = await readBody(req, MAX_IMPORT);
          const { raw } = parseImport(buf, 'preview');
          const current = store.loadPeople(treeId);
          const incoming = normalizePeople(raw, treeId);
          const diff = [];
          
          for (const id of new Set([...Object.keys(current), ...Object.keys(incoming)])) {
            const c = current[id], i = incoming[id];
            const sC = c ? JSON.stringify(strip(c)) : null;
            const sI = i ? JSON.stringify(strip(i)) : null;
            
            if (sC !== sI) {
              const conflicts = [];
              if (c && i) {
                for (const k of ['name', 'birth', 'death', 'birthPlace', 'occupation', 'bio']) {
                  if (JSON.stringify(c[k]) !== JSON.stringify(i[k])) conflicts.push(k);
                }
              }
              diff.push({ id, type: !c ? 'add' : !i ? 'del' : 'edit', name: (i || c).name, conflicts });
            }
          }
          return send(res, 200, { diff });
        }

        if (sub === 'apply-merge' && req.method === 'POST') {
          const ids = new Set((u.searchParams.get('ids') || '').split(','));
          const buf = await readBody(req, MAX_IMPORT);
          const { raw } = parseImport(buf, 'merge');
          const incoming = normalizePeople(raw, treeId);
          const current = store.loadPeople(treeId);
          const ops = [];
          
          for (const id of ids) {
            if (incoming[id]) {
              const c = current[id];
              let mergedPerson = { ...incoming[id] };
              
              if (c) {
                mergedPerson = { ...c };
                const textFields = ['maidenName', 'birthPlace', 'deathPlace', 'school', 'education', 'occupation', 'workplace', 'address'];
                
                for (const k in incoming[id]) {
                  const oldV = c[k], newV = incoming[id][k];
                  if (JSON.stringify(oldV) === JSON.stringify(newV) || !newV) continue;
                  
                  if (!oldV) {
                    mergedPerson[k] = newV;
                  } else if (textFields.includes(k) && typeof oldV === 'string' && typeof newV === 'string') {
                    mergedPerson[k] = oldV.includes(newV) ? oldV : oldV + ' / ' + newV;
                  } else if (k === 'bio') {
                    mergedPerson.bio = oldV + '\n\n[Из слияния]:\n' + newV;
                  } else if (k === 'birth' || k === 'death') {
                    mergedPerson.bio = (mergedPerson.bio || '') + '\n[Слияние: ' + k + ' = ' + newV + ']';
                  }
                }
              }
              ops.push({ op: 'put', person: mergedPerson, base: c?.r || 0 });
            } else {
              ops.push({ op: 'del', id, base: current[id]?.r || 0 });
            }
          }
          
          if (ops.length) {
            const patch = store.commit(treeId, me.username, 'Умное слияние данных из архива', ops);
            return send(res, 200, publish(treeId, patch));
          }
          return send(res, 200, { noop: true });
        }

        if (sub === 'share' && req.method === 'POST') {
          if (meta.owner !== me.id) throw new HttpError(403, 'Приглашать может только владелец');
          const other = store.userByName(String((await readJson(req, 10_000)).username ?? ''));
          if (!other) throw new HttpError(404, 'Пользователь не найден');
          if (other.id === me.id) throw new HttpError(400, 'Вы уже владелец этого древа');
          store.share(treeId, other.id);
          return send(res, 200, { collaborators: store.collaborators(treeId) });
        }
        if (sub === 'invites') {   // ссылки-приглашения: только владелец древа
          if (meta.owner !== me.id) throw new HttpError(403, 'Приглашать может только владелец');
          if (req.method === 'GET') return send(res, 200, { invites: store.invitesOf(treeId) });
          if (req.method === 'POST') {
            const b = await readJson(req, 10_000);
            const days = Math.min(30, Math.max(1, Math.floor(Number(b.days) || 7))), uses = Math.min(20, Math.max(1, Math.floor(Number(b.uses) || 1)));
            if (store.invitesOf(treeId).length >= 50) throw new HttpError(400, 'Слишком много активных приглашений — отзовите ненужные');
            return send(res, 200, { token: store.createInvite(treeId, me.id, { days, uses, note: String(b.note ?? '') }), days, uses });
          }
          if (req.method === 'DELETE') { const b = await readJson(req, 10_000); return send(res, 200, { ok: store.revokeInvite(treeId, String(b.id ?? '')) }); }
        }
        if (sub === 'unshare' && req.method === 'POST') {
          if (meta.owner !== me.id) throw new HttpError(403, 'Только владелец');
          const { userId } = await readJson(req, 10_000);
          store.unshare(treeId, String(userId));
          for (const c of clients) if (c.treeId === treeId && c.userId === userId) { c.ws.send(JSON.stringify({ type: 'deleted' })); c.ws.close(); }
          return send(res, 200, { collaborators: store.collaborators(treeId) });
        }
        if (sub === 'export' && req.method === 'GET') {
          const tree = store.loadTree(treeId);
          const entries = buildExportEntries(tree, path.join(MEDIA, treeId));
          const fname = exportFileName(tree);
          res.writeHead(200, { 'Content-Type': 'application/zip', 'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename="${fname}"` });
          try {
            for await (const chunk of zipStream(entries)) if (!res.write(chunk)) await once(res, 'drain');
            res.end();
          } catch (e) { console.error('export:', e.message); res.destroy(); }
          return;
        }
        return send(res, 404, { error: 'Не найдено' });
      }

      // --- фото (оригинал / миниатюра)
      const mm = /^\/(media|thumb)\/([\w-]+)\/([\w-]+\.(?:jpg|png|webp|pdf))$/.exec(route);
      if (mm && (req.method === 'GET' || req.method === 'HEAD')) {
        if (!ID_RE.test(mm[2]) || !store.canAccess(me.id, mm[2])) return send(res, 403, { error: 'Нет доступа' });
        const cache = 'private, max-age=31536000, immutable';
        if (mm[1] === 'media') {
          const f = path.join(MEDIA, mm[2], mm[3]);
          if (!fs.existsSync(f)) return send(res, 404, { error: 'Не найдено' });
          return sendFile(req, res, f, EXT_MIME[path.extname(f).slice(1)], cache);
        }
        if (mm[3].endsWith('.pdf')) return send(res, 404, { error: 'У PDF нет миниатюры' });
        const size = SIZES[u.searchParams.get('s')] ? u.searchParams.get('s') : 's';
        const t = await thumbFile(mm[2], mm[3], size);
        if (!t) return send(res, 404, { error: 'Не найдено' });
        return sendFile(req, res, t.file, t.ctype, cache);
      }
      send(res, 404, { error: 'Не найдено' });
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...e.extra });
      console.error(`${req.method} ${req.url}:`, e);
      if (!res.headersSent) send(res, 500, { error: 'Внутренняя ошибка сервера' });
      else res.destroy();
    }
  });

  server.on('upgrade', (req, socket, head) => {
    try {
      const u = new URL(req.url, 'http://x');
      if (u.pathname !== '/ws') return socket.destroy();
      const o = req.headers.origin;
      if (o) { let h; try { h = new URL(o).host; } catch { h = ''; } if (h !== req.headers.host) return socket.destroy(); }
      const sess = sessionOf(req), treeId = u.searchParams.get('tree') || '';
      if (!sess || !ID_RE.test(treeId) || !store.canAccess(sess.user.id, treeId)) return socket.destroy();
      wss.handleUpgrade(req, socket, head, ws => {
        const c = { ws, treeId, userId: sess.user.id, alive: true };
        clients.add(c);
        ws.on('pong', () => { c.alive = true; });
        ws.on('error', () => {});
        ws.on('close', () => { clients.delete(c); if (!closed) presence(treeId); });
        ws.on('message', () => { c.alive = true; });
        const tree = store.loadTree(treeId);
        ws.send(JSON.stringify({ type: 'hello', doc: { ...tree, isOwner: tree.owner === sess.user.id, collaborators: store.collaborators(treeId) } }));
        presence(treeId);
      });
    } catch { socket.destroy(); }
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, opts.host || env.HOST || '0.0.0.0', resolve); });
  const port = server.address().port;

  async function close() {
    closed = true;
    clearInterval(heartbeat); clearInterval(sweeper); cloud.stop(); snaps.stop();
    for (const c of clients) c.ws.terminate();
    wss.close();
    server.closeAllConnections?.();
    await new Promise(r => server.close(r));
    store.close();
  }
  return { server, store, cloud, snaps, port, close, DATA };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await startServer();
  console.log(`Род → http://localhost:${app.port}  (данные: ${app.DATA}, облако: ${app.cloud.enabled ? 'включено' : 'выключено'}, копии правок: ${app.snaps.enabled ? app.snaps.dir : 'выключены'}, миниатюры: ${sharp ? 'sharp' : 'нет'})`);
  const stop = async () => { await app.cloud.drain().catch(() => {}); await app.close(); process.exit(0); };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}
