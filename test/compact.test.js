import test from 'node:test';
import assert from 'node:assert/strict';
import { layout, CARD } from '../public/js/layout.js';

// Реальная ситуация: Никитченко — «пришлая» ветвь (родители мужа в другом дереве, чем родители жены).
function fixture() {
  const P = {}, mk = (k, name, sex, extra = {}) => (P[k] = { id: 'id-' + k, name, sex, birth: '', death: '', parents: [], spouses: [], siblings: [], marriages: [], ...extra });
  const pr = (c, ...ps) => { P[c].parents = ps.map(x => P[x].id); }, sp = (a, b) => { P[a].spouses.push(P[b].id); P[b].spouses.push(P[a].id); };
  for (const [k, n, s] of [['eka', 'Мартыненко Екатерина', 'f'], ['pel', 'Коноплянникова Пелагея', 'f'], ['vyach', 'Мартыненко Вячеслав', 'm'], ['serg', 'Мартыненко Сергей', 'm'], ['iri', 'Мартыненко Ирина', 'f'],
    ['nad', 'Мартыненко Надежда', 'f'], ['nik', 'Коноплянников Николай', 'm'], ['vlad', 'Владимиров Владимир', 'm'], ['lyub', 'Владимирова Любовь', 'f'], ['alev', 'Демуцкая Алевтина', 'f'],
    ['val', 'Демуцкий Валентин', 'm'], ['nika', 'Демуцкая Ника', 'f'], ['nat', 'Мартыненко Наталия', 'f'], ['rom', 'Мартыненко Роман', 'm'], ['tat', 'Никитченко Татьяна', 'f'],
    ['sasha', 'Никитченко Александр', 'm'], ['and', 'Мартыненко Андрей', 'm'], ['vik', 'Мартыненко Виктория', 'f'], ['dm', 'Мартыненко Дмитрий', 'm'], ['vl', 'Мартыненко Владимир', 'm'],
    ['anya', 'Никитченко Аня', 'f'], ['ira', 'Никитченко Ира', 'f'], ['sasha2', 'Никитченко Александр мл.', 'm'], ['lena', 'Никитченко Лена', 'f'], ['vera', 'Никитченко Вера', 'f'],
    ['bro', 'Никитченко Андрей', 'm'], ['brw', 'Никитченко Оксана', 'f'], ['bk1', 'Никитченко Максим', 'm'], ['bk2', 'Никитченко Соня', 'f']]) mk(k, n, s);
  pr('vyach', 'eka'); pr('serg', 'eka'); pr('nad', 'pel'); pr('nik', 'pel'); pr('alev', 'vlad', 'lyub'); pr('nat', 'vlad', 'lyub'); pr('rom', 'vyach', 'nad'); pr('tat', 'vyach', 'nad');
  pr('nika', 'alev', 'val'); pr('dm', 'rom', 'nat'); pr('vl', 'rom', 'nat'); pr('anya', 'tat', 'sasha'); pr('ira', 'tat', 'sasha'); pr('sasha2', 'tat', 'sasha'); pr('and', 'serg', 'iri'); pr('vik', 'serg', 'iri');
  pr('sasha', 'lena'); pr('bro', 'lena'); pr('lena', 'vera'); pr('bk1', 'bro', 'brw'); pr('bk2', 'bro', 'brw');
  sp('vyach', 'nad'); sp('serg', 'iri'); sp('vlad', 'lyub'); sp('alev', 'val'); sp('nat', 'rom'); sp('tat', 'sasha'); sp('bro', 'brw');
  return { P, people: Object.fromEntries(Object.values(P).map(p => [p.id, p])) };
}
const stats = (P, L) => {
  const cx = id => L.byId[id].x + L.byId[id].w / 2;
  let sum = 0, max = 0;
  for (const p of Object.values(P)) if (p.parents.length) { const d = Math.abs(cx(p.id) - p.parents.reduce((s, x) => s + cx(x), 0) / p.parents.length); sum += d; max = Math.max(max, d); }
  const nik = Object.values(P).filter(p => p.name.startsWith('Никитченко')).map(p => cx(p.id));
  return { sum, max, spread: Math.max(...nik) - Math.min(...nik), width: L.bounds.w };
};
const noOverlap = L => { const rows = {}; for (const n of L.nodes) (rows[n.y] ??= []).push(n); for (const r of Object.values(rows)) { r.sort((a, b) => a.x - b.x); for (let i = 1; i < r.length; i++) if (r[i].x < r[i - 1].x + r[i - 1].w + CARD.gap - 0.5) return false; } return true; };

test('компактность: люди одной фамилии (Никитченко) собраны блоком, линии к родителям короткие', () => {
  const { P, people } = fixture();
  for (const direction of ['up', 'down']) {
    const L = layout(people, { direction }), s = stats(P, L);
    assert.ok(noOverlap(L), 'карточки не налезают');
    // измерено на этих же данных: до доработки (деревья выстраивались в ряд по порядку создания) — сумма 7680, максимум 2616, разброс Никитченко 1760, ширина 3040
    assert.ok(s.sum <= 4800, `суммарное отклонение детей от родителей ${Math.round(s.sum)}`);
    assert.ok(s.max <= 1050, `самая длинная связь ${Math.round(s.max)}`);
    assert.ok(s.spread <= 1100, `разброс Никитченко по горизонтали ${Math.round(s.spread)}`);
    assert.ok(s.width <= 2800, `ширина древа ${Math.round(s.width)}`);
    // потомки Александра и Андрея Никитченко стоят в одной вертикальной полосе с их родителями (Лена, Вера), а не на другом краю
    const cx = k => L.byId[P[k].id].x;
    const block = ['vera', 'lena', 'sasha', 'bro', 'anya', 'bk1'].map(cx);
    assert.ok(Math.max(...block) - Math.min(...block) <= 900, 'блок Никитченко компактен');
  }
});
test('линия матери: пара ведётся по родителям жены, раскладка корректна и отличается', () => {
  const { P, people } = fixture();
  const m = layout(people, { line: 'male' }), f = layout(people, { line: 'female' });
  assert.ok(noOverlap(f));
  assert.notDeepEqual(m.nodes.map(n => Math.round(n.x)), f.nodes.map(n => Math.round(n.x)), 'переключатель что-то меняет');
  assert.ok(Math.abs(f.byId[P.tat.id].x - f.byId[P.vyach.id].x) < Math.abs(m.byId[P.tat.id].x - m.byId[P.vyach.id].x) + 1, 'Татьяна ближе к своим родителям Мартыненко при линии матери');
});
test('компактность: независимые деревья без связей по-прежнему ставятся рядом, большое древо считается быстро', () => {
  const people = {};
  for (let i = 0; i < 400; i++) { const id = 'p' + i; people[id] = { id, name: 'Фамилия' + (i % 7) + ' Имя' + i, sex: i % 2 ? 'f' : 'm', birth: '', death: '', parents: i >= 20 ? ['p' + Math.floor((i - 20) / 2)] : [], spouses: [], siblings: [], marriages: [] }; }
  const t0 = Date.now(), L = layout(people, {}), dt = Date.now() - t0;
  assert.equal(L.nodes.length, 400); assert.ok(noOverlap(L)); assert.ok(dt < 1500, 'время ' + dt + ' мс');
  const lone = { a: { id: 'a', name: 'А', sex: 'm', parents: [], spouses: [], siblings: [], marriages: [] }, b: { id: 'b', name: 'Б', sex: 'm', parents: [], spouses: [], siblings: [], marriages: [] } };
  const l2 = layout(lone, {}); assert.ok(noOverlap(l2)); assert.equal(l2.nodes.length, 2);
});
