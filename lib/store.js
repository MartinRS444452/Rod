import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { applyOps, diffStates, stateAt, summarize, strip } from './tree.js';
import { HttpError, fillDefaults } from './validate.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT NOT NULL, username_lc TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS trees(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS collaborators(tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(tree_id, user_id));
CREATE TABLE IF NOT EXISTS people(tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE, id TEXT NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(tree_id, id));
CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL, ts INTEGER NOT NULL, author TEXT NOT NULL, note TEXT NOT NULL, diff TEXT NOT NULL, UNIQUE(tree_id, rev));
CREATE TABLE IF NOT EXISTS outbox(id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, ctype TEXT NOT NULL,
  body BLOB, file TEXT, tries INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites(token_hash TEXT PRIMARY KEY, tree_id TEXT NOT NULL REFERENCES trees(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL, created INTEGER NOT NULL, exp INTEGER NOT NULL, uses_left INTEGER NOT NULL, note TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
`;

export const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();

const shaHex = t => crypto.createHash('sha256').update(String(t)).digest('hex');

export class Store {
  constructor(dataDir, { historyLimit = 1000 } = {}) {
    this.db = new DatabaseSync(path.join(dataDir, 'rod.db'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
    this.db.exec(SCHEMA);
    this.historyLimit = historyLimit;
    this.onCommit = null;
    this.q = {};
  }
  p(sql) { return (this.q[sql] ??= this.db.prepare(sql)); }
  tx(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* уже закрыта */ } throw e; }
  }
  close() { this.db.close(); }

  // ---- мета
  meta(k) { return this.p('SELECT v FROM meta WHERE k=?').get(k)?.v ?? null; }
  setMeta(k, v) { this.p('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, String(v)); }
  firstUserId() { return this.p('SELECT id FROM users ORDER BY created, rowid LIMIT 1').get()?.id ?? null; }
  userCount() { return this.p('SELECT COUNT(*) n FROM users').get().n; }

  // ---- пользователи и сессии
  userByName(name) { return this.p('SELECT * FROM users WHERE username_lc=?').get(String(name).toLowerCase()) ?? null; }
  userById(id) { return this.p('SELECT * FROM users WHERE id=?').get(id) ?? null; }
  createUser({ id = uid(), username, salt, hash, created = Date.now() }) {
    try { this.p('INSERT INTO users(id,username,username_lc,salt,hash,created) VALUES(?,?,?,?,?,?)').run(id, username, username.toLowerCase(), salt, hash, created); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'Логин занят'); throw e; }
    return this.userById(id);
  }
  setPassword(id, salt, hash) { this.p('UPDATE users SET salt=?,hash=? WHERE id=?').run(salt, hash, id); }
  createSession(userId, ttlMs = 30 * 86400e3) {
    const token = crypto.randomBytes(32).toString('hex');
    this.p('INSERT INTO sessions(token_hash,user_id,exp) VALUES(?,?,?)').run(sha256(token), userId, Date.now() + ttlMs);
    return token;
  }
  sessionUser(token) {
    if (!token) return null;
    const s = this.p('SELECT user_id, exp FROM sessions WHERE token_hash=?').get(sha256(token));
    if (!s) return null;
    if (s.exp < Date.now()) { this.deleteSession(token); return null; }
    return this.userById(s.user_id);
  }
  deleteSession(token) { if (token) this.p('DELETE FROM sessions WHERE token_hash=?').run(sha256(token)); }
  deleteUserSessions(userId, exceptToken = null) {
    this.p('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(userId, exceptToken ? sha256(exceptToken) : '');
  }
  purgeSessions() { this.p('DELETE FROM sessions WHERE exp<?').run(Date.now()); }

  // ---- древа
  treesFor(userId) {
    return this.p(`SELECT t.id,t.name,t.owner,t.rev,t.updated_at updatedAt,
        (SELECT COUNT(*) FROM people p WHERE p.tree_id=t.id) count
      FROM trees t WHERE t.owner=?1 OR EXISTS(SELECT 1 FROM collaborators c WHERE c.tree_id=t.id AND c.user_id=?1)
      ORDER BY t.updated_at DESC`).all(userId);
  }
  treeMeta(id) { return this.p('SELECT id,name,owner,rev,updated_at updatedAt FROM trees WHERE id=?').get(id) ?? null; }
  canAccess(userId, treeId) {
    return !!this.p(`SELECT 1 x FROM trees t WHERE t.id=?2 AND (t.owner=?1 OR EXISTS(SELECT 1 FROM collaborators c WHERE c.tree_id=t.id AND c.user_id=?1))`).get(userId, treeId);
  }
  collaborators(treeId) {
    return this.p('SELECT u.id,u.username FROM collaborators c JOIN users u ON u.id=c.user_id WHERE c.tree_id=? ORDER BY u.username').all(treeId);
  }
  // ---- приглашения по ссылке: в базе только хеш токена, сама ссылка показывается один раз при создании
  createInvite(treeId, userId, { days = 7, uses = 1, note = '' } = {}) {
    const token = crypto.randomBytes(24).toString('base64url'), now = Date.now();
    this.p('INSERT INTO invites(token_hash,tree_id,created_by,created,exp,uses_left,note) VALUES(?,?,?,?,?,?,?)')
      .run(shaHex(token), treeId, userId, now, now + days * 86400e3, uses, String(note).slice(0, 60));
    return token;
  }
  invitesOf(treeId) {
    this.p('DELETE FROM invites WHERE exp<=?').run(Date.now() - 7 * 86400e3);       // использованные/просроченные хранятся ещё неделю: повторное открытие ссылки скажет «вы уже в древе»
    return this.p('SELECT token_hash,created,exp,uses_left,note FROM invites WHERE tree_id=? AND exp>? AND uses_left>0 ORDER BY created DESC').all(treeId, Date.now())
      .map(r => ({ id: r.token_hash.slice(0, 12), created: r.created, exp: r.exp, usesLeft: r.uses_left, note: r.note }));
  }
  revokeInvite(treeId, handle) { return this.p('DELETE FROM invites WHERE tree_id=? AND substr(token_hash,1,12)=?').run(treeId, String(handle)).changes > 0; }
  inviteInfo(token) {
    const r = this.p(`SELECT i.tree_id, t.name AS tree_name, u.username AS by_name, i.exp FROM invites i JOIN trees t ON t.id=i.tree_id JOIN users u ON u.id=i.created_by
      WHERE i.token_hash=? AND i.exp>? AND i.uses_left>0`).get(shaHex(token), Date.now());
    return r ? { treeId: r.tree_id, treeName: r.tree_name, by: r.by_name, exp: r.exp } : null;
  }
  inviteTreeAny(token) { return this.p('SELECT tree_id FROM invites WHERE token_hash=?').get(shaHex(token))?.tree_id ?? null; }   // для «вы уже в этом древе»
  takeInvite(token) { return this.p('UPDATE invites SET uses_left=uses_left-1 WHERE token_hash=? AND exp>? AND uses_left>0').run(shaHex(token), Date.now()).changes === 1; }
  giveBackInvite(token) { this.p('UPDATE invites SET uses_left=uses_left+1 WHERE token_hash=?').run(shaHex(token)); }

  share(treeId, userId) { this.p('INSERT OR IGNORE INTO collaborators(tree_id,user_id) VALUES(?,?)').run(treeId, userId); }
  unshare(treeId, userId) { this.p('DELETE FROM collaborators WHERE tree_id=? AND user_id=?').run(treeId, userId); }
  loadPeople(treeId) {
    const out = {};
    for (const r of this.p('SELECT id,data FROM people WHERE tree_id=?').all(treeId)) out[r.id] = fillDefaults(JSON.parse(r.data));
    return out;
  }
  loadTree(treeId) {
    const m = this.treeMeta(treeId);
    return m && { ...m, people: this.loadPeople(treeId) };
  }
  createTree({ id = uid(), owner, name }) {
    this.p('INSERT INTO trees(id,name,owner,rev,updated_at) VALUES(?,?,?,1,?)').run(id, name, owner, Date.now());
    return id;
  }
  deleteTree(id) { this.p('DELETE FROM trees WHERE id=?').run(id); }

  // ---- правки и история
  _write(tree, author, note, newPeople, changes, newName) {
    const rev = tree.rev + 1, ts = Date.now();
    for (const [id, [, a]] of Object.entries(changes)) {
      if (a === null) this.p('DELETE FROM people WHERE tree_id=? AND id=?').run(tree.id, id);
      else this.p('INSERT INTO people(tree_id,id,data) VALUES(?,?,?) ON CONFLICT(tree_id,id) DO UPDATE SET data=excluded.data')
        .run(tree.id, id, JSON.stringify({ ...a, r: rev }));
    }
    const nameChange = newName !== tree.name ? [tree.name, newName] : null;
    this.p('UPDATE trees SET rev=?, name=?, updated_at=? WHERE id=?').run(rev, newName, ts, tree.id);
    const diff = { name: nameChange, changes };
    const entryId = uid();
    this.p('INSERT INTO history(id,tree_id,rev,ts,author,note,diff) VALUES(?,?,?,?,?,?,?)')
      .run(entryId, tree.id, rev, ts, author, note, JSON.stringify(diff));
    this.p('DELETE FROM history WHERE tree_id=? AND rev<=?').run(tree.id, rev - this.historyLimit);
    const upserts = {}, removes = [];
    for (const [id, [, a]] of Object.entries(changes)) { if (a) upserts[id] = { ...a, r: rev }; else removes.push(id); }
    return { rev, baseRev: tree.rev, ts, name: newName, nameChanged: !!nameChange, upserts, removes, by: author, note, diff, entryId };
  }

  /** Применяет пачку операций. Возвращает патч для клиентов или {noop:true}. */
  commit(treeId, author, note, ops, name) {
    const patch = this.tx(() => {
      const tree = this.treeMeta(treeId);
      if (!tree) throw new HttpError(404, 'Древо не найдено');
      const cur = this.loadPeople(treeId);
      const { changes } = ops?.length ? applyOps(cur, ops, tree.rev + 1, treeId) : { changes: {} };
      const newName = name ?? tree.name;
      if (!Object.keys(changes).length && newName === tree.name) return { noop: true, rev: tree.rev };
      return this._write(tree, author, note, null, changes, newName);
    });
    if (!patch.noop) this._emit(treeId, patch);
    return patch;
  }

  /** Восстанавливает состояние на момент ревизии rev (создаёт НОВУЮ ревизию). */
  restore(treeId, author, rev) {
    const patch = this.tx(() => {
      const tree = this.treeMeta(treeId);
      if (!tree) throw new HttpError(404, 'Древо не найдено');
      if (!Number.isInteger(rev) || rev < 1 || rev >= tree.rev) throw new HttpError(400, 'Нельзя восстановить эту версию');
      const entries = this.p('SELECT rev,diff FROM history WHERE tree_id=? AND rev>? ORDER BY rev DESC').all(treeId, rev)
        .map(r => ({ rev: r.rev, diff: JSON.parse(r.diff) }));
      const cur = this.loadPeople(treeId);
      const target = stateAt(cur, tree.name, tree.rev, rev, entries);
      const changes = diffStates(cur, target.people);
      if (!Object.keys(changes).length && target.name === tree.name) throw new HttpError(400, 'Состояние уже совпадает с этой версией');
      return this._write(tree, author, `Восстановление версии r${rev}`, null, changes, target.name);
    });
    this._emit(treeId, patch);
    return patch;
  }

  /** Приводит древо к состоянию из файла-копии (создаёт НОВУЮ ревизию; история не стирается). */
  restoreState(treeId, author, note, people, name) {
    const patch = this.tx(() => {
      const tree = this.treeMeta(treeId);
      if (!tree) throw new HttpError(404, 'Древо не найдено');
      const cur = this.loadPeople(treeId), changes = diffStates(cur, people);
      if (!Object.keys(changes).length && (!name || name === tree.name)) throw new HttpError(400, 'Состояние уже совпадает с файлом');
      return this._write(tree, author, note, null, changes, name || tree.name);
    });
    this._emit(treeId, patch);
    return patch;
  }

  _emit(treeId, patch) { try { this.onCommit?.(treeId, patch); } catch (e) { console.error('onCommit:', e.message); } }

  history(treeId, limit = 100) {
    return this.p('SELECT id,rev,ts,author,note,diff FROM history WHERE tree_id=? ORDER BY rev DESC LIMIT ?').all(treeId, limit)
      .map(r => ({ id: r.id, rev: r.rev, ts: r.ts, author: r.author, note: r.note, changes: summarize(JSON.parse(r.diff)), renamed: !!JSON.parse(r.diff).name }));
  }

  // ---- очередь облака
  outboxPut(key, ctype, { body = null, file = null }) {
    this.p(`INSERT INTO outbox(key,ctype,body,file,tries,next_at,created) VALUES(?,?,?,?,0,?,?)
      ON CONFLICT(key) DO UPDATE SET body=excluded.body, file=excluded.file, ctype=excluded.ctype, tries=0, next_at=excluded.next_at`)
      .run(key, ctype, body, file, Date.now(), Date.now());
  }
  outboxDue(limit = 5) { return this.p('SELECT * FROM outbox WHERE next_at<=? ORDER BY id LIMIT ?').all(Date.now(), limit); }
  outboxDone(id) { this.p('DELETE FROM outbox WHERE id=?').run(id); }
  outboxFail(id, tries) {
    this.p('UPDATE outbox SET tries=?, next_at=? WHERE id=?').run(tries, Date.now() + Math.min(3600e3, 5000 * 2 ** Math.min(tries, 10)), id);
  }
  outboxCount() { return this.p('SELECT COUNT(*) n FROM outbox').get().n; }

  /** Согласованная копия БД для бэкапа. */
  backupTo(file) { this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`); }
}
export { strip };
