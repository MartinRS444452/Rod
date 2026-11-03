// Чистые функции без DOM: работают и в браузере, и в Node (тесты, экспорт).

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Нормализация для поиска: регистр, ё/е, диакритика. */
export const norm = s => String(s ?? '').toLowerCase().replace(/ё/g, 'е')
  .normalize('NFKD').replace(/[\u0300-\u036f]/g, '').trim();

const words = s => norm(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** «Анна Соколова (урожд. Иванова)» */
export const fullName = p => (p.maidenName ? `${p.name} (урожд. ${p.maidenName})` : p.name);

/** Разбор даты: «1930», «1930-05-12», «12.05.1930», «около 1930». */
export function parseDate(s) {
  s = String(s ?? '').trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return mk(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(s);
  if (m) return mk(+m[3], +m[2], +m[1]);
  m = /(?<!\d)(\d{4})(?!\d)/.exec(s);
  if (m) return mk(+m[1], null, null);
  return null;
}
function mk(y, m, d) {
  if (y < 1 || y > 2200) return null;
  if (m !== null && (m < 1 || m > 12 || d < 1 || d > 31)) return { y, m: null, d: null };
  return { y, m, d };
}
export const yearOf = s => parseDate(s)?.y ?? null;

export const plural = (n, one, few, many) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  return b === 1 ? one : many;
};

/** «1930 — 2011» / «род. 1960» / «» */
export function lifeText(p) {
  const b = (p.birth || '').trim(), d = (p.death || '').trim();
  if (b && d) return `${b} — ${d}`;
  if (b) return `род. ${b}`;
  if (d) return `† ${d}`;
  return '';
}

/** Возраст (или возраст на момент смерти). '' если не определить. */
export function ageText(p, now = new Date()) {
  const b = parseDate(p.birth);
  if (!b) return '';
  let e, dead = false;
  if ((p.death || '').trim()) { e = parseDate(p.death); dead = true; if (!e) return ''; }
  else e = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  let n = e.y - b.y;
  if (b.m && b.d && e.m && e.d && (e.m < b.m || (e.m === b.m && e.d < b.d))) n--;
  if (n < 0 || n > (dead ? 125 : 120)) return '';
  return `${n} ${plural(n, 'год', 'года', 'лет')}`;
}

/** Совпадение по началу любого слова: «ив ро» → «Иван Родов». */
export function matchPrefix(name, q) {
  const qs = words(q);
  if (!qs.length) return true;
  const ws = words(name);
  return qs.every(t => ws.some(w => w.startsWith(t)));
}

function within1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** Нечёткий поиск по людям: префикс > вхождение > опечатка в 1 букву; затем прочие поля. */
export function searchPeople(list, q, limit = 12) {
  const raw = String(q ?? '').trim().toLowerCase();
  if (raw.includes('@')) return list.filter(p => (p.email || '').toLowerCase().includes(raw)).slice(0, limit);            // поиск по e-mail
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 6 && /^[\d\s+()\-.]+$/.test(raw)) return list.filter(p => (p.phone || '').replace(/\D/g, '').includes(digits)).slice(0, limit);   // по телефону (не путать с годом)
  const qs = words(q);
  if (!qs.length) return [];
  const out = [];
  for (const p of list) {
    const nw = words(p.name + ' ' + (p.maidenName || ''));
    const extra = norm([p.birthPlace, p.deathPlace, p.occupation, p.workplace, p.school, p.education, p.address, p.email, (p.docs || []).map(d => `${d.title} ${d.kind} ${d.name}`).join(' '), p.bio].join(' '));
    let total = 0, ok = true;
    for (const t of qs) {
      let best = 0;
      for (const w of nw) {
        if (w.startsWith(t)) best = Math.max(best, 3);
        else if (w.includes(t)) best = Math.max(best, 2);
        else if (t.length >= 4 && w.length >= 4 && (within1(w, t) || within1(w.slice(0, t.length), t))) best = Math.max(best, 1);
      }
      if (!best && t.length >= 3 && extra.includes(t)) best = 0.5;
      if (!best) { ok = false; break; }
      total += best;
    }
    if (ok) out.push({ p, score: total });
  }
  return out.sort((a, b) => b.score - a.score || a.p.name.localeCompare(b.p.name, 'ru')).slice(0, limit).map(x => x.p);
}

export const roman = n => {
  const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
};

/** Миниатюра по URL оригинала: /media/<tree>/<file> → /thumb/<tree>/<file>?s=s|m */
export const thumbUrl = (photo, size = 's') =>
  photo && photo.startsWith('/media/') ? '/thumb/' + photo.slice(7) + '?s=' + size : photo || '';

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export const JUBILEES = { 1: 'ситцевая', 5: 'деревянная', 10: 'розовая', 15: 'хрустальная', 20: 'фарфоровая', 25: 'серебряная', 30: 'жемчужная', 35: 'коралловая',
  40: 'рубиновая', 45: 'сапфировая', 50: 'золотая', 55: 'изумрудная', 60: 'бриллиантовая', 65: 'железная', 70: 'благодатная', 75: 'коронная' };

/**
 * Сколько лет в браке. Если один из супругов умер — считаем до его смерти (ended = true).
 * @returns {{years:number, ended:boolean, jubilee:string}|null}
 */
export function marriageInfo(a, b, dateStr, now = new Date()) {
  const m = parseDate(dateStr);
  if (!m) return null;
  let e = { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() }, ended = false;
  for (const p of [a, b]) {
    const d = parseDate(p?.death);
    if (d && (!ended || d.y < e.y)) { e = d; ended = true; }
  }
  let years = e.y - m.y;
  if (m.m && m.d && e.m && e.d && (e.m < m.m || (e.m === m.m && e.d < m.d))) years--;
  if (years < 0 || years > 100) return null;
  return { years, ended, jubilee: !ended && JUBILEES[years] ? `${JUBILEES[years]} свадьба` : '' };
}
