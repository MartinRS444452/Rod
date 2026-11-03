// Чистая логика древа без БД и сети: применение правок, связи, диффы, откат.
import { cleanPerson, fillDefaults, HttpError } from './validate.js';

const REL = ['parents', 'spouses', 'siblings'];

const canon = o => JSON.stringify(o, (k, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(x => [x, v[x]])) : v);
export const strip = p => { const { r, ...rest } = fillDefaults(p); return rest; }; // eslint-disable-line no-unused-vars

function ancestorsOf(people, id) {
  const seen = new Set(), st = [id];
  while (st.length) for (const p of people[st.pop()]?.parents || []) if (people[p] && !seen.has(p)) { seen.add(p); st.push(p); }
  return seen;
}

/**
 * Применяет пачку операций к состоянию.
 *  ops: [{op:'put', person, base}, {op:'del', id, base}]
 *  base — ревизия карточки (поле r), которую видел клиент; 0 для новой.
 * Связи редактируемой карточки считаются «истиной»: у соседей симметричные
 * связи (супруги, братья/сёстры) добавляются и УДАЛЯЮТСЯ автоматически.
 * union:true — мягкий режим для импорта/миграции (связи только достраиваются).
 * @returns {{people, changes}} changes: id → [до|null, после|null] (без поля r)
 */
export function applyOps(current, ops, newRev, treeId, { skipCycleCheck = false, union = false } = {}) {
  if (!Array.isArray(ops) || !ops.length) throw new HttpError(400, 'Нет изменений');
  if (ops.length > 300) throw new HttpError(400, 'Слишком много операций за раз');
  const people = structuredClone(current);
  const touched = new Set(), putIds = [], delIds = new Set(), conflicts = [];

  for (const op of ops) {
    if (op?.op === 'put') {
      const p = cleanPerson(op.person, treeId), ex = people[p.id];
      const base = Number.isInteger(op.base) ? op.base : 0;
      if (ex ? (ex.r !== base && ex.r !== newRev) : base !== 0) conflicts.push(p.id);
      people[p.id] = { ...p, r: ex?.r ?? 0 };
      putIds.push(p.id); touched.add(p.id); delIds.delete(p.id);
    } else if (op?.op === 'del') {
      const id = String(op.id ?? ''), ex = people[id];
      if (!ex) continue; // уже удалён — операция идемпотентна
      const base = Number.isInteger(op.base) ? op.base : -1;
      if (ex.r !== base && ex.r !== newRev) conflicts.push(id);
      delete people[id]; delIds.add(id); touched.add(id);
    } else throw new HttpError(400, 'Неизвестная операция');
  }
  if (conflicts.length) throw new HttpError(409, 'Карточку изменили на другом устройстве', { conflicts: [...new Set(conflicts)] });

  // ссылки на удалённых
  if (delIds.size) for (const q of Object.values(people)) {
    for (const k of REL) if (q[k].some(x => delIds.has(x))) { q[k] = q[k].filter(x => !delIds.has(x)); touched.add(q.id); }
    if (q.marriages.some(m => delIds.has(m.with))) { q.marriages = q.marriages.filter(m => !delIds.has(m.with)); touched.add(q.id); }
  }
  // связи правленых карточек + симметрия у соседей
  // Если обе стороны связи правятся в одной пачке, побеждает более поздняя операция:
  // карточку, которую ещё предстоит обработать, пропускаем — она сама объявит свои связи.
  const order = new Map(putIds.map((id, i) => [id, i]));
  for (const id of putIds) {
    const P = people[id];
    if (!P) continue;
    for (const k of REL) P[k] = P[k].filter(x => x !== id && people[x]);
    if (union) { // импорт/миграция: молча чистим заведомо абсурдные связи; в обычных правках это ошибка (см. ниже)
      const parents = new Set(P.parents);
      P.spouses = P.spouses.filter(x => !parents.has(x));
      P.siblings = P.siblings.filter(x => !parents.has(x));
    }
    for (const k of ['spouses', 'siblings']) {
      for (const Q of Object.values(people)) {
        if (Q.id === id) continue;
        if (union) { // импорт/миграция: односторонние связи достраиваются, ничего не удаляется
          if (Q[k].includes(id) && !P[k].includes(Q.id)) P[k] = [...P[k], Q.id];
          if (P[k].includes(Q.id) && !Q[k].includes(id)) { Q[k] = [...Q[k], id]; touched.add(Q.id); }
          continue;
        }
        if (order.has(Q.id) && order.get(Q.id) > order.get(id)) continue;
        const want = P[k].includes(Q.id), has = Q[k].includes(id);
        if (want && !has) { Q[k] = [...Q[k], id]; touched.add(Q.id); }
        else if (!want && has) { Q[k] = Q[k].filter(x => x !== id); touched.add(Q.id); }
      }
    }
  }
  // даты свадеб: хранятся у обоих супругов; у правленой карточки — «истина», у партнёра отражается
  for (const id of putIds) {
    const P = people[id];
    if (!P) continue;
    P.marriages = P.marriages.filter(m => m.with !== id && P.spouses.includes(m.with) && people[m.with]);
    for (const Q of Object.values(people)) {
      if (Q.id === id || !P.spouses.includes(Q.id) && !Q.marriages.some(m => m.with === id)) continue;
      const mine = P.marriages.find(m => m.with === Q.id), theirs = Q.marriages.find(m => m.with === id);
      if (union) { // импорт/миграция: только достраиваем
        if (theirs && !mine && P.spouses.includes(Q.id)) P.marriages = [...P.marriages, { with: Q.id, date: theirs.date }];
        if (mine && !theirs) { Q.marriages = [...Q.marriages, { with: id, date: mine.date }]; touched.add(Q.id); }
        continue;
      }
      if (order.has(Q.id) && order.get(Q.id) > order.get(id)) continue;
      if (mine) {
        if (!theirs) { Q.marriages = [...Q.marriages, { with: id, date: mine.date }]; touched.add(Q.id); }
        else if (theirs.date !== mine.date) { Q.marriages = Q.marriages.map(m => (m.with === id ? { with: id, date: mine.date } : m)); touched.add(Q.id); }
      } else if (theirs) { Q.marriages = Q.marriages.filter(m => m.with !== id); touched.add(Q.id); }
    }
  }
  if (!union) { // родитель/ребёнок не может быть супругом или братом/сестрой
    let kids = null;
    for (const id of putIds) {
      const P = people[id];
      if (!P || (!P.spouses.length && !P.siblings.length)) continue;
      if (!kids) { kids = new Map(); for (const q of Object.values(people)) for (const par of q.parents) (kids.get(par) ?? kids.set(par, []).get(par)).push(q.id); }
      const anc = ancestorsOf(people, id), desc = new Set(), st = [id];
      while (st.length) for (const k of kids.get(st.pop()) || []) if (!desc.has(k)) { desc.add(k); st.push(k); }
      for (const [k, what] of [['spouses', 'супругом(ой)'], ['siblings', 'братом/сестрой']]) {
        const bad = P[k].find(x => anc.has(x) || desc.has(x));
        if (bad) throw new HttpError(400, `«${people[bad].name}» — прямой предок или потомок «${P.name}»: нельзя указать ${what}`);
      }
    }
  }
  if (!skipCycleCheck) for (const id of putIds) {
    const P = people[id];
    if (!P) continue;
    for (const par of P.parents) {
      if (ancestorsOf(people, par).has(id)) throw new HttpError(400, `«${P.name}» не может быть предком собственного родителя`);
    }
  }

  const changes = {};
  for (const id of touched) {
    const b = current[id] ? strip(current[id]) : null, a = people[id] ? strip(people[id]) : null;
    if (canon(b) === canon(a)) { if (people[id]) people[id].r = current[id]?.r ?? 0; continue; }
    changes[id] = [b, a];
    if (a) people[id].r = newRev;
  }
  return { people, changes };
}

