// Подсветка семей: по фамилии и «одна семья». Чистые функции без DOM — их проверяют юнит-тесты.
import { lineage, relatives } from './layout.js';

const arr = v => (Array.isArray(v) ? v : []);
const clean = s => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-яіїєґ'’-]/g, '');

/** Ключ фамилии: мужская и женская формы дают один и тот же ключ (Родов/Родова, Демуцкий/Демуцкая, Левицька/Левицький). */
export function surnameKey(token) {
  let k = clean(token).replace(/[’']/g, '');
  if (k.length < 3) return k;
  k = k.replace(/(цкая|цкий|цька|цький)$/, 'цк').replace(/(ская|ский|ська|ський)$/, 'ск');
  k = k.replace(/(ова|ева|ина|ына)$/, m => m.slice(0, -1));
  k = k.replace(/(ая|яя|ый|ий|ой)$/, '');
  return k;
}

// Похожесть слова на фамилию: 2 — уверенно, 1 — возможно, 0 — скорее имя.
const NOT_SURNAMES = new Set(['лев', 'яков', 'пров', 'алевтина', 'валентина', 'галина', 'екатерина', 'катерина', 'ирина', 'марина', 'полина', 'регина', 'альбина', 'кристина', 'карина', 'дина', 'зинаида', 'эдуард', 'никита', 'илья', 'кузьма', 'фома', 'савва', 'дмитрий', 'юрий', 'василий', 'андрей', 'сергей', 'алексей', 'евгений', 'аркадий', 'геннадий', 'анатолий', 'виталий', 'валерий', 'григорий', 'николай', 'валентин', 'константин', 'владимир', 'любовь']);
function score(tok) {
  const k = clean(tok);
  if (k.length < 3 || NOT_SURNAMES.has(k)) return 0;
  if (/(ов|ова|ев|ева|ёв|ёва|ский|ская|цкий|цкая|ський|ська|цький|цька|енко|нко|ук|юк|чук|ич|ович|евич|ко)$/.test(k)) return 2;
  if (/(ин|ина|ына|ый|ий|ой|ая|ян|ак|як)$/.test(k)) return 1;
  return 0;
}
const tokens = name => String(name ?? '').replace(/\([^)]*\)/g, ' ').split(/[\s,]+/).filter(t => clean(t));

/** Порядок слов в древе: 'first' («Мартыненко Роман») или 'last' («Иван Родов») — по большинству уверенных случаев. */
export function detectOrder(people) {
  let first = 0, last = 0;
  for (const p of Object.values(people)) {
    const t = tokens(p.name);
    if (t.length < 2) continue;
    const a = score(t[0]), b = score(t[t.length - 1]);
    if (a > b) first++; else if (b > a) last++;
  }
  return first > last ? 'first' : 'last';
}

/** Слово-фамилия в имени человека или null. */
export function surnameToken(name, order = 'last') {
  const t = tokens(name);
  if (!t.length) return null;
  if (t.length === 1) return score(t[0]) > 0 ? t[0] : null;
  const sc = t.map(score), max = Math.max(...sc);
  if (max === 0) return order === 'first' ? t[0] : t[t.length - 1];
  const cands = t.filter((_, i) => sc[i] === max);
  return cands.length === 1 ? cands[0] : (order === 'first' ? cands[0] : cands[cands.length - 1]);
}

/** Индекс фамилий дерева: у кого какая (в т. ч. девичья) и список для выбора с количеством людей. */
export function surnameIndex(people) {
  const order = detectOrder(people), byId = new Map(), groups = new Map();
  const forms = new Map();
  const seen = (key, tok) => { const m = forms.get(key) ?? forms.set(key, new Map()).get(key); m.set(tok, (m.get(tok) || 0) + 1); };
  for (const p of Object.values(people)) {
    const cur = surnameToken(p.name, order), mt = tokens(p.maidenName)[0] || null;
    const e = { cur: cur ? surnameKey(cur) : null, maiden: mt ? surnameKey(mt) : null };
    if (e.cur) seen(e.cur, cur);
    if (e.maiden) seen(e.maiden, mt);
    byId.set(p.id, e);
    for (const [key, kind] of [[e.cur, 'cur'], [e.maiden && e.maiden !== e.cur ? e.maiden : null, 'maiden']]) {
      if (!key) continue;
      const g = groups.get(key) ?? groups.set(key, { key, count: 0, maidenOnly: 0 }).get(key);
      if (kind === 'cur') g.count++; else g.maidenOnly++;
    }
  }
  const label = key => { // предпочитаем мужскую форму, иначе самую частую
    const f = [...forms.get(key)].sort((a, b) => b[1] - a[1]);
    return (f.find(([t]) => /(ов|ев|ёв|ин|ын|ий|ый|ой|ский|цкий)$/i.test(t)) || f[0])[0];
  };
  const list = [...groups.values()].map(g => ({ ...g, label: label(g.key) }))
    .sort((a, b) => (b.count + b.maidenOnly) - (a.count + a.maidenOnly) || a.label.localeCompare(b.label, 'ru'));
  return { byId, list, order };
}

/** Люди с данной фамилией (ключом); includeMaiden — добавить женщин, для которых она девичья. */
export function surnameSet(people, key, includeMaiden = true, index = surnameIndex(people)) {
  const set = new Set();
  for (const [id, e] of index.byId) if (e.cur === key || (includeMaiden && e.maiden === key)) set.add(id);
  return set;
}

/** «Одна семья». own — человек, супруги и дети; parents — родители и все их дети; branch — все предки и потомки. */
export function familySet(people, id, mode = 'own') {
  if (!people[id]) return new Set();
  if (mode === 'branch') return lineage(people, id);
  const r = relatives(people, id), set = new Set([id]);
  if (mode === 'parents') { r.parents.forEach(x => set.add(x)); r.siblings.forEach(x => set.add(x)); r.parents.forEach(p => relatives(people, p).spouses.forEach(s => r.parents.length < 2 && set.add(s))); }
  else { r.spouses.forEach(x => set.add(x)); r.children.forEach(x => set.add(x)); for (const c of r.children) arr(people[c].parents).forEach(x => people[x] && set.add(x)); }
  return set;
}
