import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, marriageInfo, fullName, ageText, lifeText, plural, matchPrefix, searchPeople, norm, roman, thumbUrl } from '../public/js/util.js';
import { layout, assignGenerations, lineage, relatives, CARD } from '../public/js/layout.js';
import { stats, upcoming } from '../public/js/stats.js';
import { treeSvg, wrapName } from '../public/js/svg.js';

const P = (id, name, o = {}) => ({ id, name, sex: 'm', birth: '', death: '', parents: [], spouses: [], siblings: [], ...o });
const map = (...ps) => Object.fromEntries(ps.map(p => [p.id, p]));

// --- Образец из seedTree: Иван+Мария → Пётр+Анна → Елена. Анна без родителей (баг №1 из разбора)
const family = () => map(
  P('a', 'Иван Родов', { birth: '1902', death: '1978', spouses: ['b'] }),
  P('b', 'Мария Родова', { sex: 'f', birth: '1905', death: '1989', spouses: ['a'] }),
  P('c', 'Пётр Родов', { birth: '1930', death: '2011', parents: ['a', 'b'], spouses: ['d'] }),
  P('d', 'Анна Соколова', { sex: 'f', birth: '1933', spouses: ['c'] }),
  P('e', 'Елена Родова', { sex: 'f', birth: '1960', parents: ['c', 'd'] }),
);

test('util: даты, возраст, склонения', () => {
  assert.deepEqual(parseDate('1930'), { y: 1930, m: null, d: null });
  assert.deepEqual(parseDate('12.05.1930'), { y: 1930, m: 5, d: 12 });
  assert.deepEqual(parseDate('1930-05-12'), { y: 1930, m: 5, d: 12 });
  assert.equal(parseDate('около 1930')?.y, 1930);
  assert.equal(parseDate('32.13.1930')?.m, null); // кривой день/месяц → только год
  assert.equal(parseDate('abc'), null);
  assert.equal(parseDate('99999'), null);
  const now = new Date(2026, 9, 28);
  assert.equal(ageText({ birth: '1960', death: '' }, now), '66 лет');
  assert.equal(ageText({ birth: '1930', death: '2011' }, now), '81 год');
  assert.equal(ageText({ birth: '15.11.1990', death: '' }, now), '35 лет'); // ДР ещё не наступил
  assert.equal(ageText({ birth: '1990', death: 'неизв.' }, now), '');
  assert.equal(ageText({ birth: '1500', death: '' }, now), '');
  assert.equal(plural(1, 'год', 'года', 'лет'), 'год');
  assert.equal(plural(22, 'год', 'года', 'лет'), 'года');
  assert.equal(plural(11, 'год', 'года', 'лет'), 'лет');
  assert.equal(plural(111, 'год', 'года', 'лет'), 'лет');
  assert.equal(lifeText({ birth: '1930', death: '2011' }), '1930 — 2011');
  assert.equal(lifeText({ birth: '1960' }), 'род. 1960');
  assert.equal(roman(4), 'IV'); assert.equal(roman(14), 'XIV');
  assert.equal(thumbUrl('/media/t1/f.jpg', 'm'), '/thumb/t1/f.jpg?s=m');
  assert.equal(thumbUrl(''), '');
});

test('util: поиск по началу слов и нечёткий поиск', () => {
  assert.ok(matchPrefix('Иван Родов', 'ив'));
  assert.ok(matchPrefix('Иван Родов', 'ро ив'));
  assert.ok(!matchPrefix('Иван Родов', 'ван'));
  assert.ok(matchPrefix('Ёлкин Пётр', 'елк'));
  assert.equal(norm('Ёж'), 'еж');
  const list = Object.values(family());
  assert.equal(searchPeople(list, 'родов')[0].name.includes('Родов'), true);
  assert.equal(searchPeople(list, 'Соколва')[0]?.id, 'd');      // опечатка
  assert.equal(searchPeople(list, 'мария родова')[0]?.id, 'b');
  assert.equal(searchPeople(list, 'qqq').length, 0);
  const x = [P('1', 'Иван', { occupation: 'часовщик' })];
  assert.equal(searchPeople(x, 'часов')[0]?.id, '1');           // по другим полям
});