/** Разница между двумя полными состояниями. */
export function diffStates(a, b) {
  const changes = {};
  for (const id of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[id] ? strip(a[id]) : null, y = b[id] ? strip(b[id]) : null;
    if (canon(x) !== canon(y)) changes[id] = [x, y];
  }
  return changes;
}

/**
 * Состояние на момент ревизии targetRev: откатываем диффы от головы назад.
 * entries — записи истории с rev > targetRev (любой порядок), должны идти без пропусков.
 */
export function stateAt(headPeople, headName, headRev, targetRev, entries) {
  const sorted = [...entries].sort((a, b) => b.rev - a.rev);
  if (sorted.length !== headRev - targetRev || sorted.some((e, i) => e.rev !== headRev - i))
    throw new HttpError(410, 'Эта версия слишком старая — её история уже удалена');
  const people = structuredClone(headPeople);
  let name = headName;
  for (const e of sorted) {
    if (e.diff.name) name = e.diff.name[0];
    for (const [id, [b]] of Object.entries(e.diff.changes)) { if (b === null) delete people[id]; else people[id] = { ...b, r: 0 }; }
  }
  return { people, name };
}

/** Краткое описание правок для списка истории. */
export function summarize(diff) {
  return Object.entries(diff.changes).map(([id, [b, a]]) => ({ id, name: (a || b).name, kind: !b ? 'add' : !a ? 'del' : 'edit' }));
}
