// Раскладка древа. Чистая функция: people → координаты и пути линий.
// Работает одинаково в браузере, на сервере (офлайн-экспорт) и в тестах.
import { yearOf, roman } from './util.js';

export const CARD = { w: 196, h: 96, gap: 64, unitGap: 64, rootGap: 104, rowGap: 112, pad: 64, yearPx: 8, genYears: 28 };

const arr = x => (Array.isArray(x) ? x : []);

/**
 * Поколения. Ограничения:
 *  — ребёнок строго ниже родителей;
 *  — на одном уровне: супруги, явные «братья/сёстры» и дети общего родителя (в т.ч. единокровные);
 * Сначала всё «опускается» от корней как можно меньше (ASAP), затем предки без родителей подтягиваются
 * вплотную к своим детям (ALAP): иначе пара без записанных предков повисала бы в самом верхнем ряду,
 * на 1–2 уровня выше своих ровесников и детей.
 * Работает с классами равенства (union-find), устойчиво к циклам в «грязных» данных.
 */
export function assignGenerations(people) {
  const ids = Object.keys(people), root = {};
  for (const id of ids) root[id] = id;
  const find = x => { while (root[x] !== x) { root[x] = root[root[x]]; x = root[x]; } return x; };
  const union = (a, b) => { if (people[a] && people[b]) root[find(a)] = find(b); };
  const kidsOf = new Map();
  for (const id of ids) {
    for (const s of [...arr(people[id].spouses), ...arr(people[id].siblings)]) union(id, s);
    for (const p of arr(people[id].parents)) if (people[p] && p !== id) (kidsOf.get(p) ?? kidsOf.set(p, []).get(p)).push(id);
  }
  for (const kids of kidsOf.values()) for (let i = 1; i < kids.length; i++) union(kids[0], kids[i]);

  const cls = [...new Set(ids.map(find))], lvl = new Map(cls.map(c => [c, 0]));
  const down = new Map(cls.map(c => [c, new Set()]));          // класс → классы его детей
  for (const [p, kids] of kidsOf) for (const k of kids) { const a = find(p), b = find(k); if (a !== b) down.get(a).add(b); }
  const cap = cls.length;
  for (let it = 0, lim = cls.length * 2 + 10; it < lim; it++) {
    let ch = false;
    for (const [a, set] of down) for (const b of set) if (lvl.get(b) < lvl.get(a) + 1 && lvl.get(a) < cap) { lvl.set(b, lvl.get(a) + 1); ch = true; }
    if (!ch) break;
  }
  // ALAP: от нижних уровней к верхним поднимаем класс вплотную к ближайшему из детей
  for (const c of [...cls].sort((a, b) => lvl.get(b) - lvl.get(a))) {
    const set = down.get(c);
    if (!set.size) continue;
    const want = Math.min(...[...set].map(k => lvl.get(k))) - 1;
    if (want > lvl.get(c)) lvl.set(c, want);
  }
  const gen = {};
  for (const id of ids) gen[id] = lvl.get(find(id));
  return gen;
}

/** Линия с закруглёнными углами; направление (вверх/вниз) определяется координатами концов. */
function elbow(x1, y1, x2, y2, ym) {
  if (Math.abs(y2 - y1) < 8) return `M${x1} ${y1}L${x2} ${y2}`;
  if (Math.abs(x2 - x1) < 1) return `M${x1} ${y1}V${y2}`;
  const d = y2 > y1 ? 1 : -1, s = x2 > x1 ? 1 : -1;
  const r = Math.max(0, Math.min(12, Math.abs(x2 - x1) / 2, Math.abs(ym - y1), Math.abs(y2 - ym)));
  return `M${x1} ${y1}V${ym - d * r}Q${x1} ${ym} ${x1 + s * r} ${ym}H${x2 - s * r}Q${x2} ${ym} ${x2} ${ym + d * r}V${y2}`;
}