test('layout: поколения — супруг без родителей выравнивается по партнёру', () => {
  const g = assignGenerations(family());
  assert.deepEqual([g.a, g.b, g.c, g.d, g.e], [0, 0, 1, 1, 2]);
});

test('layout: пары рядом, дети ниже и по центру под родителями', () => {
  const L = layout(family());
  const n = L.byId, C = CARD;
  assert.equal(n.c.y, n.d.y, 'Пётр и Анна в одном ряду');
  assert.equal(Math.abs(n.c.x - n.d.x), C.w + C.gap, 'пара вплотную');
  assert.equal(n.a.y, n.b.y);
  assert.ok(n.c.y < n.a.y && n.e.y < n.c.y, 'по умолчанию дети выше родителей («жизнь растёт вверх»)');
  const D = layout(family(), { direction: 'down' }).byId;
  assert.ok(D.c.y > D.a.y && D.e.y > D.c.y, 'классическое направление вниз сохраняется');
  const unitCx = (n.c.x + n.d.x + C.w) / 2, kidCx = n.e.x + C.w / 2;
  assert.equal(unitCx, kidCx, 'единственный ребёнок строго под парой');
  assert.equal(L.spouseLinks.length, 2);
  assert.equal(L.edges.length, 2, 'одна общая линия на ребёнка: c←(a,b), e←(c,d)');
});

test('layout: линия ребёнка идёт из середины брачной линии', () => {
  const L = layout(family());
  const e = L.edges.find(x => x.child === 'c');
  const link = L.spouseLinks.find(s => [s.a, s.b].includes('a'));
  assert.ok(e.d.startsWith(`M${link.mx} ${link.y}`));
  assert.deepEqual(e.parents.sort(), ['a', 'b']);
});

test('layout: карточки в одном ряду не пересекаются (случайные древа)', () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = 0; t < 40; t++) {
    const n = 5 + Math.floor(rnd() * 120), ps = [];
    for (let i = 0; i < n; i++) ps.push(P('p' + i, 'Человек ' + i, { sex: rnd() < .5 ? 'm' : 'f', birth: String(1800 + Math.floor(rnd() * 200)) }));
    const m = map(...ps);
    for (let i = 1; i < n; i++) {
      if (rnd() < .65) { // родители из «прошлого»
        const a = m['p' + Math.floor(rnd() * i)]; m['p' + i].parents.push(a.id);
        if (a.spouses[0] && rnd() < .8) m['p' + i].parents.push(a.spouses[0]);
      }
      if (rnd() < .3) { const j = Math.floor(rnd() * i), a = m['p' + i], b = m['p' + j]; if (!a.spouses.includes(b.id) && a.parents.length === 0) { a.spouses.push(b.id); b.spouses.push(a.id); } }
    }
    const L = layout(m);
    assert.equal(L.nodes.length, n);
    const rows = {};
    for (const nd of L.nodes) (rows[nd.y] ??= []).push(nd);
    for (const row of Object.values(rows)) {
      row.sort((a, b) => a.x - b.x);
      for (let i = 1; i < row.length; i++) assert.ok(row[i].x >= row[i - 1].x + CARD.w, `перекрытие в раскладке #${t}`);
    }
    for (const nd of L.nodes) assert.ok(nd.x >= 0 && nd.y >= 0 && nd.x + nd.w <= L.bounds.w && nd.y + nd.h <= L.bounds.h);
    const g = assignGenerations(m);
    for (const p of Object.values(m)) for (const q of p.parents) assert.ok(g[p.id] > g[q], 'ребёнок ниже родителя');
  }
});

test('layout: цепочка браков, циклы и мусорные ссылки не ломают раскладку', () => {
  const chain = map(P('a', 'A', { spouses: ['b', 'c'] }), P('b', 'B', { sex: 'f', spouses: ['a'] }), P('c', 'C', { sex: 'f', spouses: ['a'] }),
    P('k1', 'Kid1', { parents: ['a', 'b'] }), P('k2', 'Kid2', { parents: ['a', 'c'] }));
  const L = layout(chain);
  const xs = ['b', 'a', 'c'].map(i => L.byId[i].x);
  assert.deepEqual([...xs].sort((a, b) => a - b), xs, 'порядок [B, A, C]: общий супруг посередине');
  assert.equal(L.spouseLinks.length, 2);
  const cyc = map(P('x', 'X', { parents: ['y'] }), P('y', 'Y', { parents: ['x'] }), P('z', 'Z', { parents: ['ghost'], spouses: ['ghost2'] }));
  const L2 = layout(cyc);
  assert.equal(L2.nodes.length, 3);
  assert.equal(layout({}).nodes.length, 0);
});

