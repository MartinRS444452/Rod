import { assignGenerations } from './layout.js';
import { parseDate, yearOf, ageText, norm, JUBILEES } from './util.js';

const top = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), 'ru')).slice(0, n);
const bump = (m, k) => { if (k) m.set(k, (m.get(k) || 0) + 1); };

export function stats(people, now = new Date()) {
  const list = Object.values(people);
  const out = { total: list.length, male: 0, female: 0, living: 0, deceased: 0, generations: 0,
    avgLifespan: null, oldest: null, occupations: [], places: [], names: [] };
  if (!list.length) return out;
  const occ = new Map(), pl = new Map(), nm = new Map(), spans = [];
  for (const p of list) {
    if (p.sex === 'f') out.female++; else out.male++;
    if ((p.death || '').trim()) out.deceased++; else out.living++;
    bump(occ, (p.occupation || '').trim().toLowerCase());
    bump(pl, (p.birthPlace || '').trim());
    bump(nm, (p.name || '').trim().split(/\s+/)[0]);
    const b = yearOf(p.birth), d = yearOf(p.death);
    if (b !== null && d !== null && d >= b && d - b <= 125) {
      spans.push(d - b);
      if (!out.oldest || d - b > out.oldest.years) out.oldest = { id: p.id, name: p.name, years: d - b };
    } else if (b !== null && !(p.death || '').trim() && ageText(p, now)) {
      const years = now.getFullYear() - b;
      if (!out.oldest || years > out.oldest.years) out.oldest = { id: p.id, name: p.name, years };
    }
  }
  if (spans.length) out.avgLifespan = Math.round(spans.reduce((a, b) => a + b, 0) / spans.length);
  out.generations = new Set(Object.values(assignGenerations(people))).size;
  out.occupations = top(occ, 5); out.places = top(pl, 5); out.names = top(nm, 5);
  return out;
}

/** Ближайшие дни рождения и памятные даты (только полные даты ДД.ММ.ГГГГ). */
export function upcoming(people, now = new Date(), days = 45) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const res = [];
  for (const p of Object.values(people)) {
    for (const [field, kind] of [['birth', 'birthday'], ['death', 'memory']]) {
      if (kind === 'birthday' && (p.death || '').trim()) continue;
      const d = parseDate(p[field]);
      if (!d || !d.m || !d.d) continue;
      let next = new Date(today.getFullYear(), d.m - 1, d.d);
      if (next < today) next = new Date(today.getFullYear() + 1, d.m - 1, d.d);
      const left = Math.round((next - today) / 86400000);
      if (left <= days) res.push({ id: p.id, name: p.name, kind, left, date: next, years: next.getFullYear() - d.y });
    }
  }
  // годовщины свадьбы (пара учитывается один раз; если оба супруга умерли — пропускаем)
  const seen = new Set();
  for (const p of Object.values(people)) for (const m of p.marriages || []) {
    const o = people[m.with], key = [p.id, m.with].sort().join('|');
    if (!o || seen.has(key)) continue; seen.add(key);
    if ((p.death || '').trim() && (o.death || '').trim()) continue;
    const d = parseDate(m.date);
    if (!d || !d.m || !d.d) continue;
    let next = new Date(today.getFullYear(), d.m - 1, d.d);
    if (next < today) next = new Date(today.getFullYear() + 1, d.m - 1, d.d);
    const left = Math.round((next - today) / 86400000), years = next.getFullYear() - d.y;
    if (left <= days && years > 0) res.push({ id: p.id, name: `${p.name} и ${o.name}`, kind: 'wedding', left, date: next, years, jubilee: JUBILEES[years] ? `${JUBILEES[years]} свадьба` : '' });
  }
  return res.sort((a, b) => a.left - b.left || norm(a.name).localeCompare(norm(b.name)));
}
