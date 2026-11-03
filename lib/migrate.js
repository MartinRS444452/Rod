// Миграция со старого формата (users.json, trees.json, history-*.json, sessions.json) в SQLite.
// Старые файлы не удаляются, а переименовываются в *.migrated — откат возможен.
import fs from 'node:fs';
import path from 'node:path';
import { applyOps, diffStates } from './tree.js';
import { lenientPerson } from './validate.js';
import { sha256 } from './store.js';

const readJson = (f, fb) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } };

/** Приводит «сырой» набор людей к нормализованному (симметрия связей, без битых ссылок). */
export function normalizePeople(raw, treeId) {
  const list = Object.entries(raw || {}).map(([k, v], i) => lenientPerson(v, treeId, `legacy-${String(i).padStart(6, '0')}-${k}`.slice(0, 64)));
  const seen = new Set(), uniq = [];
  for (const p of list) if (!seen.has(p.id)) { seen.add(p.id); uniq.push(p); }
  const ops = uniq.map(person => ({ op: 'put', person, base: 0 }));
  if (!ops.length) return {};
  try { return stripR(applyOps({}, ops, 1, treeId, { union: true }).people); }
  catch {
    // цикл родства или иная аномалия: сохраняем людей, но разрываем «родительские» связи
    const flat = uniq.map(p => ({ op: 'put', person: { ...p, parents: [] }, base: 0 }));
    return stripR(applyOps({}, flat, 1, treeId, { union: true }).people);
  }
}
const stripR = people => Object.fromEntries(Object.entries(people).map(([id, { r, ...p }]) => [id, p])); // eslint-disable-line no-unused-vars

export function migrateLegacy(store, dataDir, log = console.log) {
  const usersF = path.join(dataDir, 'users.json'), treesF = path.join(dataDir, 'trees.json');
  if (store.meta('legacy_migrated') || !fs.existsSync(usersF) || store.userCount() > 0) return null;
  const users = readJson(usersF, []), trees = readJson(treesF, {}), sessions = readJson(path.join(dataDir, 'sessions.json'), {});
  const stat = { users: 0, trees: 0, people: 0, history: 0, sessions: 0 };

  store.tx(() => {
    const userIds = new Set();
    for (const u of users) {
      if (!u?.id || !u.username || !u.pass?.salt || !u.pass?.hash) continue;
      try { store.createUser({ id: u.id, username: u.username, salt: u.pass.salt, hash: u.pass.hash, created: u.created || Date.now() }); userIds.add(u.id); stat.users++; }
      catch (e) { log('migrate: пропущен пользователь', u.username, e.message); }
    }
    for (const [token, s] of Object.entries(sessions)) {
      if (userIds.has(s?.userId) && s.exp > Date.now()) {
        store.p('INSERT OR IGNORE INTO sessions(token_hash,user_id,exp) VALUES(?,?,?)').run(sha256(token), s.userId, s.exp); stat.sessions++;
      }
    }
    for (const t of Object.values(trees)) {
      if (!t?.id || !userIds.has(t.owner)) continue;
      const people = normalizePeople(t.people, t.id);
      const rev = Math.max(1, Number(t.rev) || 1);
      store.p('INSERT INTO trees(id,name,owner,rev,updated_at) VALUES(?,?,?,?,?)').run(t.id, String(t.name || 'Древо').slice(0, 120), t.owner, rev, t.updatedAt || Date.now());
      for (const c of t.collaborators || []) if (userIds.has(c)) store.share(t.id, c);
      for (const [id, p] of Object.entries(people)) {
        store.p('INSERT INTO people(tree_id,id,data) VALUES(?,?,?)').run(t.id, id, JSON.stringify({ ...p, r: rev }));
        stat.people++;
      }
      // история: полные снимки → диффы
      const hist = readJson(path.join(dataDir, `history-${t.id}.json`), []).filter(h => h?.snapshot && Number.isInteger(h.rev)).sort((a, b) => a.rev - b.rev);
      let prev = {}, prevName = null;
      for (const h of hist) {
        const cur = normalizePeople(h.snapshot.people, t.id);
        const diff = { name: prevName !== null && prevName !== h.snapshot.name ? [prevName, h.snapshot.name] : null, changes: diffStates(prev, cur) };
        try {
          store.p('INSERT INTO history(id,tree_id,rev,ts,author,note,diff) VALUES(?,?,?,?,?,?,?)')
            .run(String(h.id || `${t.id}-${h.rev}`), t.id, h.rev, h.ts || Date.now(), String(h.author || '—'), String(h.note || ''), JSON.stringify(diff));
          stat.history++;
        } catch { /* дубликат ревизии */ }
        prev = cur; prevName = h.snapshot.name;
      }
      stat.trees++;
    }
    store.setMeta('legacy_migrated', new Date().toISOString());
  });
  for (const f of ['users.json', 'sessions.json', 'trees.json']) {
    const p = path.join(dataDir, f);
    if (fs.existsSync(p)) fs.renameSync(p, p + '.migrated');
  }
  for (const f of fs.readdirSync(dataDir)) if (/^history-.*\.json$/.test(f)) fs.renameSync(path.join(dataDir, f), path.join(dataDir, f + '.migrated'));
  log(`migrate: перенесено — пользователей ${stat.users}, древ ${stat.trees}, людей ${stat.people}, ревизий ${stat.history}`);
  return stat;
}