test('layout: 2000 человек считаются быстро', () => {
  const ps = [P('r', 'Root')];
  for (let i = 1; i < 2000; i++) ps.push(P('n' + i, 'N' + i, { parents: [i < 3 ? 'r' : 'n' + Math.floor(i / 2)] }));
  const t = performance.now(), L = layout(map(...ps)), dt = performance.now() - t;
  assert.equal(L.nodes.length, 2000);
  assert.ok(dt < 1500, `слишком долго: ${dt | 0} мс`);
});

test('lineage/relatives', () => {
  const m = family();
  assert.deepEqual([...lineage(m, 'c')].sort(), ['a', 'b', 'c', 'e']);
  m.e.siblings = ['x']; m.x = P('x', 'Икс', { siblings: ['e'] });
  const r = relatives(m, 'e');
  assert.deepEqual(r.parents.sort(), ['c', 'd']); assert.deepEqual(r.siblings, ['x']);
  assert.deepEqual(relatives(m, 'c').children, ['e']);
  const m2 = family(); m2.f = P('f', 'Фёдор', { parents: ['c', 'd'] });
  assert.deepEqual(relatives(m2, 'e').siblings, ['f'], 'производные братья/сёстры по общим родителям');
  m2.g = P('g', 'Аркадий', { parents: ['c', 'd'], birth: '1955' }); m2.f.birth = '1965';
  assert.deepEqual(relatives(m2, 'c').children, ['g', 'e', 'f'], 'дети: по году рождения');
});

test('stats и upcoming', () => {
  const s = stats(family(), new Date(2026, 9, 28));
  assert.equal(s.total, 5); assert.equal(s.male, 2); assert.equal(s.female, 3);
  assert.equal(s.deceased, 3); assert.equal(s.living, 2); assert.equal(s.generations, 3);
  assert.equal(s.avgLifespan, Math.round(((1978 - 1902) + (1989 - 1905) + (2011 - 1930)) / 3));
  assert.equal(stats({}).total, 0);
  const m = map(P('a', 'Аня', { birth: '30.10.1990' }), P('b', 'Боря', { birth: '1.1.1950', death: '2.11.2000' }), P('c', 'Вика', { birth: '1990' }), P('d', 'Гена', { birth: '27.10.1980' }));
  const u = upcoming(m, new Date(2026, 9, 28), 45);
  assert.deepEqual(u.map(x => [x.name, x.kind, x.left]), [['Аня', 'birthday', 2], ['Боря', 'memory', 5]]);
  assert.equal(u[0].years, 36);
});

test('svg: валидная разметка, экранирование', () => {
  const m = family(); m.a.name = 'Иван <script>"&"</script> Очень Длинное Имя Фамилия';
  m.a.photo = '/media/t/p.jpg';
  const svg = treeSvg(m, layout(m), { imageBase: 'Obsidian/media/', anchors: true });
  assert.ok(svg.startsWith('<svg') && svg.trim().endsWith('</svg>'));
  assert.ok(!svg.includes('<script'));
  assert.ok(svg.includes('Obsidian/media/p.jpg'));
  assert.ok(svg.includes('href="#p-a"'));
  assert.deepEqual(wrapName('Анна Мария Соколова-Вишневская', 17, 2).length, 2);
});