/**
 * Год рождения каждого человека для режима «по годам». Известный — как есть; неизвестный оценивается
 * по супругу, братьям/сёстрам, родителям (+28 лет), детям (−28 лет); в крайнем случае — по поколению.
 */
function estimateYears(people, ids, par, gen0, genYears) {
  const cur = new Map(), est = new Set();
  for (const id of ids) { const y = yearOf(people[id].birth); if (y !== null) cur.set(id, y); }
  const kidsOf = new Map();
  for (const id of ids) for (const p of par(id)) (kidsOf.get(p) ?? kidsOf.set(p, []).get(p)).push(id);
  const sibs = id => {
    const s = new Set(arr(people[id].siblings).filter(x => people[x]));
    for (const p of par(id)) for (const k of kidsOf.get(p) || []) if (k !== id) s.add(k);
    return [...s];
  };
  const avg = list => { const v = list.map(x => cur.get(x)).filter(x => x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  for (let pass = 0; pass < 8; pass++) {
    let ch = false;
    for (const id of ids) {
      if (cur.has(id)) continue;
      let y = avg(arr(people[id].spouses).filter(x => people[x]));
      if (y === null) y = avg(sibs(id));
      if (y === null) { const a = avg(par(id)); if (a !== null) y = a + genYears; }
      if (y === null) { const k = (kidsOf.get(id) || []).map(x => cur.get(x)).filter(x => x !== undefined); if (k.length) y = Math.min(...k) - genYears; }
      if (y !== null) { cur.set(id, Math.round(y)); est.add(id); ch = true; }
    }
    if (!ch) break;
  }
  const offs = [...cur].map(([id, y]) => y - gen0[id] * genYears).sort((a, b) => a - b);
  const base = offs.length ? offs[offs.length >> 1] : 1900;
  for (const id of ids) if (!cur.has(id)) { cur.set(id, base + gen0[id] * genYears); est.add(id); }
  return { years: cur, est };
}

/**
 * @param {object} people  id → человек
 * @param {{direction?:'up'|'down', timeline?:boolean}} opts
 *   direction 'up' (по умолчанию): предки внизу, потомки выше — «жизнь растёт вверх»; 'down' — классика.
 *   timeline: вертикальная позиция карточки пропорциональна году рождения (экспериментально).
 */
export function layout(people, opts = {}) {
  const { direction = 'up', timeline = false, line = 'male', ...rest } = opts;   // line: по чьей линии «ведётся» пара — отца ('male') или матери ('female')
  const C = { ...CARD, ...rest };
  const ids = Object.keys(people);
  const empty = { nodes: [], byId: {}, edges: [], spouseLinks: [], siblingLinks: [], gens: [], ticks: [], mode: timeline ? 'time' : 'gen', direction, bounds: { w: 600, h: 400 }, card: C };
  if (!ids.length) return empty;

  const idx = new Map(ids.map((id, i) => [id, i]));
  const par = id => arr(people[id].parents).filter(p => people[p] && p !== id);

  // --- поколения (с уплотнением номеров, чтобы не было пустых рядов)
  const gen0 = assignGenerations(people);
  const distinct = [...new Set(Object.values(gen0))].sort((a, b) => a - b);
  const rank = new Map(distinct.map((g, i) => [g, i]));
  const gen = id => rank.get(gen0[id]);

  // --- юниты: связные компоненты супругов (пара, цепочка браков)
  const adj = new Map(ids.map(id => [id, new Set()]));
  for (const id of ids) for (const s of arr(people[id].spouses)) {
    if (people[s] && s !== id) { adj.get(id).add(s); adj.get(s).add(id); }
  }
  const unitOf = new Map(), units = [];
  for (const id of ids) {
    if (unitOf.has(id)) continue;
    const comp = [], st = [id];
    unitOf.set(id, -1);
    while (st.length) {
      const x = st.pop(); comp.push(x);
      for (const y of adj.get(x)) if (!unitOf.has(y)) { unitOf.set(y, -1); st.push(y); }
    }
    const deg = x => adj.get(x).size;
    const sexKey = x => (people[x].sex === 'm' ? 0 : 1);
    const start = [...comp].sort((a, b) => deg(a) - deg(b) || sexKey(a) - sexKey(b) || idx.get(a) - idx.get(b))[0];
    const order = [], vis = new Set();
    const stack = [start];
    while (stack.length) { // обход в глубину, сохраняющий «цепочку»
      const x = stack.pop();
      if (vis.has(x)) continue;
      vis.add(x); order.push(x);
      const next = [...adj.get(x)].filter(y => !vis.has(y)).sort((a, b) => idx.get(b) - idx.get(a));
      for (const y of next) stack.push(y);
    }
    const u = { i: units.length, members: order, gen: gen(order[0]) };
    units.push(u);
    for (const m of order) unitOf.set(m, u.i);
  }

  // --- владелец юнита (чьё «дерево» он продолжает) — родители того члена пары, чья линия выбрана (по умолчанию — мужская:
  // дети носят фамилию отца, так люди одной фамилии собираются в один блок); если у него родителей нет — родители второго.
  // Среди нескольких вариантов берётся юнит с меньшим номером. Из владельцев строится лес.
  const prefSex = line === 'female' ? 'f' : 'm';
  for (const u of units) {
    const cand = [];
    for (const m of u.members) for (const p of par(m)) { const pu = unitOf.get(p); if (pu !== u.i) cand.push({ pu, m }); }
    const pref = cand.filter(c => people[c.m].sex === prefSex), pool = pref.length ? pref : cand;
    u.owner = pool.length ? Math.min(...pool.map(c => c.pu)) : null;
  }
  const kids = units.map(() => []);
  for (const u of units) if (u.owner !== null) kids[u.owner].push(u);

  // «кровный» член юнита — тот, чьи родители в юните-владельце; второй — супруг(а), пришедший со стороны
  const bloodOf = (u, owner) => u.members.filter(m => par(m).some(p => unitOf.get(p) === owner.i));
  const birthKey = (u, owner) => {
    let y = Infinity;
    for (const m of bloodOf(u, owner)) { const by = yearOf(people[m].birth); if (by !== null && by < y) y = by; }
    return y;
  };
  // Порядок детей: сначала по «браку» родителей (дети от разных браков не перемешиваются — линии не пересекутся),
  // внутри брака — от старшего к младшему.
  const famKey = (u, owner) => {
    const b = bloodOf(u, owner)[0];
    if (!b) return 0;
    const pos = par(b).filter(p => unitOf.get(p) === owner.i).map(p => owner.members.indexOf(p));
    return Math.min(...pos) + Math.max(...pos);
  };
  for (const o of units) {
    const k = kids[o.i];
    if (k.length < 2) continue;
    const meta = new Map(k.map(u => [u.i, [famKey(u, o), birthKey(u, o)]]));
    k.sort((a, b) => meta.get(a.i)[0] - meta.get(b.i)[0] || meta.get(a.i)[1] - meta.get(b.i)[1] || a.i - b.i);
    // Родные братья/сёстры стоят рядом, их супруги — снаружи: у крайнего левого — слева, у остальных — справа.
    k.forEach((u, j) => {
      if (u.members.length !== 2) return;
      const bl = bloodOf(u, o);
      if (bl.length !== 1) return;
      const sp = u.members.find(m => m !== bl[0]);
      const firstInGroup = j === 0 || meta.get(k[j - 1].i)[0] !== meta.get(u.i)[0];
      u.members = firstInGroup ? [sp, bl[0]] : [bl[0], sp];
    });
  }

  // --- корни: сначала поколение 0; явные «братья/сёстры» без родителей ставим рядом
  const rootsRaw = units.filter(u => u.owner === null).sort((a, b) => a.gen - b.gen || a.i - b.i);
  const rootSet = new Set(rootsRaw.map(u => u.i)), seenRoot = new Set(), roots = [];
  for (const r of rootsRaw) {
    if (seenRoot.has(r.i)) continue;
    const q = [r]; seenRoot.add(r.i);
    while (q.length) {
      const x = q.shift(); roots.push(x);
      for (const m of x.members) for (const s of arr(people[m].siblings)) {
        if (!people[s]) continue;
        const su = units[unitOf.get(s)];
        if (rootSet.has(su.i) && !seenRoot.has(su.i)) { seenRoot.add(su.i); q.push(su); }
      }
    }
  }

  // --- ширины поддеревьев
  const ownW = u => u.members.length * C.w + (u.members.length - 1) * C.gap;
  const widthMemo = new Map(), visiting = new Set();
  function sw(u) {
    if (widthMemo.has(u.i)) return widthMemo.get(u.i);
    visiting.add(u.i);
    const ks = kids[u.i].filter(k => !visiting.has(k.i));
    const cw = ks.length ? ks.reduce((s, k) => s + sw(k), 0) + C.unitGap * (ks.length - 1) : 0;
    visiting.delete(u.i);
    const w = Math.max(ownW(u), cw);
    widthMemo.set(u.i, w);
    return w;
  }
  const S = C.h + C.rowGap;
  const rowY = r => C.pad + r * S;
  const byId = {}, nodes = [];
  // Обход поддерева: visit(юнит, левый край его карточек). Один и тот же обход считает «чертёж» дерева и делает итоговую расстановку.
  function walk(u, left, seen, visit) {
    seen.add(u.i);
    const w = sw(u), own = ownW(u), ul = left + (w - own) / 2;
    visit(u, ul);
    const ks = kids[u.i].filter(k => !seen.has(k.i));
    if (!ks.length) return;
    const cw = ks.reduce((s, k) => s + sw(k), 0) + C.unitGap * (ks.length - 1);
    let x = left + (w - cw) / 2;
    for (const k of ks) { walk(k, x, seen, visit); x += sw(k) + C.unitGap; }
  }

  // --- «деревья» (потомки одного корня) и связи между ними: родители, пришедшие со стороны, — отдельное дерево
  const trees = [], treeOf = new Map(), seenAll = new Set();
  const addTree = r => {
    if (seenAll.has(r.i)) return;
    const t = { i: trees.length, root: r, size: 0, cx: new Map(), cells: [] };
    walk(r, 0, seenAll, (u, ul) => { treeOf.set(u.i, t.i); t.cx.set(u.i, ul + ownW(u) / 2); t.cells.push({ row: u.gen, l: ul, r: ul + ownW(u) }); t.size += u.members.length; });
    trees.push(t);
  };
  for (const r of roots) addTree(r);
  for (const u of units) addTree(u);                   // юниты из циклов
  const links = [];                                    // a-дерево содержит ребёнка (якорь xa), b-дерево — родителей (якорь xb)
  for (const u of units) for (const m of u.members) for (const p of par(m)) {
    const pu = unitOf.get(p), a = treeOf.get(u.i), b = treeOf.get(pu);
    if (pu !== u.i && a !== undefined && b !== undefined && a !== b) links.push({ a, b, xa: trees[a].cx.get(u.i), xb: trees[b].cx.get(pu), w: 1 });
  }
  for (const id of ids) for (const sb of arr(people[id].siblings)) {   // явные «брат/сестра» без общих родителей — тесно рядом
    if (!people[sb] || sb < id) continue;
    const ua = unitOf.get(id), ub = unitOf.get(sb), a = treeOf.get(ua), b = treeOf.get(ub);
    if (a !== undefined && b !== undefined && a !== b) links.push({ a, b, xa: trees[a].cx.get(ua), xb: trees[b].cx.get(ub), w: 3 });
  }

  // --- расстановка деревьев: каждое — как можно ближе к тем, с кем связано, но так, чтобы карточки в одном ряду не налезали.
  // Дерево может встать НАД свободным местом широкого соседнего ряда (его верх узкий, низ широкий) — линии получаются короткими.
  const left = new Array(trees.length).fill(0), occ = new Map(), done = new Set();
  const put = (t, x) => { left[t.i] = x; done.add(t.i); for (const c of t.cells) (occ.get(c.row) ?? occ.set(c.row, []).get(c.row)).push([c.l + x, c.r + x]); };
  const rightEdge = () => { let m = C.pad - C.rootGap; for (const v of occ.values()) for (const iv of v) if (iv[1] > m) m = iv[1]; return m; };
  if (trees.length) {
    put(trees.reduce((b, t) => (t.size > b.size ? t : b), trees[0]), C.pad);   // самое большое дерево — опора
    while (done.size < trees.length) {
      const pull = new Map();
      for (const L of links) {
        if (done.has(L.a) && !done.has(L.b)) pull.set(L.b, (pull.get(L.b) || 0) + L.w);
        else if (done.has(L.b) && !done.has(L.a)) pull.set(L.a, (pull.get(L.a) || 0) + L.w);
      }
      let best = null;
      for (const t of trees) if (!done.has(t.i) && (best === null || (pull.get(t.i) || 0) > (pull.get(best.i) || 0))) best = t;
      let target = rightEdge() + C.rootGap;                                    // без связей — в конец
      if (pull.get(best.i)) {                                                  // со связями — выровнять якоря (взвешенное среднее)
        let sum = 0, wsum = 0;
        for (const L of links) {
          if (L.a === best.i && done.has(L.b)) { sum += L.w * (left[L.b] + L.xb - L.xa); wsum += L.w; }
          else if (L.b === best.i && done.has(L.a)) { sum += L.w * (left[L.a] + L.xa - L.xb); wsum += L.w; }
        }
        target = sum / wsum;
      }
      // запретные сдвиги (по рядам) → ближайший допустимый к желаемому
      const forb = [];
      for (const c of best.cells) for (const [ol, or] of occ.get(c.row) || []) {
        const lo = ol - C.rootGap - c.r, hi = or + C.rootGap - c.l;
        if (hi > lo) forb.push([lo, hi]);
      }
      forb.sort((x, y) => x[0] - y[0]);
      const merged = [];
      for (const f of forb) { const last = merged[merged.length - 1]; if (last && f[0] < last[1]) last[1] = Math.max(last[1], f[1]); else merged.push([...f]); }
      const hit = merged.find(f => target > f[0] && target < f[1]);
      put(best, hit ? (target - hit[0] <= hit[1] - target ? hit[0] : hit[1]) : target);
    }
  }
  // итоговые координаты: левый край всей картины — C.pad
  const minLeft = trees.length ? Math.min(...trees.flatMap(t => t.cells.map(c => c.l + left[t.i]))) : C.pad, shift = C.pad - minLeft;
  const placed = new Set();
  for (const t of trees) walk(t.root, left[t.i] + shift, placed, (u, ul) => {
    u.members.forEach((m, i) => {
      const n = { id: m, x: ul + i * (C.w + C.gap), y: rowY(gen(m)), w: C.w, h: C.h, gen: gen(m) };
      byId[m] = n; nodes.push(n);
    });
  });

  // Страховка: при противоречивых данных (родитель и ребёнок на одном ряду) карточки не должны налезать.
  const rows = new Map();
  for (const n of nodes) (rows.get(n.y) ?? rows.set(n.y, []).get(n.y)).push(n);
  for (const row of rows.values()) {
    row.sort((a, b) => a.x - b.x || idx.get(a.id) - idx.get(b.id));
    for (let i = 1; i < row.length; i++) if (row[i].x < row[i - 1].x + C.w + C.gap) row[i].x = row[i - 1].x + C.w + C.gap;
  }

  // --- режим «по годам»: y карточки пропорционален году рождения
  let ticks = [];
  if (timeline) {
    const { years, est } = estimateYears(people, ids, par, gen0, C.genYears);
    let minY = Infinity, maxY = -Infinity;
    for (const y of years.values()) { minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
    for (const n of nodes) { n.year = years.get(n.id); n.est = est.has(n.id); n.y = C.pad + (n.year - minY) * C.yearPx; }
    const placedList = [];
    for (const n of [...nodes].sort((a, b) => a.y - b.y || a.x - b.x)) { // разводим карточки, оказавшиеся рядом по году и по горизонтали
      for (let guard = 0, moved = true; moved && guard < 60; guard++) {
        moved = false;
        for (const m of placedList) {
          if (n.x < m.x + m.w + 8 && m.x < n.x + n.w + 8 && n.y < m.y + m.h + 14 && m.y < n.y + n.h + 14) { n.y = m.y + m.h + 14; moved = true; }
        }
      }
      placedList.push(n);
    }
    for (let yr = Math.ceil(minY / 10) * 10; yr <= maxY; yr += 10) {
      // линия года Y проходит через центр карточки, родившейся в этом году
      ticks.push({ year: yr, yc: C.pad + (yr - minY) * C.yearPx + C.h / 2, label: String(yr) });
    }
  }

  // --- направление: «вверх» — зеркалим по вертикали (старшие поколения внизу)
  let bottom = Math.max(...nodes.map(n => n.y + n.h));
  const flip = y => C.pad + bottom - y;
  const gens = distinct.map((_, r) => ({ rank: r, y: rowY(r), label: roman(r + 1) }));
  if (direction === 'up') {
    for (const n of nodes) n.y = flip(n.y + n.h);
    for (const g of gens) g.y = flip(g.y + C.h);
    ticks = ticks.map(t => ({ ...t, yc: flip(t.yc) }));
  }

  // --- линии супругов (по итоговым координатам; при разном годе рождения — ступенька)
  const spouseLinks = [], pairMid = new Map();
  for (const u of units) {
    const pos = new Map(u.members.map((m, i) => [m, i]));
    const seen = new Set();
    for (const a of u.members) for (const b of adj.get(a)) {
      const key = a < b ? a + '|' + b : b + '|' + a;
      if (seen.has(key)) continue; seen.add(key);
      const [l, r] = pos.get(a) < pos.get(b) ? [a, b] : [b, a];
      const nl = byId[l], nr = byId[r], y1 = nl.y + C.h / 2, y2 = nr.y + C.h / 2;
      const mar = people[l]?.marriages?.find(m => m.with === r);
      const isDiv = mar ? !!mar.divorced : false;

      if (Math.abs(pos.get(a) - pos.get(b)) === 1) {
        const x1 = nl.x + C.w, x2 = nr.x, mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
        spouseLinks.push({ a: l, b: r, x1, x2, y: my, mx, divorced: isDiv, d: y1 === y2 ? `M${x1} ${y1}H${x2}` : `M${x1} ${y1}H${mx}V${y2}H${x2}` });
        pairMid.set(key, { x: mx, y: my });
      } else { // не соседи в ряду (редкая «звезда» браков): дуга над карточками
        const xa = nl.x + C.w / 2, xb = nr.x + C.w / 2, top = Math.min(nl.y, nr.y);
        spouseLinks.push({ a: l, b: r, mx: null, divorced: isDiv, d: `M${xa} ${nl.y}C${xa} ${top - 36} ${xb} ${top - 36} ${xb} ${nr.y}` });
      }
    }
  }

  // --- линии «родитель → ребёнок»: направление определяется итоговым положением (вверх/вниз).
  // Дети одной пары родителей — одна «семья» с общей шиной. Если у родительского юнита несколько семей
  // (несколько браков), их шины разносятся по разным уровням, порядок подбирается так, чтобы линии не пересекались.
  const fams = new Map();
  for (const id of ids) {
    const ps = par(id);
    if (!ps.length) continue;
    const c = byId[id], cx = c.x + C.w / 2;
    const upward = ps.every(p => c.y + C.h / 2 < byId[p].y + C.h / 2);   // ребёнок выше родителей
    const endY = upward ? c.y + C.h : c.y;
    const nearY = list => (upward ? Math.min(...list.map(p => byId[p].y)) : Math.max(...list.map(p => byId[p].y + C.h)));
    const add = (key, unit, parents, start, near) => {
      if (!fams.has(key)) fams.set(key, { unit, parents, start, near, kids: [] });
      fams.get(key).kids.push({ id, cx, endY });
    };
    if (ps.length === 2) {
      const [a, b] = ps, mid = pairMid.get(a < b ? a + '|' + b : b + '|' + a);
      if (mid) { add('u:' + (a < b ? a + b : b + a), unitOf.get(a), [a, b], { x: mid.x, y: mid.y }, nearY([a, b])); continue; }
    }
    for (const p of ps) {
      const n = byId[p], y1 = upward ? n.y : n.y + C.h;
      add('p:' + p, unitOf.get(p), [p], { x: n.x + C.w / 2, y: y1 }, y1);
    }
  }
  // Семьи, чьи шины лежат в одной «полосе» и перекрываются по ширине, образуют кластер: внутри кластера
  // шины разносятся по уровням (иначе линии разных семей сливаются и непонятно, кто чей ребёнок).
  const LANE = 14, perms = n => { // перестановки 0..n-1
    if (n === 1) return [[0]];
    const out = [];
    for (const p of perms(n - 1)) for (let i = 0; i < n; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
    return out;
  };
  const all = [...fams.values()];
  for (const g of all) {
    const xs = [g.start.x, ...g.kids.map(k => k.cx)];
    g.lo = Math.min(...xs); g.hi = Math.max(...xs);
    g.end = g.kids.reduce((s, k) => s + k.endY, 0) / g.kids.length;
  }
  const uf = all.map((_, i) => i), fnd = i => { while (uf[i] !== i) { uf[i] = uf[uf[i]]; i = uf[i]; } return i; };
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
    const A = all[i], B = all[j];
    if (Math.abs(A.near - B.near) < 1 && Math.abs(A.end - B.end) < 1 && Math.min(A.hi, B.hi) - Math.max(A.lo, B.lo) > 2) uf[fnd(i)] = fnd(j);
  }
  const clusters = new Map();
  all.forEach((g, i) => (clusters.get(fnd(i)) ?? clusters.set(fnd(i), []).get(fnd(i))).push(g));
  for (const gs of clusters.values()) {
    const n = gs.length, sgn = gs[0].end > gs[0].near ? 1 : -1;
    const midY = gs.reduce((s, g) => s + (g.near + g.end) / 2, 0) / n;
    let lanes = gs.map((_, i) => i), count = n;
    const yAtN = (k, m) => midY + sgn * (k - (m - 1) / 2) * LANE;
    if (n > 1 && n <= 6) {
      let best = Infinity;
      const yAt = k => yAtN(k, n);
      for (const perm of perms(n)) { // perm[i] — уровень шины семьи i (0 — ближе к родителям)
        let score = 0;
        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const yi = yAt(perm[i]), yj = yAt(perm[j]), gi = gs[i], gj = gs[j];
          const between = (y, a, b) => y > Math.min(a, b) + 0.5 && y < Math.max(a, b) - 0.5;
          const inside = x => x > gj.lo + 0.5 && x < gj.hi - 0.5;
          if (inside(gi.start.x) && between(yj, gi.start.y, yi)) score++;                  // подъём от родителей пересекает чужую шину
          for (const k of gi.kids) if (inside(k.cx) && between(yj, yi, k.endY)) score++;    // спуск к ребёнку пересекает чужую шину
        }
        if (score < best) { best = score; lanes = perm; }
      }
    } else if (n > 6) {
      // большие кластеры: жадная раскраска интервалов — перекрывающиеся семьи получают разные уровни
      const order = gs.map((_, i) => i).sort((a, b) => gs[a].lo - gs[b].lo);
      lanes = new Array(n).fill(-1); count = 0;
      for (const i of order) {
        let k = 0;
        while (order.some(j => lanes[j] === k && Math.min(gs[i].hi, gs[j].hi) - Math.max(gs[i].lo, gs[j].lo) > 2)) k++;
        lanes[i] = k; count = Math.max(count, k + 1);
      }
    }
    gs.forEach((g, i) => { g.ym = n === 1 ? (g.near + g.end) / 2 : yAtN(lanes[i], count); });
  }
  const edges = [];
  for (const g of fams.values()) {
    for (const k of g.kids) {
      const sg = k.endY > g.near ? 1 : -1;
      const ym = sg > 0 ? Math.min(g.ym, k.endY - 12) : Math.max(g.ym, k.endY + 12);   // шина не должна «проскочить» ребёнка
      edges.push({ child: k.id, parents: g.parents, d: elbow(g.start.x, g.start.y, k.cx, k.endY, ym) });
    }
  }

  // --- явные «братья/сёстры» без общих родителей: пунктир между соседними карточками одного ряда
  const siblingLinks = [], sdone = new Set();
  for (const id of ids) for (const s of arr(people[id].siblings)) {
    if (!people[s] || !byId[s]) continue;
    const key = id < s ? id + '|' + s : s + '|' + id;
    if (sdone.has(key)) continue; sdone.add(key);
    if (par(id).some(p => par(s).includes(p))) continue;
    const [l, r] = byId[id].x < byId[s].x ? [byId[id], byId[s]] : [byId[s], byId[id]];
    if (Math.abs(l.y - r.y) < 8 && r.x - (l.x + C.w) <= C.unitGap + C.rootGap) {
      const y = l.y + C.h - 12; siblingLinks.push({ a: id, b: s, d: `M${l.x + C.w} ${y}H${r.x}` });
    }
  }

  const maxX = Math.max(...nodes.map(n => n.x + n.w)), maxY = Math.max(...nodes.map(n => n.y + n.h));
  return { nodes, byId, edges, spouseLinks, siblingLinks, gens, ticks, mode: timeline ? 'time' : 'gen', direction, bounds: { w: maxX + C.pad, h: maxY + C.pad }, card: C };
}

/** Предки и потомки человека (для подсветки линии рода). */
export function lineage(people, id) {
  const set = new Set([id]);
  const up = [id];
  while (up.length) for (const p of arr(people[up.pop()]?.parents)) if (people[p] && !set.has(p)) { set.add(p); up.push(p); }
  const kidsOf = new Map();
  for (const p of Object.values(people)) for (const x of arr(p.parents)) (kidsOf.get(x) ?? kidsOf.set(x, []).get(x)).push(p.id);
  const down = [id];
  while (down.length) for (const k of kidsOf.get(down.pop()) || []) if (!set.has(k)) { set.add(k); down.push(k); }
  return set;
}

/** Родственники человека по группам (с учётом производных братьев/сестёр). */
export function relatives(people, id) {
  const p = people[id];
  const all = Object.values(people);
  const parents = arr(p.parents).filter(x => people[x]);
  const children = all.filter(q => arr(q.parents).includes(id)).map(q => q.id);
  const sib = new Set(arr(p.siblings).filter(x => people[x]));
  for (const q of all) if (q.id !== id && arr(q.parents).some(x => parents.includes(x))) sib.add(q.id);
  for (const q of all) if (arr(q.siblings).includes(id)) sib.add(q.id);
  const spouses = arr(p.spouses).filter(x => people[x]);
  // старшие первыми; без даты — в конце, затем по имени (порядок стабилен между запусками)
  const byAge = (a, b) => (yearOf(people[a].birth) ?? Infinity) - (yearOf(people[b].birth) ?? Infinity) || people[a].name.localeCompare(people[b].name, 'ru');
  children.sort(byAge);
  return { parents, spouses, siblings: [...sib].sort(byAge), children };
}