test('layout: противоречивые данные (родитель = «брат» ребёнка) не дают наложений', () => {
  const m = map(P('a', 'A', { spouses: ['b'] }), P('b', 'B', { sex: 'f', spouses: ['a'] }), P('c', 'C', { parents: ['a', 'b'], spouses: ['d'], siblings: ['e'] }),
    P('d', 'D', { sex: 'f', spouses: ['c'] }), P('e', 'E', { sex: 'f', parents: ['c', 'd'], siblings: ['c'], spouses: ['s'] }), P('s', 'S', { spouses: ['e'] }), P('k', 'K', { parents: ['e', 's'] }));
  const L = layout(m), rows = {};
  for (const n of L.nodes) (rows[n.y] ??= []).push(n);
  for (const row of Object.values(rows)) { row.sort((a, b) => a.x - b.x); for (let i = 1; i < row.length; i++) assert.ok(row[i].x >= row[i - 1].x + CARD.w, 'наложение'); }
  assert.equal(L.nodes.length, 7);
});

// ---------- геометрия линий: пересечения и попадания в чужие карточки ----------
function segs(d) {
  const out = []; let x = 0, y = 0;
  for (const m of d.matchAll(/([MLVHQC])([^MLVHQC]*)/g)) {
    const v = m[2].trim().split(/[\s,]+/).filter(Boolean).map(Number);
    let pts = [];
    if (m[1] === 'M') { x = v[0]; y = v[1]; continue; }
    if (m[1] === 'L') pts = [[v[0], v[1]]]; else if (m[1] === 'V') pts = [[x, v[0]]]; else if (m[1] === 'H') pts = [[v[0], y]];
    else if (m[1] === 'Q') pts = [[v[0], v[1]], [v[2], v[3]]]; else pts = [[v[4], v[5]]];
    for (const [nx, ny] of pts) { out.push([x, y, nx, ny]); x = nx; y = ny; }
  }
  return out;
}
const horiz = s => Math.abs(s[1] - s[3]) < 0.01, vert = s => Math.abs(s[0] - s[2]) < 0.01;
const inside = (v, a, b) => v > Math.min(a, b) + 0.5 && v < Math.max(a, b) - 0.5;
function crossings(L) {
  const all = [];
  L.edges.forEach((e, i) => segs(e.d).forEach(sg => all.push({ sg, src: 'e' + e.child + ':' + i })));
  L.spouseLinks.forEach((s, i) => segs(s.d).forEach(sg => all.push({ sg, src: 'm' + i })));
  let n = 0;
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    if (all[i].src === all[j].src) continue;
    const a = all[i].sg, b = all[j].sg;
    const [h, v] = horiz(a) && vert(b) ? [a, b] : horiz(b) && vert(a) ? [b, a] : [null, null];
    if (h && inside(v[0], h[0], h[2]) && inside(h[1], v[1], v[3])) n++;
  }
  return n;
}
function cardHits(L) { // линия не должна проходить сквозь чужие карточки
  let n = 0;
  for (const e of L.edges) for (const sg of segs(e.d)) for (const c of L.nodes) {
    if (c.id === e.child || e.parents.includes(c.id)) continue;
    const x0 = c.x + 1, x1 = c.x + c.w - 1, y0 = c.y + 1, y1 = c.y + c.h - 1;
    const hit = horiz(sg) ? sg[1] > y0 && sg[1] < y1 && Math.max(sg[0], sg[2]) > x0 && Math.min(sg[0], sg[2]) < x1
      : vert(sg) ? sg[0] > x0 && sg[0] < x1 && Math.max(sg[1], sg[3]) > y0 && Math.min(sg[1], sg[3]) < y1 : false;
    if (hit) n++;
  }
  return n;
}
const siblingsFamily = () => {
  const m = map(P('p', 'Отец', { spouses: ['q'] }), P('q', 'Мать', { sex: 'f', spouses: ['p'] }));
  const kids = [['a', 'f', '1930'], ['b', 'm', '1932'], ['c', 'f', '1935']];
  for (const [k, sex, y] of kids) {
    m[k] = P(k, 'Ребёнок ' + k, { sex, birth: y, parents: ['p', 'q'], spouses: ['s' + k] });
    m['s' + k] = P('s' + k, 'Супруг ' + k, { sex: sex === 'm' ? 'f' : 'm', spouses: [k] });
  }
  return m;
};

test('layout: родные братья/сёстры рядом по возрасту, супруги крайних — снаружи, линии не пересекаются', () => {
  for (const direction of ['up', 'down']) {
    const L = layout(siblingsFamily(), { direction }), x = id => L.byId[id].x;
    assert.ok(x('a') < x('b') && x('b') < x('c'), 'от старшего к младшему слева направо');
    assert.ok(x('sa') < x('a'), 'супруг(а) старшего — слева, снаружи');
    assert.ok(x('sc') > x('c'), 'супруг(а) младшего — справа, снаружи');
    assert.equal(crossings(L), 0, 'линии не пересекают друг друга и браки (' + direction + ')');
    assert.equal(cardHits(L), 0, 'линии не проходят сквозь чужие карточки (' + direction + ')');
  }
});

test('layout: дети от разных браков не перемешиваются', () => {
  const m = map(P('a', 'A', { spouses: ['b', 'c'] }), P('b', 'B', { sex: 'f', spouses: ['a'] }), P('c', 'C', { sex: 'f', spouses: ['a'] }));
  [['k1', 'b', '1950'], ['k2', 'c', '1952'], ['k3', 'b', '1955'], ['k4', 'c', '1957']].forEach(([k, w, y]) => { m[k] = P(k, k, { parents: ['a', w], birth: y }); });
  const L = layout(m), x = id => L.byId[id].x;
  assert.ok(Math.max(x('k1'), x('k3')) < Math.min(x('k2'), x('k4')) || Math.max(x('k2'), x('k4')) < Math.min(x('k1'), x('k3')), 'дети от одного брака — единым блоком');
  assert.ok(x('k1') < x('k3') && x('k2') < x('k4'), 'внутри брака по возрасту');
  assert.equal(crossings(L), 0); assert.equal(cardHits(L), 0);
});

test('layout: надёжность линий на случайных семьях с браками и детьми', () => {
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let worst = 0;
  for (let t = 0; t < 60; t++) {
    const m = {}; let n = 0;
    const add = (o = {}) => { const id = 'p' + n++; m[id] = P(id, id, { sex: rnd() < .5 ? 'm' : 'f', ...o }); return id; };
    const couples = [[add({ birth: '1900' }), add({ birth: '1902' })]];
    m[couples[0][0]].spouses = [couples[0][1]]; m[couples[0][1]].spouses = [couples[0][0]];
    for (let g = 0; g < 3; g++) {
      const next = [];
      for (const [a, b] of couples) {
        const kids = 1 + Math.floor(rnd() * 4);
        for (let i = 0; i < kids; i++) {
          const k = add({ parents: [a, b], birth: String(1900 + (g + 1) * 28 + i * 2) });
          if (rnd() < .7) { const s = add({ birth: String(1900 + (g + 1) * 28 + 1) }); m[k].spouses = [s]; m[s].spouses = [k]; next.push([k, s]); }
        }
      }
      couples.length = 0; couples.push(...next);
    }
    const L = layout(m); worst = Math.max(worst, crossings(L));
    assert.equal(cardHits(L), 0, 'сквозь карточки #' + t);
    assert.equal(crossings(L), 0, 'пересечения линий #' + t);
  }
  assert.equal(worst, 0);
});

test('layout: режим «по годам» — старший брат дальше от потомков, масштаб пропорционален', () => {
  const m = siblingsFamily();
  const up = layout(m, { timeline: true }), dn = layout(m, { timeline: true, direction: 'down' });
  assert.equal(up.mode, 'time');
  const px = up.card.yearPx;
  assert.equal(dn.byId.b.y - dn.byId.a.y, 2 * px, '2 года разницы = 2 шага шкалы');
  assert.equal(dn.byId.c.y - dn.byId.b.y, 3 * px);
  assert.ok(up.byId.a.y > up.byId.b.y && up.byId.b.y > up.byId.c.y, 'вверх: младшие выше старших');
  assert.ok(dn.byId.a.y < dn.byId.b.y && dn.byId.b.y < dn.byId.c.y, 'вниз: младшие ниже старших');
  assert.ok(up.ticks.length >= 2 && up.ticks.every(t => t.label === String(t.year)));
  assert.ok(up.byId.sa.est === true && up.byId.a.est === false, 'год супруга без даты — оценка по партнёру');
  assert.equal(up.byId.sa.year, 1930);
});

test('layout: «по годам» не даёт наложений и переживает людей без дат', () => {
  let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let t = 0; t < 30; t++) {
    const n = 5 + Math.floor(rnd() * 80), ps = [];
    for (let i = 0; i < n; i++) ps.push(P('p' + i, 'Человек ' + i, { birth: rnd() < .4 ? '' : String(1850 + Math.floor(rnd() * 150)) }));
    const m = map(...ps);
    for (let i = 1; i < n; i++) if (rnd() < .7) { const a = m['p' + Math.floor(rnd() * i)]; m['p' + i].parents.push(a.id); if (a.spouses[0]) m['p' + i].parents.push(a.spouses[0]); else if (rnd() < .3 && !m['p' + i].spouses.length && !a.parents.includes('p' + i)) { /* пара */ } }
    for (const direction of ['up', 'down']) {
      const L = layout(m, { timeline: true, direction });
      assert.equal(L.nodes.length, n);
      for (let i = 0; i < L.nodes.length; i++) for (let j = i + 1; j < L.nodes.length; j++) {
        const a = L.nodes[i], b = L.nodes[j];
        assert.ok(a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5 || a.y + a.h <= b.y + 0.5 || b.y + b.h <= a.y + 0.5, 'наложение в режиме по годам #' + t);
      }
      assert.ok(L.nodes.every(nd => Number.isFinite(nd.y) && nd.y >= 0));
    }
  }
});

test('девичья фамилия и годовщина свадьбы', () => {
  assert.equal(fullName({ name: 'Анна Соколова', maidenName: 'Иванова' }), 'Анна Соколова (урожд. Иванова)');
  assert.equal(fullName({ name: 'Иван' }), 'Иван');
  assert.equal(searchPeople([P('1', 'Анна Соколова', { maidenName: 'Иванова' })], 'ивано')[0]?.id, '1', 'поиск находит по девичьей фамилии');
  const now = new Date(2026, 9, 29);
  assert.deepEqual(marriageInfo({}, {}, '14.06.2001', now), { years: 25, ended: false, jubilee: 'серебряная свадьба' });
  assert.equal(marriageInfo({}, {}, '14.12.2001', now).years, 24, 'годовщина в этом году ещё не наступила');
  const e = marriageInfo({ death: '1990' }, {}, '1958', now);
  assert.deepEqual([e.years, e.ended, e.jubilee], [32, true, ''], 'если супруг умер — считаем до его смерти, без юбилея');
  assert.equal(marriageInfo({}, {}, 'нет', now), null);
});

// две «шины» разных семей не должны лежать на одной высоте с перекрытием по ширине — иначе непонятно, кто чей ребёнок
function collinearOverlaps(L) {
  const hs = [];
  L.edges.forEach(e => segs(e.d).filter(horiz).forEach(sg => hs.push({ y: sg[1], lo: Math.min(sg[0], sg[2]), hi: Math.max(sg[0], sg[2]), fam: e.parents.join() })));
  let n = 0;
  for (let i = 0; i < hs.length; i++) for (let j = i + 1; j < hs.length; j++) {
    if (hs[i].fam === hs[j].fam || Math.abs(hs[i].y - hs[j].y) > 0.5) continue;
    if (Math.min(hs[i].hi, hs[j].hi) - Math.max(hs[i].lo, hs[j].lo) > 2) n++;
  }
  return n;
}
const orlovs = () => {
  const m = {}, add = (id, name, sex, birth, o = {}) => { m[id] = P(id, name, { sex, birth, ...o }); return id; };
  add('f', 'Николай', 'm', '1930', { spouses: ['m1', 'm2'] }); add('m1', 'Вера', 'f', '1933', { spouses: ['f'] }); add('m2', 'Людмила', 'f', '1938', { spouses: ['f'] });
  add('a', 'Алексей', 'm', '1954', { parents: ['f', 'm1'], spouses: ['sa'] }); add('b', 'Борис', 'm', '1957', { parents: ['f', 'm1'], spouses: ['sb'] });
  add('c', 'Галина', 'f', '1960', { parents: ['f', 'm1'], spouses: ['sc'] }); add('d', 'Дарья', 'f', '1966', { parents: ['f', 'm2'] });
  add('sa', 'Анна', 'f', '1955', { spouses: ['a'] }); add('sb', 'Светлана', 'f', '1959', { spouses: ['b'] }); add('sc', 'Сергей', 'm', '1958', { spouses: ['c'] });
  add('k1', 'Егор', 'm', '1980', { parents: ['a', 'sa'] }); add('k2', 'Ева', 'f', '1983', { parents: ['a', 'sa'] }); add('k3', 'Игорь', 'm', '1985', { parents: ['b', 'sb'] });
  return m;
};
test('layout: семья с двумя браками и семью детьми — шины разведены, линий-перекрытий нет', () => {
  for (const direction of ['up', 'down']) {
    const L = layout(orlovs(), { direction }), x = id => L.byId[id].x;
    assert.equal(collinearOverlaps(L), 0, 'шины разных семей на одной высоте (' + direction + ')');
    assert.equal(crossings(L), 0, 'пересечения (' + direction + ')');
    assert.equal(cardHits(L), 0, 'проход сквозь карточки (' + direction + ')');
    assert.ok(x('a') < x('b') && x('b') < x('c'), 'дети одного брака: от старшего к младшему');
    assert.ok(x('d') < x('a') || x('d') > x('c'), 'ребёнок от другого брака — отдельным блоком, не посередине');
    assert.ok(x('sa') < x('a'), 'супруга первого в своей группе — снаружи (слева)');
    assert.ok(x('sc') > x('c'), 'супруг последнего — справа');
    assert.ok((x('m2') < x('f') && x('f') < x('m1')) || (x('m1') < x('f') && x('f') < x('m2')), 'общий родитель между своими супругами');
  }
});

// реальный случай: сёстры с общими родителями, одна замужем в семью с длинной родословной
const twoLines = () => {
  const m = {}, add = (id, o = {}) => { m[id] = P(id, id, o); };
  add('eka'); add('pel');
  add('vyach', { parents: ['eka'], spouses: ['nad'] }); add('serg', { parents: ['eka'] });
  add('nad', { parents: ['pel'], spouses: ['vyach'] }); add('nik', { parents: ['pel'] });
  add('vlad', { spouses: ['lyub'] }); add('lyub', { spouses: ['vlad'] });
  add('alev', { parents: ['vlad', 'lyub'], spouses: ['val'] }); add('val', { spouses: ['alev'] });
  add('nat', { parents: ['vlad', 'lyub'], spouses: ['rom'] });
  add('rom', { parents: ['vyach', 'nad'], spouses: ['nat'] }); add('tat', { parents: ['vyach', 'nad'] });
  add('nika', { parents: ['alev', 'val'] }); add('dm', { parents: ['rom', 'nat'] });
  return m;
};
test('поколения: сёстры в одном ряду, предки без родителей вплотную над детьми', () => {
  const g = assignGenerations(twoLines());
  assert.equal(g.alev, g.nat, 'сёстры с общими родителями — один ряд');
  assert.equal(g.alev, g.rom, 'и супруг сестры из другой семьи — тот же ряд');
  assert.equal(g.vlad, g.lyub);
  assert.equal(g.vlad, g.nad, 'Владимировы — ровесники Надежды/Вячеслава (на ряд ниже их родителей)');
  assert.equal(g.alev, g.vlad + 1, 'дети ровно на ряд ниже родителей');
  assert.equal(g.nika, g.dm, 'внуки одного поколения');
  assert.equal(g.eka, 0); assert.equal(g.pel, 0);
  for (const id of Object.keys(g)) for (const p of twoLines()[id].parents) assert.ok(g[id] === g[p] + 1, id + ' строго на ряд ниже ' + p);
});
test('поколения: грязные данные (предок как супруг, цикл) не вешают расчёт', () => {
  const m = { a: P('a', 'A', { parents: ['b'] }), b: P('b', 'B', { parents: ['a'] }), c: P('c', 'C', { spouses: ['a'] }) };
  const g = assignGenerations(m);
  assert.ok(Object.values(g).every(Number.isFinite));
});

test('layout: шины разных семей на разных родителях не сливаются на одной высоте', () => {
  for (const direction of ['up', 'down']) {
    const L = layout(twoLines(), { direction });
    assert.equal(collinearOverlaps(L), 0, 'наложение шин разных семей (' + direction + ')');
    assert.equal(cardHits(L), 0, 'проход сквозь карточки (' + direction + ')');
  }
});

// ---------- подсветка семей ----------
import { surnameKey, surnameToken, detectOrder, surnameIndex, surnameSet, familySet } from '../public/js/family.js';
test('фамилии: мужская и женская формы — один ключ', () => {
  for (const [a, b] of [['Родов', 'Родова'], ['Демуцкий', 'Демуцкая'], ['Коноплянников', 'Коноплянникова'], ['Левицький', 'Левицька'], ['Мартыненко', 'Мартыненко'], ['Синий', 'Синяя'.replace('яя', 'ая')]])
    assert.equal(surnameKey(a), surnameKey(b), a + ' ~ ' + b);
  assert.notEqual(surnameKey('Владимиров'), surnameKey('Владимир'), 'имя Владимир — не фамилия Владимиров');
});
test('фамилии: определяется в обоих порядках слов и не путается с именами', () => {
  assert.equal(surnameToken('Иван Родов', 'last'), 'Родов');
  assert.equal(surnameToken('Мартыненко Роман', 'first'), 'Мартыненко');
  assert.equal(surnameToken('Демуцкий Валентин', 'last'), 'Демуцкий', 'Валентин — имя, хоть и на -ин');
  assert.equal(surnameToken('Лев Толстой', 'last'), 'Толстой', 'Лев — имя');
  assert.equal(surnameToken('Мартыненко Дмитрий', 'last'), 'Мартыненко');
  assert.equal(surnameToken('Мартыненко Дмитрий Иванович', 'first'), 'Мартыненко');
});
const fam = () => {
  const m = {}, add = (id, name, o = {}) => { m[id] = P(id, name, o); };
  add('a', 'Мартыненко Вячеслав', { spouses: ['b'] }); add('b', 'Мартыненко Надежда', { spouses: ['a'], maidenName: 'Коноплянникова' });
  add('c', 'Мартыненко Роман', { parents: ['a', 'b'], spouses: ['d'] }); add('d', 'Мартыненко Наталия', { spouses: ['c'], maidenName: 'Владимирова', parents: ['e', 'f'] });
  add('e', 'Владимиров Владимир', { spouses: ['f'] }); add('f', 'Владимирова Любовь', { spouses: ['e'] });
  add('g', 'Мартыненко Дмитрий', { parents: ['c', 'd'] }); add('h', 'Никитченко Татьяна', { parents: ['a', 'b'], maidenName: 'Мартыненко' });
  return m;
};
test('подсветка по фамилии: порядок слов, девичьи фамилии, счётчики', () => {
  const p = fam(), idx = surnameIndex(p);
  assert.equal(idx.order, 'first');
  const mart = surnameKey('Мартыненко');
  assert.deepEqual([...surnameSet(p, mart, false, idx)].sort(), ['a', 'b', 'c', 'd', 'g']);
  assert.deepEqual([...surnameSet(p, mart, true, idx)].sort(), ['a', 'b', 'c', 'd', 'g', 'h'], 'с девичьей: Татьяна урожд. Мартыненко');
  assert.deepEqual([...surnameSet(p, surnameKey('Владимиров'), true, idx)].sort(), ['d', 'e', 'f'], 'Наталия — урожд. Владимирова');
  const row = idx.list.find(x => x.key === surnameKey('Владимиров'));
  assert.equal(row.label, 'Владимиров'); assert.equal(row.count, 2); assert.equal(row.maidenOnly, 1);
  assert.equal(idx.list[0].label, 'Мартыненко', 'самая многочисленная — первой');
});
test('подсветка одной семьи: своя, родительская, вся ветвь', () => {
  const p = fam(), ids = s => [...s].sort();
  assert.deepEqual(ids(familySet(p, 'c', 'own')), ['c', 'd', 'g'], 'человек, супруга, ребёнок');
  assert.deepEqual(ids(familySet(p, 'c', 'parents')), ['a', 'b', 'c', 'h'], 'родители и все их дети');
  const br = familySet(p, 'g', 'branch');
  for (const x of ['a', 'b', 'c', 'd', 'e', 'f', 'g']) assert.ok(br.has(x), x);
  assert.equal(familySet(p, 'нет', 'own').size, 0);
});
