import { esc, lifeText, ageText, matchPrefix, searchPeople, thumbUrl, plural, yearOf, parseDate, fullName, marriageInfo, norm } from './util.js';
import { layout, lineage, relatives } from './layout.js';
import { surnameIndex, surnameSet, familySet } from './family.js';
import { stats, upcoming } from './stats.js';
import { treeSvg } from './svg.js';

const $ = id => document.getElementById(id);
const CID = Math.random().toString(36).slice(2, 10);
const isMobile = () => matchMedia('(max-width:850px)').matches;
const S = { me: null, trees: [], doc: null, L: null, sel: null, focusSet: null, hl: null, edit: null, ro: false, ws: null, retry: 0, retryT: 0,
  view: { x: 0, y: 0, k: 1 } };
const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* квота */ } }, del: k => { try { localStorage.removeItem(k); } catch { /* нет доступа */ } } };

// ссылка-приглашение вида /?invite=… : запоминаем токен и убираем его из адресной строки (чтобы не светился в истории и «Поделиться»)
{ const u = new URL(location.href), t = u.searchParams.get('invite'); if (t) { store.set('rod:invite', t); u.searchParams.delete('invite'); history.replaceState(null, '', u.pathname + u.search + u.hash); } }

// настройки вида (хранятся на устройстве)
const SET = { dir: store.get('rod:dir') === 'down' ? 'down' : 'up', time: store.get('rod:time') === '1', line: store.get('rod:line') === 'female' ? 'female' : 'male' };
const layoutOpts = () => ({ direction: SET.dir, timeline: SET.time, line: SET.line });
const uniq = a => [...new Set(a)];

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
  const h = [...b].map(x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function toast(msg, err = false) {
  [...$('toasts').children].forEach(t => { if (t.textContent === msg) t.remove(); }); // без одинаковых стопок
  const t = document.createElement('div'); t.className = 'toast' + (err ? ' err' : ''); t.textContent = msg;
  $('toasts').append(t); setTimeout(() => t.remove(), err ? 6000 : 4000);
}
async function api(url, { method = 'GET', body, raw, headers } = {}) {
  const h = { 'X-Rod': '1', ...headers }; let b;
  if (raw !== undefined) b = raw; else if (body !== undefined) { h['Content-Type'] = 'application/json'; b = JSON.stringify(body); }
  let r;
  try { 
    r = await fetch(url, { method, headers: h, body: b, credentials: 'same-origin' }); 
    if (r.ok && method !== 'GET' && url.includes('/save')) {
      // Если сеть появилась и это сохранение — очищаем дубли из очереди
      const q = JSON.parse(localStorage.getItem('rod:queue') || '[]');
      const newQ = q.filter(x => x.url !== url || JSON.stringify(x.body) !== JSON.stringify(body));
      localStorage.setItem('rod:queue', JSON.stringify(newQ));
    }
  }
  catch (e) { 
    if (method !== 'GET' && url.includes('/save')) {
      const q = JSON.parse(localStorage.getItem('rod:queue') || '[]');
      q.push({ url, method, body, headers: h });
      localStorage.setItem('rod:queue', JSON.stringify(q));
      toast('Нет связи с сервером. Нет возможности обновить данные — они сохранены локально и отправятся, как только связь появится.', false);
      return { noop: false, rev: S.doc.rev + 1, local: true }; // Фейковый успех для UI
    }
    throw Object.assign(new Error('Нет соединения с сервером'), { offline: true }); 
  }
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || 'Ошибка ' + r.status), { status: r.status, data: d });
  return d;
}
const people = () => S.doc?.people || {};

// ================= тема =================
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#0F1A18' : '#0E2B28';
}
applyTheme(store.get('rod:theme') || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light'));

// ================= модальные окна =================
let modalOnClose = null;
function openModal(title, html, onClose) {
  $('modalTitle').textContent = title; $('modalBody').innerHTML = html; $('modal').hidden = false; modalOnClose = onClose || null;
  return $('modalBody');
}
function closeModal() { if ($('modal').hidden) return; $('modal').hidden = true; $('modalBody').innerHTML = ''; modalOnClose?.(); modalOnClose = null; }
$('modalClose').onclick = closeModal;
$('modal').addEventListener('mousedown', e => { if (e.target === $('modal')) closeModal(); });

/** Универсальный диалог: подтверждение и/или поля ввода. Возвращает значения или null. */
function dialog({ title, text = '', fields = [], ok = 'ОК', danger = false }) {
  return new Promise(resolve => {
    let done = false;
    const body = openModal(title, `<form id="dlg">${text ? `<p style="margin:4px 0 8px">${esc(text)}</p>` : ''}${fields.map(f =>
      `<label for="dlg-${f.id}">${esc(f.label)}</label><input id="dlg-${f.id}" type="${f.type || 'text'}" value="${esc(f.value || '')}" autocomplete="${f.type === 'password' ? 'off' : 'off'}">`).join('')}
      <div class="err" id="dlgErr" role="alert"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn ghost" type="button" id="dlgNo">Отмена</button><button class="btn ${danger ? 'danger' : ''}" type="submit">${esc(ok)}</button></div></form>`,
    () => { if (!done) resolve(null); });
    const finish = v => { done = true; closeModal(); resolve(v); };
    body.querySelector('#dlgNo').onclick = () => finish(null);
    body.querySelector('#dlg').onsubmit = e => {
      e.preventDefault();
      const vals = Object.fromEntries(fields.map(f => [f.id, body.querySelector('#dlg-' + f.id).value]));
      const bad = fields.find(f => f.validate && f.validate(vals[f.id], vals));
      if (bad) { body.querySelector('#dlgErr').textContent = bad.validate(vals[bad.id], vals); return; }
      finish(vals);
    };
    (body.querySelector('input') || body.querySelector('button[type=submit]')).focus();
  });
}

// ================= вход =================
let registering = false;
function setAuthMode(reg) {
  registering = reg;
  $('authTitle').textContent = reg ? 'Новый кабинет' : 'Вход';
  $('authBtn').textContent = reg ? 'Зарегистрироваться' : 'Войти';
  $('switchAuth').textContent = reg ? 'У меня уже есть аккаунт' : 'Создать аккаунт';
  $('pwHint').hidden = !reg; $('password').autocomplete = reg ? 'new-password' : 'current-password'; $('authErr').textContent = '';
}
$('switchAuth').onclick = () => setAuthMode(!registering);
$('authForm').onsubmit = async e => {
  e.preventDefault(); $('authBtn').disabled = true;
  try {
    const body = { username: $('login').value.trim(), password: $('password').value }, tok = store.get('rod:invite');
    if (registering && tok) body.invite = tok;
    const r = await api(registering ? '/api/register' : '/api/login', { method: 'POST', body });
    if (registering && tok) { store.del('rod:invite'); if (r.joined) store.set('rod:last', r.joined); }   // ссылка уже использована при регистрации
    $('password').value = ''; await boot();
  }
  catch (err) { $('authErr').textContent = err.message; }
  finally { $('authBtn').disabled = false; }
};
function showAuth(msg) { $('app').hidden = true; $('auth').hidden = false; authInit(msg); }
// Экран входа: кто может регистрироваться и приглашение (если пришли по ссылке)
async function authInit(msg) {
  let info = { registration: 'invite', firstRun: false }, inv = null, note = '';
  try { info = await api('/api/public-info'); } catch { /* нет связи — оставляем осторожные значения */ }
  const tok = store.get('rod:invite');
  if (tok) {
    try { inv = await api('/api/invite/' + encodeURIComponent(tok)); }
    catch (e) { if (e.status === 404) { store.del('rod:invite'); note = 'Эта ссылка-приглашение уже недействительна или использована. Попросите прислать новую.'; } }
  }
  const canReg = info.registration === 'open' || info.firstRun || (!!inv && info.registration === 'invite');
  $('switchAuth').hidden = !canReg; $('regHint').hidden = canReg || !!inv;
  $('inviteBanner').hidden = !inv;
  if (inv) { $('inviteBanner').textContent = `${inv.by} приглашает вас в древо «${inv.tree}». Создайте аккаунт — или войдите, если он у вас уже есть.`; setAuthMode(true); }
  else if (info.firstRun) setAuthMode(true);
  else if (registering && !canReg) setAuthMode(false);
  $('authErr').textContent = msg || note || '';
}
// Уже вошедший пользователь открыл ссылку-приглашение (или вошёл после неё): принимаем
async function acceptPending() {
  const tok = store.get('rod:invite'); if (!tok) return;
  try {
    const r = await api('/api/invite/accept', { method: 'POST', body: { token: tok } });
    store.del('rod:invite'); store.set('rod:last', r.treeId);
    S.trees = (await api('/api/me')).trees;
    toast(r.already ? `Вы уже в древе «${r.tree}»` : `Вы добавлены в древо «${r.tree}»`);
  } catch (e) { store.del('rod:invite'); toast(e.status === 410 ? 'Приглашение недействительно или истекло — попросите прислать новую ссылку' : e.message); }
}

// ================= загрузка =================
async function boot() {
  try {
    const d = await api('/api/me');
    S.me = d.user; S.trees = d.trees; S.ro = false; document.body.classList.remove('ro'); $('banner').hidden = true;
    store.set('rod:me', JSON.stringify(d.user));
    $('auth').hidden = true; $('app').hidden = false; $('who').textContent = '@' + S.me.username;
    await acceptPending(); renderTrees();
    const last = store.get('rod:last');
    const first = S.trees.find(t => t.id === last) || S.trees[0];
    if (first) await openTree(first.id); else { S.doc = null; resetCanvas(); }
  } catch (e) {
    if (e.status === 401) showAuth();
    else if (e.offline && bootOffline()) return;
    else { showAuth(e.message); }
  }
}
function bootOffline() {
  const me = store.get('rod:me'), last = store.get('rod:last'), cached = last && store.get('rod:cache:' + last);
  if (!me || !cached) return false;
  try {
    S.me = JSON.parse(me); S.ro = false; /* Разрешаем правки */
    $('auth').hidden = true; $('app').hidden = false; $('who').textContent = '@' + S.me.username;
    S.trees = [{ id: last, name: JSON.parse(cached).name, count: Object.keys(JSON.parse(cached).people).length, rev: JSON.parse(cached).rev }];
    setDoc(JSON.parse(cached)); renderTrees(); fit();
    showBanner('Нет соединения: показана последняя сохранённая копия, только просмотр.');
    return true;
  } catch { return false; }
}
function showBanner(text, actions = '') { $('banner').innerHTML = `<span>${esc(text)}</span>${actions}`; $('banner').hidden = false; }

async function syncQueue() {
  if (!navigator.onLine || !S.doc) return;
  const q = JSON.parse(localStorage.getItem('rod:queue') || '[]');
  if (!q.length) return;
  toast('Связь появилась: синхронизируем изменения...');
  for (const req of q) {
    try {
      const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      if (r.status === 409) { toast('Конфликт правок: карточку изменили на другом устройстве!', true); }
    } catch (e) { break; } // Если сеть снова пропала — выходим
  }
  localStorage.removeItem('rod:queue');
  boot(); // Перезагружаем актуальные данные с сервера
}
window.addEventListener('online', syncQueue);

document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !S.me || S.ro) return;
  try { const d = await api('/api/me'); S.trees = d.trees; renderTrees(); } catch { /* офлайн */ }
});

function renderTrees() {
  $('treeList').innerHTML = S.trees.map(t => `<button class="tree-item ${S.doc?.id === t.id ? 'active' : ''}" data-id="${esc(t.id)}">${esc(t.name)}<small>${t.count} ${plural(t.count, 'участник', 'участника', 'участников')} · r${t.rev}</small></button>`).join('')
    || '<p style="color:#8FB0A6;font-size:13px;margin:0">Пока нет ни одного древа</p>';
}
$('treeList').addEventListener('click', e => { const b = e.target.closest('.tree-item'); if (b) { closeSide(); openTree(b.dataset.id); } });

async function openTree(id) {
  if (S.edit?.dirty && !(await confirmDiscard())) return;
  try {
    const doc = await api('/api/trees/' + id);
    closeDrawer(true); S.sel = null; S.focusSet = null; S.hl = null; updateHlBar();
    store.set('rod:last', id);
    setDoc(doc); renderTrees(); fit(); connect();
  } catch (e) { toast(e.message, true); }
}
function setDoc(doc) {
  S.doc = doc;
  $('treeName').textContent = doc.name; document.title = doc.name + ' — Род';
  $('exportBtn').href = `/api/trees/${doc.id}/export`; $('exportBtn').hidden = false;
  $('renameBtn').hidden = S.ro; $('addPerson').hidden = S.ro;
  renderCollabs(); relayout(); cacheDoc();
  const t = S.trees.find(x => x.id === doc.id);
  if (t) { t.name = doc.name; t.rev = doc.rev; t.count = Object.keys(doc.people).length; renderTrees(); }
}
let cacheT = 0;
function cacheDoc() { clearTimeout(cacheT); cacheT = setTimeout(() => { if (S.doc && !S.ro) store.set('rod:cache:' + S.doc.id, JSON.stringify(S.doc)); }, 800); }
function renderCollabs() {
  const d = S.doc, owner = d?.isOwner;
  $('inviteForm').hidden = !owner || S.ro;
  $('linkInviteBtn').hidden = !owner || S.ro;
  $('shareBox').hidden = !d;
  $('collabs').innerHTML = d ? (d.collaborators.length ? d.collaborators.map(c => `<div class="collab"><span>@${esc(c.username)}</span>${owner ? `<button data-uid="${esc(c.id)}" aria-label="Убрать доступ ${esc(c.username)}">×</button>` : ''}</div>`).join('') : '<span>Пока только вы</span>') : '';
}
$('collabs').addEventListener('click', async e => {
  const b = e.target.closest('button[data-uid]'); if (!b) return;
  const name = b.parentElement.textContent.replace('×', '').trim();
  if (!(await dialog({ title: 'Убрать доступ?', text: `${name} больше не сможет видеть и редактировать это древо.`, ok: 'Убрать', danger: true }))) return;
  try { const r = await api(`/api/trees/${S.doc.id}/unshare`, { method: 'POST', body: { userId: b.dataset.uid } }); S.doc.collaborators = r.collaborators; renderCollabs(); } catch (err) { toast(err.message, true); }
});
$('inviteForm').onsubmit = async e => {
  e.preventDefault(); if (!S.doc || !$('invite').value.trim()) return;
  try { const r = await api(`/api/trees/${S.doc.id}/share`, { method: 'POST', body: { username: $('invite').value.trim() } }); S.doc.collaborators = r.collaborators; renderCollabs(); $('invite').value = ''; toast('Родственник получил доступ к древу'); }
  catch (err) { toast(err.message, true); }
};

// ================= реальное время =================
function setPresence(users, text) {
  $('presence').classList.toggle('on', !!users);
  $('presenceText').textContent = users ? (users.map(u => u.username).join(', ') || 'только вы') : text;
}
function connect() {
  clearTimeout(S.retryT);
  if (S.ws) { S.ws.onclose = null; try { S.ws.close(); } catch { /* закрыт */ } }
  if (!S.doc || S.ro) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?tree=${S.doc.id}`);
  S.ws = ws;
  ws.onopen = () => { S.retry = 0; };
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.type === 'hello') applyHello(m.doc);
    else if (m.type === 'patch') applyPatch(m);
    else if (m.type === 'presence') setPresence(m.users);
    else if (m.type === 'deleted') { toast('Древо удалено или доступ к нему закрыт', true); S.ws = null; ws.onclose = null; boot(); }
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    setPresence(null, 'переподключение…');
    S.retry++; S.retryT = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(S.retry, 4)));
  };
}
function applyHello(doc) { // после (пере)подключения — актуальный снимок
  if (!S.doc || doc.id !== S.doc.id) return;
  const changed = Object.keys({ ...doc.people, ...S.doc.people }).filter(id => JSON.stringify(doc.people[id]) !== JSON.stringify(S.doc.people[id]));
  if (doc.rev === S.doc.rev && !changed.length) return;
  setDoc(doc); afterRemoteChange(changed);
}
async function resync() { const doc = await api('/api/trees/' + S.doc.id); const ch = Object.keys({ ...doc.people, ...S.doc.people }).filter(id => JSON.stringify(doc.people[id]) !== JSON.stringify(S.doc.people[id])); setDoc(doc); afterRemoteChange(ch); }
function applyPatch(m) {
  if (!S.doc || m.noop || m.rev <= S.doc.rev) return;
  if (m.baseRev !== S.doc.rev) { resync().catch(() => {}); return; }
  S.doc.rev = m.rev; if (m.nameChanged) { S.doc.name = m.name; $('treeName').textContent = m.name; document.title = m.name + ' — Род'; }
  for (const [id, p] of Object.entries(m.upserts)) S.doc.people[id] = p;
  for (const id of m.removes) delete S.doc.people[id];
  setDoc(S.doc);
  if (m.cid !== CID) { toast(`${m.by}: ${m.note}`); afterRemoteChange([...Object.keys(m.upserts), ...m.removes]); }
  else afterRemoteChange([]);
}
function afterRemoteChange(ids) {
  const ed = S.edit;
  if (ed && !ed.isNew && ids.includes(ed.id)) {
    const gone = !people()[ed.id];
    if (ed.dirty || gone) showEditNotice(gone ? 'Эту карточку удалили на другом устройстве.' : 'Эту карточку только что изменили на другом устройстве.', gone);
    else renderEdit(ed.id);
  } else if (!ed && S.sel) {
    if (!people()[S.sel]) closeDrawer(true); else if (ids.includes(S.sel) || !ids.length) renderView(S.sel);
  }
}

// ================= раскладка и рисование =================
let cardEls = new Map(), edgeEls = [], linkEls = [], rulerEls = [], rulerYs = [];
function resetCanvas() {
  S.L = layout({}); $('cards').innerHTML = ''; $('edges').innerHTML = ''; $('ruler').innerHTML = ''; cardEls.clear();
  $('treeName').textContent = 'Выберите древо'; $('exportBtn').hidden = true; $('renameBtn').hidden = true; $('addPerson').hidden = true;
  $('minimap').innerHTML = ''; $('shareBox').hidden = true; renderEmpty(); setPresence(null, 'офлайн');
}
function relayout() {
  const P = people(); S.L = layout(P, layoutOpts());
  const { L } = S;
  $('world').style.width = L.bounds.w + 'px'; $('world').style.height = L.bounds.h + 'px';
  const svg = $('edges'); svg.setAttribute('width', L.bounds.w); svg.setAttribute('height', L.bounds.h);
  const wedYear = l => parseDate((P[l.a]?.marriages || []).find(m => m.with === l.b)?.date)?.y;
  svg.innerHTML = (L.ticks || []).map(t => `<line class="tk" x1="0" x2="${L.bounds.w}" y1="${t.yc}" y2="${t.yc}"/>`).join('')
    + (L.siblingLinks || []).map(l => `<path class="s lk" data-a="${esc(l.a)}" data-b="${esc(l.b)}" d="${l.d}"/>`).join('')
    + L.edges.map(e => `<path class="e" data-c="${esc(e.child)}" data-p="${esc(e.parents.join(','))}" d="${e.d}"/>`).join('')
    + L.spouseLinks.map(l => `<g class="lk" data-a="${esc(l.a)}" data-b="${esc(l.b)}"><path class="m" d="${l.d}"/>${l.mx !== null ? `<circle class="u" cx="${l.mx}" cy="${l.y}" r="4"/>${wedYear(l) ? `<text class="my" x="${l.mx}" y="${l.y - 8}" text-anchor="middle">${wedYear(l)}</text>` : ''}` : ''}</g>`).join('');
  edgeEls = [...svg.querySelectorAll('path.e')]; linkEls = [...svg.querySelectorAll('.lk')];
  // линейка: поколения (с десятилетиями) или годы (режим «по годам»)
  const ruler = L.mode === 'time'
    ? L.ticks.map(t => ({ y: t.yc - 10, html: `<div class="gen">${t.label}</div>` }))
    : L.gens.map(g => {
      const ys = L.nodes.filter(n => n.gen === g.rank).map(n => yearOf(P[n.id].birth)).filter(y => y !== null).sort((a, b) => a - b);
      const dec = ys.length ? `<small>${Math.floor(ys[ys.length >> 1] / 10) * 10}-е</small>` : '';
      return { y: g.y, html: `<div class="gen">${g.label}${dec}</div>` };
    });
  rulerYs = ruler.map(r => r.y);
  $('ruler').innerHTML = ruler.map(r => r.html).join('');
  rulerEls = [...$('ruler').children];
  drawMinimap();
  cardEls.forEach(el => el.remove()); cardEls.clear();
  renderVisible();
  renderEmpty();
  refreshHl();
  if (S.hl) applyDim(); else if (S.focusSet) setFocus(S.sel);
  applyView(); // позиции линейки и мини-карты пересчитываются после любой смены раскладки
}
function renderEmpty() {
  const el = $('emptyState'), n = Object.keys(people()).length;
  el.hidden = !!S.doc && n > 0;
  if (el.hidden) return;
  if (!S.doc) {
    el.innerHTML = `<h3>Создайте первое древо</h3><p>Начните с пустого древа или посмотрите, как всё устроено, на небольшом образце.</p>
      <div class="row-b"><button class="btn gold" data-e="new">Создать пустое древо</button><button class="btn ghost" data-e="sample">Открыть образец</button><button class="btn ghost" data-e="import">Импортировать архив</button></div>`;
  } else {
    el.innerHTML = `<h3>Древо пока пусто</h3><p>Добавьте первого участника — например, самого старшего из тех, о ком вы знаете. Поколения и связи выстроятся сами.</p>
      ${S.ro ? '' : '<div class="row-b"><button class="btn gold" data-e="add">Добавить первого участника</button></div>'}`;
  }
}
$('emptyState').addEventListener('click', async e => {
  const a = e.target.closest('[data-e]')?.dataset.e;
  if (a === 'add') openEdit(null);
  else if (a === 'new') newTree(false);
  else if (a === 'sample') newTree(true, 'Образец: род Родовых');
  else if (a === 'import') $('importInput').click();
});

$('addPerson').onclick = () => openEdit(null); // кнопка «＋» в углу холста

const letter = p => (p.name || '?').trim()[0] || '?';
function cardHtml(p) {
  const av = p.photo ? `<img class="avatar" src="${esc(thumbUrl(p.photo))}" alt="" loading="lazy" draggable="false">` : `<div class="avatar">${esc(letter(p))}</div>`;
  const life = lifeText(p), age = ageText(p), sub = p.maidenName ? 'урожд. ' + p.maidenName : p.occupation || p.birthPlace || '';
  return `<div class="p-top">${av}<div class="p-name">${esc(p.name)}</div></div><div class="p-life">${esc(life)}${age ? ' · ' + esc(age) : ''}</div><div class="p-sub">${esc(sub)}</div>`;
}
function makeCard(n) {
  const p = people()[n.id], el = document.createElement('div');
  el.className = `person ${p.sex}${(p.death || '').trim() ? ' dead' : ''}${S.sel === p.id ? ' sel' : ''}${dimSet() && !dimSet().has(p.id) ? ' dim' : ''}${n.est ? ' est' : ''}`;
  el.dataset.id = p.id; el.tabIndex = 0; el.setAttribute('role', 'button'); el.setAttribute('aria-label', `${fullName(p)}. ${lifeText(p)}`); if (n.est) el.title = 'Год рождения не указан — положение оценено по родственникам';
  el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; el.innerHTML = cardHtml(p);
  return el;
}
function renderVisible() {
  const { x, y, k } = S.view, v = $('viewport'), M = 300;
  const x0 = (-x - M) / k, y0 = (-y - M) / k, x1 = (v.clientWidth - x + M) / k, y1 = (v.clientHeight - y + M) / k;
  const frag = document.createDocumentFragment();
  for (const n of S.L.nodes) {
    const vis = n.x + n.w > x0 && n.x < x1 && n.y + n.h > y0 && n.y < y1;
    const el = cardEls.get(n.id);
    if (vis && !el) { const c = makeCard(n); cardEls.set(n.id, c); frag.append(c); }
    else if (!vis && el) { el.remove(); cardEls.delete(n.id); }
  }
  $('cards').append(frag);
  $('world').classList.toggle('far', k < 0.55);
}
const dimSet = () => (S.hl ? S.hl.set : S.focusSet);
function applyDim() {
  const set = dimSet();
  cardEls.forEach((el, pid) => el.classList.toggle('dim', !!set && !set.has(pid)));
  for (const e of edgeEls) {
    const on = !!set && set.has(e.dataset.c) && e.dataset.p.split(',').some(p => set.has(p));
    e.classList.toggle('hl', on); e.classList.toggle('dim', !!set && !on);
  }
  for (const g of linkEls) g.classList.toggle('dim', !!set && !(set.has(g.dataset.a) && set.has(g.dataset.b)));
}
function setFocus(id) {          // временная подсветка предков и потомков (наведение/выбор); постоянная подсветка приоритетнее
  S.focusSet = !S.hl && id && people()[id] ? lineage(people(), id) : null;
  applyDim();
}
// ----- постоянная подсветка: по фамилии или «одна семья»
function computeHl(spec) {
  const P = people();
  if (spec.kind === 'surname') {
    const idx = surnameIndex(P), row = idx.list.find(x => x.key === spec.key);
    return { spec, set: surnameSet(P, spec.key, spec.maiden, idx), label: 'Фамилия: ' + (row?.label || '') };
  }
  const name = P[spec.id]?.name || '';
  const lab = { own: 'Семья', parents: 'Родительская семья', branch: 'Ветвь' }[spec.mode];
  return { spec, set: familySet(P, spec.id, spec.mode), label: `${lab}: ${name}` };
}
function setHl(spec) {
  S.hl = spec ? computeHl(spec) : null;
  if (S.hl && !S.hl.set.size) S.hl = null;
  if (S.hl) S.focusSet = null;
  updateHlBar(); applyDim();
}
function refreshHl() { if (S.hl) { S.hl = computeHl(S.hl.spec); if (!S.hl.set.size) S.hl = null; updateHlBar(); } }
function updateHlBar() {
  const bar = $('hlBar'); bar.hidden = !S.hl;
  if (S.hl) { $('hlLabel').textContent = `${S.hl.label} · ${S.hl.set.size}`; $('hlOpen').title = `Подсвечено: ${S.hl.label}. Нажмите, чтобы изменить`; }
}
$('hlClear').onclick = () => setHl(null);
$('hlOpen').onclick = () => openHighlight();
function markSelected() { cardEls.forEach((el, id) => el.classList.toggle('sel', id === S.sel)); }

// ----- мини-карта
function drawMinimap() {
  const { bounds: b, nodes } = S.L, mm = $('minimap');
  mm.setAttribute('viewBox', `0 0 ${b.w} ${b.h}`);
  mm.innerHTML = nodes.map(n => `<rect x="${n.x}" y="${n.y}" width="${n.w}" height="${n.h}" rx="10" fill="${people()[n.id]?.sex === 'f' ? '#B8665C' : '#5F8798'}" opacity=".75"/>`).join('') + '<rect class="vp" x="0" y="0" width="0" height="0"/>';
}
function updateMinimap() {
  const vp = $('minimap').querySelector('.vp'); if (!vp) return;
  const { x, y, k } = S.view, v = $('viewport');
  vp.setAttribute('x', -x / k); vp.setAttribute('y', -y / k); vp.setAttribute('width', v.clientWidth / k); vp.setAttribute('height', v.clientHeight / k);
}
$('minimap').addEventListener('pointerdown', e => {
  const mm = $('minimap'), r = mm.getBoundingClientRect(), { w, h } = S.L.bounds, s = Math.min(r.width / w, r.height / h);
  const wx = (e.clientX - r.left - (r.width - w * s) / 2) / s, wy = (e.clientY - r.top - (r.height - h * s) / 2) / s;
  const v = $('viewport'); S.view.x = v.clientWidth / 2 - wx * S.view.k; S.view.y = v.clientHeight / 2 - wy * S.view.k; applyView();
});

// ----- вид: панорама, зум, щипок
let raf = 0;
function applyView() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const { x, y, k } = S.view;
    $('world').style.transform = `translate(${x}px,${y}px) scale(${k})`;
    rulerYs.forEach((gy, i) => { const el = rulerEls[i]; if (el) { const sy = (gy + 10) * k + y; el.style.transform = `translateY(${sy}px)`; el.style.display = sy < -30 || sy > $('viewport').clientHeight ? 'none' : ''; } });
    updateMinimap(); renderVisible();
  });
}
const clampK = k => Math.max(0.1, Math.min(2.5, k));
function zoomAt(cx, cy, f) {
  const v = S.view, nk = clampK(v.k * f), r = nk / v.k;
  v.x = cx - (cx - v.x) * r; v.y = cy - (cy - v.y) * r; v.k = nk; applyView();
}
function fit() {
  const v = $('viewport'), { w, h } = S.L.bounds;
  const k = clampK(Math.min((v.clientWidth - 40) / w, (v.clientHeight - 60) / h, 1));
  S.view = { k, x: (v.clientWidth - w * k) / 2, y: Math.max(24, (v.clientHeight - h * k) / 2) };
  applyView();
}
function centerOn(id, minK = 0.8) {
  const n = S.L.byId[id]; if (!n) return;
  const v = $('viewport'), k = Math.max(S.view.k, minK), vw = v.clientWidth - (!isMobile() && $('drawer').classList.contains('open') ? 430 : 0);
  const ty = isMobile() && $('drawer').classList.contains('open') ? Math.min(v.clientHeight * 0.12, 90) : v.clientHeight / 2;
  S.view = { k, x: vw / 2 - (n.x + n.w / 2) * k, y: ty - (n.y + n.h / 2) * k }; applyView();
}
function ensureVisible(id) {
  const n = S.L.byId[id]; if (!n) return;
  if (isMobile()) { // карточка остаётся видимой над нижним листом
    const v = $('viewport'), k = Math.max(S.view.k, 0.7), sy = n.y * k + S.view.y + (n.h * k) / 2;
    if (sy > v.clientHeight * 0.2 || sy < 40 || k !== S.view.k) {
      S.view = { k, x: v.clientWidth / 2 - (n.x + n.w / 2) * k, y: Math.min(v.clientHeight * 0.12, 90) - (n.y + n.h / 2) * k + 0 }; applyView();
    }
    return;
  }
  const v = $('viewport'), { x, y, k } = S.view, vw = v.clientWidth - 430;
  const sx = n.x * k + x, sy = n.y * k + y;
  if (sx < 40 || sx + n.w * k > vw - 20 || sy < 20 || sy + n.h * k > v.clientHeight - 20) centerOn(id, Math.min(S.view.k, 1) < .6 ? .8 : S.view.k);
}
$('fit').onclick = fit;
$('zoomIn').onclick = () => zoomAt($('viewport').clientWidth / 2, $('viewport').clientHeight / 2, 1.25);
$('zoomOut').onclick = () => zoomAt($('viewport').clientWidth / 2, $('viewport').clientHeight / 2, 0.8);

const vp = $('viewport'), ptrs = new Map();
let pan = null, pinch = null, downTarget = null, moved = false;
const mid = () => { const a = [...ptrs.values()]; return { x: (a[0].x + a[1].x) / 2, y: (a[0].y + a[1].y) / 2, d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1 }; };
const rel = e => { const r = vp.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
vp.addEventListener('pointerdown', e => {
  if (e.target.closest('.tools,.minimap,#addPerson,#emptyState .btn')) return;
  ptrs.set(e.pointerId, rel(e));
  if (ptrs.size === 1) { pan = { ...rel(e), vx: S.view.x, vy: S.view.y }; downTarget = e.target; moved = false; }
  else if (ptrs.size === 2) { const m = mid(); pinch = { ...m, k: S.view.k, vx: S.view.x, vy: S.view.y }; pan = null; moved = true; }
});
vp.addEventListener('pointermove', e => {
  if (!ptrs.has(e.pointerId)) return;
  ptrs.set(e.pointerId, rel(e));
  if (pinch && ptrs.size >= 2) {
    const m = mid(), nk = clampK(pinch.k * m.d / pinch.d), r = nk / pinch.k;
    S.view = { k: nk, x: m.x - (pinch.x - pinch.vx) * r, y: m.y - (pinch.y - pinch.vy) * r }; applyView();
  } else if (pan) {
    const p = rel(e), dx = p.x - pan.x, dy = p.y - pan.y;
    if (!moved && Math.hypot(dx, dy) > 6) { moved = true; vp.classList.add('grabbing'); try { vp.setPointerCapture(e.pointerId); } catch { /* ok */ } }
    if (moved) { S.view.x = pan.vx + dx; S.view.y = pan.vy + dy; applyView(); }
  }
});
const endPtr = e => {
  if (!ptrs.has(e.pointerId)) return;
  if (e.type === 'pointerup' && !moved && ptrs.size === 1) {
    const card = downTarget?.closest?.('.person'); if (card) selectPerson(card.dataset.id);
  }
  ptrs.delete(e.pointerId); vp.classList.remove('grabbing');
  if (ptrs.size < 2) pinch = null;
  if (ptrs.size === 0) pan = null;
  else if (ptrs.size === 1) { const p = [...ptrs.values()][0]; pan = { ...p, vx: S.view.x, vy: S.view.y }; moved = true; }
};
vp.addEventListener('pointerup', endPtr); vp.addEventListener('pointercancel', endPtr);
vp.addEventListener('wheel', e => { e.preventDefault(); const p = rel(e); zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))); }, { passive: false });
vp.addEventListener('keydown', e => {
  if (e.target.closest('.person') && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectPerson(e.target.closest('.person').dataset.id); return; }
  if (e.target !== vp) return;
  const st = 80, m = { ArrowLeft: [st, 0], ArrowRight: [-st, 0], ArrowUp: [0, st], ArrowDown: [0, -st] }[e.key];
  if (m) { e.preventDefault(); S.view.x += m[0]; S.view.y += m[1]; applyView(); }
  else if (e.key === '+' || e.key === '=') zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, 1.2);
  else if (e.key === '-') zoomAt(vp.clientWidth / 2, vp.clientHeight / 2, 0.83);
  else if (e.key === '0') fit();
});
vp.addEventListener('mouseover', e => { const c = e.target.closest?.('.person'); if (c && matchMedia('(hover:hover)').matches && !S.sel) setFocus(c.dataset.id); });
vp.addEventListener('mouseout', e => { if (e.target.closest?.('.person') && !S.sel && matchMedia('(hover:hover)').matches) setFocus(null); });
addEventListener('resize', () => { applyView(); });

// ================= карточка: просмотр =================
function selectPerson(id) {
  if (S.edit?.dirty) { confirmDiscard().then(ok => ok && selectPerson(id)); return; }
  S.edit = null; S.sel = id; markSelected(); setFocus(id); renderView(id); openDrawer(); ensureVisible(id);
}
function openDrawer() { $('drawer').classList.add('open'); $('drawer').setAttribute('aria-hidden', 'false'); }
async function closeDrawer(force = false) {
  if (!force && S.edit?.dirty && !(await confirmDiscard())) return;
  S.edit = null; S.sel = null; $('drawer').classList.remove('open'); $('drawer').setAttribute('aria-hidden', 'true'); markSelected(); setFocus(null);
}
const confirmDiscard = () => dialog({ title: 'Отменить несохранённые правки?', text: 'Изменения в карточке ещё не сохранены.', ok: 'Отменить правки', danger: true }).then(Boolean);
$('closeDrawer').onclick = () => closeDrawer();

const nameChip = id => people()[id] ? `<button class="chip" data-go="${esc(id)}">${esc(fullName(people()[id]))}</button>` : '';
function renderView(id) {
  const p = people()[id]; if (!p) return closeDrawer(true);
  const rel = relatives(people(), id), age = ageText(p);
  const facts = [['Место рождения', p.birthPlace], ['Место смерти / захоронения', p.deathPlace], ['Школа', p.school], ['Образование', p.education], ['Профессия', p.occupation], ['Место работы', p.workplace]].filter(f => f[1]);
  const telHref = x => 'tel:' + x.replace(/[^\d+]/g, ''), mailList = s => s.split(/[\s,;]+/).filter(Boolean);
  const contacts = [
    p.phone && `<li><b>Телефон:</b>${p.phone.split(/\s*[,;]\s*/).filter(Boolean).map(x => `<a href="${esc(telHref(x))}">${esc(x)}</a>`).join(', ')}</li>`,
    p.email && `<li><b>E-mail:</b>${mailList(p.email).map(x => `<a href="mailto:${esc(x)}">${esc(x)}</a>`).join(', ')}</li>`,
    p.address && `<li><b>Адрес:</b>${esc(p.address)}</li>`].filter(Boolean).join('');
  const weddings = (() => {
    const li = rel.spouses.map(id => {
      const m = (p.marriages || []).find(w => w.with === id); if (!m) return '';
      const mi = marriageInfo(p, people()[id], m.date);
      return `<li><b>Свадьба с ${esc(people()[id].name)}:</b>${esc(m.date)}${mi ? ` · ${mi.years} ${plural(mi.years, 'год', 'года', 'лет')} ${mi.ended ? 'в браке' : 'вместе'}${mi.jubilee ? ' · ' + mi.jubilee : ''}` : ''}</li>`;
    }).filter(Boolean).join('');
    return li ? `<ul class="facts" style="margin-top:8px">${li}</ul>` : '';
  })();
  const group = (t, ids) => ids.length ? `<h3 class="d-h">${t}</h3><div class="chips">${ids.map(nameChip).join('')}</div>` : '';
  $('drawerBody').innerHTML = `
    ${p.photo ? `<div class="photo" id="bigPhoto" role="button" tabindex="0" aria-label="Открыть фото в полном размере"><img src="${esc(thumbUrl(p.photo, 'm'))}" alt="${esc(p.name)}"></div>` : `<div class="photo ph">${esc(letter(p))}</div>`}
    <h2 class="d-name">${esc(p.name)}</h2>${p.maidenName ? `<div class="d-maiden">урожд. ${esc(p.maidenName)}</div>` : ''}
    <div class="d-life">${esc(lifeText(p) || 'Даты не указаны')}${age ? ` · ${esc(age)}` : ''}</div>
    ${facts.length ? `<ul class="facts">${facts.map(([k, v]) => `<li><b>${k}:</b>${esc(v)}</li>`).join('')}</ul>` : ''}
    ${contacts ? `<h3 class="d-h">Контакты</h3><ul class="facts">${contacts}</ul>` : ''}
    ${(p.docs || []).length ? `<h3 class="d-h">Документы</h3><div class="doc-list">${p.docs.map(docRow).join('')}</div>` : ''}
    ${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : '<p class="bio" style="color:var(--muted)">Биография пока не добавлена.</p>'}
    ${group('Родители', rel.parents)}${group('Супруги', rel.spouses)}${weddings}${group('Братья и сёстры', rel.siblings)}${group('Дети', rel.children)}
    ${S.ro ? '' : `<h3 class="d-h">Добавить родственника</h3><div class="chips">
      <button class="chip" data-add="parent">＋ Родитель</button><button class="chip" data-add="spouse">＋ Супруг(а)</button><button class="chip" data-add="child">＋ Ребёнок</button><button class="chip" data-add="sibling">＋ Брат / сестра</button></div>
    <div class="d-actions"><button class="btn" data-act="edit">Редактировать</button><button class="btn ghost" data-act="merge">Объединить с…</button></div>`}
    <div class="d-actions" style="margin-top:8px"><button class="btn ghost" data-act="hlfam">Подсветить семью</button></div>`;
}
$('drawerBody').addEventListener('click', e => {
  const t = e.target;
  const go = t.closest('[data-go]'); if (go) { selectPerson(go.dataset.go); centerOn(go.dataset.go, S.view.k); return; }
  const add = t.closest('[data-add]'); if (add) { openEdit(null, { rel: add.dataset.add, of: S.sel }); return; }
  if (t.closest('[data-act=edit]')) { openEdit(S.sel); return; }
  if (t.closest('[data-act=merge]')) { openMerge(S.sel); return; }
  if (t.closest('[data-act=hlfam]')) { openHighlight({ kind: 'family', id: S.sel }); return; }
  if (t.closest('#bigPhoto')) { const p = people()[S.sel]; $('lightbox').querySelector('img').src = p.photo; $('lightbox').hidden = false; }
});
$('drawerBody').addEventListener('keydown', e => { if ((e.key === 'Enter' || e.key === ' ') && e.target.id === 'bigPhoto') e.target.click(); });
$('lightbox').onclick = () => { $('lightbox').hidden = true; $('lightbox').querySelector('img').removeAttribute('src'); };

// ================= карточка: редактирование =================
// Выбор связей. Дубль невозможен: добавление идемпотентно, а список не зависит от потери фокуса
// (на телефоне «blur по таймеру» ломал касания). Закрывается нажатием вне поля, Esc или выбором.
document.addEventListener('pointerdown', e => document.querySelectorAll('.pk-list').forEach(b => { if (!b.parentElement.contains(e.target)) b.hidden = true; }));
function makePicker(el, { exclude, selected, max, onChange }) {
  let sel = uniq(selected), idx = 0, list = [];
  el.innerHTML = '<div class="chips"></div><input placeholder="Начните вводить имя…" autocomplete="off" aria-label="Поиск человека"><div class="pk-list" hidden></div>';
  const chips = el.querySelector('.chips'), input = el.querySelector('input'), box = el.querySelector('.pk-list');
  const draw = () => { chips.innerHTML = sel.map(id => `<span class="chip">${esc(people()[id] ? fullName(people()[id]) : '?')}<button type="button" class="x" data-id="${esc(id)}" aria-label="Убрать">×</button></span>`).join(''); };
  const show = () => {
    list = Object.values(people()).filter(p => p.id !== exclude && !sel.includes(p.id) && matchPrefix(fullName(p), input.value)).sort((a, b) => a.name.localeCompare(b.name, 'ru')).slice(0, 8);
    idx = 0; box.hidden = !list.length;
    box.innerHTML = list.map((p, i) => `<button type="button" data-id="${esc(p.id)}" class="${i === 0 ? 'sel' : ''}">${esc(fullName(p))}<br><small style="color:var(--muted)">${esc(lifeText(p))}</small></button>`).join('');
  };
  const add = id => {
    if (sel.includes(id) || !people()[id]) return;            // уже выбран — ничего не делаем
    if (sel.length >= max) return toast(`Не больше ${max} связей этого типа`, true);
    sel.push(id); input.value = ''; draw(); box.hidden = true; onChange();
  };
  input.addEventListener('input', show); input.addEventListener('focus', show);
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); idx = (idx + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % (list.length || 1); [...box.children].forEach((b, i) => b.classList.toggle('sel', i === idx)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!box.hidden && list[idx]) add(list[idx].id); }
    else if (e.key === 'Backspace' && !input.value && sel.length) { sel.pop(); draw(); show(); onChange(); }
    else if (e.key === 'Escape') { box.hidden = true; e.stopPropagation(); }
  });
  box.addEventListener('pointerdown', e => e.preventDefault()); // фокус остаётся в поле
  box.addEventListener('click', e => { const b = e.target.closest('button'); if (b) add(b.dataset.id); });
  chips.addEventListener('click', e => { const b = e.target.closest('.x'); if (b) { sel = sel.filter(x => x !== b.dataset.id); draw(); box.hidden = true; onChange(); } });
  draw();
  return { get: () => uniq(sel) };
}
const PRESET = { parent: 'Родитель', spouse: 'Супруг(а)', child: 'Ребёнок', sibling: 'Брат / сестра' };
function openEdit(id, preset = null) {
  if (S.ro || !S.doc) return;
  const P = people(), isNew = !id;
  let init = { name: '', sex: 'm', birth: '', death: '', birthPlace: '', deathPlace: '', school: '', education: '', occupation: '', workplace: '', phone: '', email: '', address: '', bio: '', photo: '', parents: [], spouses: [], siblings: [] };
  if (preset) {
    const a = P[preset.of];
    if (preset.rel === 'child') { init.parents = [a.id, ...(a.spouses[0] ? [a.spouses[0]] : [])]; }
    else if (preset.rel === 'spouse') { init.spouses = [a.id]; init.sex = a.sex === 'm' ? 'f' : 'm'; }
    else if (preset.rel === 'parent') { if (a.parents.length === 1 && P[a.parents[0]]) { init.spouses = [a.parents[0]]; init.sex = P[a.parents[0]].sex === 'm' ? 'f' : 'm'; } }
    else if (preset.rel === 'sibling') { init.parents = [...a.parents]; if (!a.parents.length) init.siblings = [a.id]; init.sex = a.sex; }
  }
  const cur = isNew ? init : P[id];
  S.edit = { id: isNew ? uuid() : id, isNew, base: isNew ? 0 : cur.r, preset, dirty: false, photo: cur.photo || '', docs: structuredClone(cur.docs || []), pickers: {} };
  if (!isNew) { S.sel = id; markSelected(); setFocus(id); }
  renderEditForm(cur, preset);
  openDrawer();
  // фокус на имя — только если пользователь уже не начал печатать в другом поле формы
  setTimeout(() => { const f = $('editForm'); if (f && !f.contains(document.activeElement)) $('fName').focus({ preventScroll: true }); }, 80);
}
function renderEdit(id) { const p = people()[id]; if (p) { S.edit.base = p.r; S.edit.photo = p.photo || ''; S.edit.docs = structuredClone(p.docs || []); renderEditForm(p, null); } }
function renderEditForm(p, preset) {
  const ed = S.edit, f = (k, label, ph = '', extra = '') => `<div><label for="f-${k}">${label}</label><input id="f-${k}" value="${esc(p[k])}" placeholder="${esc(ph)}" ${extra}></div>`;
  $('drawerBody').innerHTML = `<form id="editForm" novalidate>
    <h2 class="d-name" style="margin-bottom:2px">${ed.isNew ? 'Новый участник' : esc(p.name)}</h2>
    ${preset ? `<p class="hint-line" style="margin:0 0 8px">${PRESET[preset.rel]} для: ${esc(people()[preset.of]?.name || '')}</p>` : ''}
    <div id="editNotice"></div>
    <div class="photo-edit"><div class="photo" id="photoPrev" style="cursor:default">${ed.photo ? `<img src="${esc(thumbUrl(ed.photo, 'm'))}" alt="">` : `<span style="font-size:14px;font-family:var(--sans)">Фото не загружено</span>`}</div>
      <button class="btn gold sm" type="button" id="photoBtn">${ed.photo ? 'Заменить фото' : 'Загрузить фото'}</button><input type="file" id="photoInput" accept="image/*" hidden></div>
    <p class="hint-line">До 40 МБ, оригинал без сжатия. На телефоне в выборе можно открыть «Google Фото».</p>
    <label for="fName">Имя и фамилия</label><input id="fName" value="${esc(p.name)}" maxlength="120" required>
    <label for="fMaiden">Девичья фамилия <span style="font-weight:400">(если менялась)</span></label><input id="fMaiden" value="${esc(p.maidenName || '')}" maxlength="120" autocomplete="off">
    <div class="row2"><div><label for="fSex">Пол</label><select id="fSex"><option value="m"${p.sex === 'm' ? ' selected' : ''}>Мужской</option><option value="f"${p.sex === 'f' ? ' selected' : ''}>Женский</option></select></div>${f('birth', 'Дата рождения', '1930 или 12.05.1930')}</div>
    <div class="row2">${f('death', 'Дата смерти', 'если умер(ла)')}${f('birthPlace', 'Место рождения')}</div>
    ${f('deathPlace', 'Место смерти / захоронения')}
    <div class="row2">${f('school', 'Школа')}${f('workplace', 'Место работы')}</div>
    ${f('education', 'Профессиональное образование')}${f('occupation', 'Род занятий / профессия')}
    <h3 class="d-h">Контакты</h3>
    <div class="row2"><div><label for="f-phone">Телефон</label><input id="f-phone" type="tel" inputmode="tel" maxlength="80" autocomplete="off" value="${esc(p.phone || '')}" placeholder="+380 50 123 45 67"></div>
    <div><label for="f-email">E-mail</label><input id="f-email" type="email" multiple maxlength="200" autocomplete="off" value="${esc(p.email || '')}" placeholder="name@example.com"></div></div>
    <label for="f-address">Адрес проживания <span style="font-weight:400">(текущий или последний)</span></label><input id="f-address" maxlength="300" autocomplete="off" value="${esc(p.address || '')}" placeholder="Город, улица, дом, квартира">
    <h3 class="d-h">Документы</h3>
    <div class="docs-edit" id="docsEdit"></div>
    <button class="btn ghost sm" type="button" id="docAddBtn">＋ Добавить PDF или фото</button><input type="file" id="docInput" accept="application/pdf,.pdf,image/*" multiple hidden>
    <p class="hint-line" style="margin:6px 0 0">Метрики, свидетельства, дипломы, письма. PDF до 25 МБ; фото сохраняются без сжатия. Файл увидят все, у кого есть доступ к древу.</p>
    <label for="f-bio">Биография и воспоминания</label><textarea id="f-bio" maxlength="20000" placeholder="История человека, воспоминания, документы…">${esc(p.bio)}</textarea>
    <label>Родители</label><div class="picker" id="pk-parents"></div>
    <label>Супруги</label><div class="picker" id="pk-spouses"></div><div id="marriageRows"></div>
    <label>Братья и сёстры <span style="font-weight:400">(если родители неизвестны)</span></label><div class="picker" id="pk-siblings"></div>
    <div class="err" id="editErr" role="alert"></div>
    <div class="save-bar"><button class="btn" type="submit" id="saveBtn">Сохранить</button><button class="btn ghost" type="button" id="cancelBtn">Отмена</button>${ed.isNew ? '' : '<button class="btn ghost" type="button" id="delBtn" style="margin-left:auto;color:var(--danger)">Удалить</button>'}</div>
  </form>`;
  const mark = () => { ed.dirty = true; };
  ed.marriage = Object.fromEntries((p.marriages || []).map(m => [m.with, m.date]));
  for (const [k, max] of [['parents', 4], ['spouses', 12], ['siblings', 30]]) {
    ed.pickers[k] = makePicker($('pk-' + k), { exclude: ed.id, selected: p[k] || [], max, onChange: () => { mark(); if (k === 'spouses') renderMarriageRows(); } });
  }
  renderMarriageRows();
  $('marriageRows').addEventListener('input', e => { const i = e.target.closest('[data-wed]'); if (i) ed.marriage[i.dataset.wed] = i.value; });
  const form = $('editForm');
  form.addEventListener('input', mark); form.addEventListener('change', mark);
  form.onsubmit = e => { e.preventDefault(); savePerson(); };
  $('cancelBtn').onclick = () => { const id = ed.id; if (ed.isNew) closeDrawer(true); else { S.edit = null; renderView(id); } };
  $('delBtn')?.addEventListener('click', deletePerson);
  $('photoBtn').onclick = () => $('photoInput').click();
  renderDocsEdit(); $('docAddBtn').onclick = () => $('docInput').click(); $('docInput').onchange = uploadDocs;
  $('photoInput').onchange = uploadPhoto;
}
function renderMarriageRows() {
  const box = $('marriageRows'), ed = S.edit; if (!box || !ed) return;
  box.innerHTML = ed.pickers.spouses.get().map(id => `<div><label for="wed-${esc(id)}">Дата свадьбы с ${esc(people()[id]?.name || '?')}</label><input id="wed-${esc(id)}" data-wed="${esc(id)}" value="${esc(ed.marriage[id] || '')}" placeholder="14.06.1958 или 1958" maxlength="32" autocomplete="off"></div>`).join('');
}
function showEditNotice(text, gone) {
  const n = $('editNotice'); if (!n) return;
  n.innerHTML = `<div class="notice">${esc(text)}<div class="row-b">${gone ? '<button class="btn sm" type="button" data-n="close">Закрыть карточку</button><button class="btn ghost sm" type="button" data-n="recreate">Сохранить заново</button>'
    : '<button class="btn sm" type="button" data-n="reload">Загрузить актуальную</button><button class="btn ghost sm" type="button" data-n="over">Сохранить поверх</button>'}</div></div>`;
  n.onclick = e => {
    const a = e.target.closest('[data-n]')?.dataset.n; if (!a) return;
    if (a === 'reload') { S.edit.dirty = false; renderEdit(S.edit.id); }
    else if (a === 'close') closeDrawer(true);
    else if (a === 'over') { S.edit.base = people()[S.edit.id]?.r ?? 0; n.innerHTML = ''; toast('Теперь сохранение заменит чужую версию'); }
    else if (a === 'recreate') { S.edit.base = 0; n.innerHTML = ''; }
  };
}
// HEIC/AVIF/GIF и т.п. (например, из Google Фото) браузер умеет показать — переводим в JPEG высокого качества.
async function toJpeg(file) {
  const bmp = await createImageBitmap(file);
  if (bmp.width * bmp.height > 120e6) throw new Error('слишком большое');
  const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  return new Promise((res, rej) => c.toBlob(b => (b ? res(b) : rej(new Error('toBlob'))), 'image/jpeg', 0.95));
}
async function uploadPhoto(e) {
  let file = e.target.files[0]; e.target.value = ''; if (!file) return;
  const btn = $('photoBtn'), old = btn.textContent; btn.disabled = true; btn.innerHTML = '<span class="spin"></span> Загрузка…';
  try {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
      try { file = await toJpeg(file); toast('Формат фото преобразован в JPEG'); }
      catch { throw new Error('Не удалось прочитать это фото. Откройте его в галерее и сохраните как JPG или PNG.'); }
    }
    if (file.size > 40 * 1024 * 1024) throw new Error('Файл больше 40 МБ');
    const r = await api(`/api/trees/${S.doc.id}/photo`, { method: 'POST', raw: file, headers: { 'Content-Type': file.type } });
    S.edit.photo = r.url; S.edit.dirty = true;
    const img = new Image(); img.alt = ''; img.src = thumbUrl(r.url, 'm'); img.onerror = () => { img.onerror = null; img.src = r.url; };
    $('photoPrev').replaceChildren(img); btn.textContent = 'Заменить фото';
  } catch (err) { toast(err.message, true); btn.textContent = old; }
  finally { btn.disabled = false; }
}

// ================= вложенные документы (PDF и фото) =================
const DOC_KINDS = ['Свидетельство о рождении', 'Свидетельство о браке', 'Свидетельство о смерти', 'Метрическая запись', 'Диплом / аттестат', 'Паспорт / удостоверение', 'Военный билет', 'Письмо / открытка', 'Фото документа', 'Другое'];
const fmtBytes = n => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' МБ' : Math.max(1, Math.round(n / 1024)) + ' КБ');
const isPdf = d => d.type === 'application/pdf' || /\.pdf$/i.test(d.file || '');
function guessKind(name) {
  const n = String(name || '').toLowerCase();
  return /смерт/.test(n) ? 'Свидетельство о смерти' : /рожд/.test(n) ? 'Свидетельство о рождении' : /брак/.test(n) ? 'Свидетельство о браке' : /метрик/.test(n) ? 'Метрическая запись'
    : /диплом|аттестат/.test(n) ? 'Диплом / аттестат' : /паспорт/.test(n) ? 'Паспорт / удостоверение' : /военн/.test(n) ? 'Военный билет' : /письм|открытк/.test(n) ? 'Письмо / открытка' : '';
}
function docRow(d) {
  const title = d.title || d.name || 'Документ', meta = [d.kind, d.size ? fmtBytes(d.size) : ''].filter(Boolean).join(' · ');
  const thumb = isPdf(d) ? '<span class="doc-ico" aria-hidden="true">PDF</span>' : `<img class="doc-thumb" src="${esc(thumbUrl(d.file, 's'))}" alt="" loading="lazy">`;
  return `<div class="doc-row">${thumb}<div class="doc-main"><b>${esc(title)}</b><small>${esc(meta)}</small></div>
    <div class="doc-actions"><a class="btn ghost sm" href="${esc(d.file)}" target="_blank" rel="noopener">Открыть</a><a class="btn ghost sm" href="${esc(d.file)}" download="${esc(d.name || title)}">Скачать</a></div></div>`;
}
function renderDocsEdit() {
  const box = $('docsEdit'); if (!box) return;
  const docs = S.edit.docs;
  box.innerHTML = docs.map((d, i) => `<div class="doc-edit" data-i="${i}">
    <div class="doc-edit-head">${isPdf(d) ? '<span class="doc-ico" aria-hidden="true">PDF</span>' : `<img class="doc-thumb" src="${esc(thumbUrl(d.file, 's'))}" alt="">`}
      <span class="doc-name">${esc(d.name || 'файл')}<small> · ${esc(fmtBytes(d.size || 0))}</small></span>
      <button class="btn ghost sm" type="button" data-rm="${i}" aria-label="Убрать документ ${esc(d.title || d.name || '')}">Убрать</button></div>
    <div class="row2"><div><label>Название</label><input data-f="title" maxlength="80" value="${esc(d.title || '')}" placeholder="например, Метрика 1902"></div>
    <div><label>Вид</label><select data-f="kind"><option value="">—</option>${DOC_KINDS.map(k => `<option${k === d.kind ? ' selected' : ''}>${esc(k)}</option>`).join('')}</select></div></div></div>`).join('');
  box.oninput = box.onchange = e => { const row = e.target.closest('[data-i]'), f = e.target.dataset.f; if (!row || !f) return; S.edit.docs[+row.dataset.i][f] = e.target.value; S.edit.dirty = true; };
  box.onclick = e => { const b = e.target.closest('[data-rm]'); if (!b) return; S.edit.docs.splice(+b.dataset.rm, 1); S.edit.dirty = true; renderDocsEdit(); };
}
async function uploadDocs(e) {
  const files = [...e.target.files]; e.target.value = ''; if (!files.length) return;
  const btn = $('docAddBtn'), old = btn.textContent; btn.disabled = true;
  let done = 0;
  for (const [n, f0] of files.entries()) {
    btn.innerHTML = `<span class="spin"></span> Загрузка ${n + 1} из ${files.length}…`;
    try {
      if (S.edit.docs.length >= 40) throw new Error('У одного человека не больше 40 документов');
      let file = f0, name = f0.name;
      const pdf = f0.type === 'application/pdf' || /\.pdf$/i.test(f0.name);
      if (!pdf && !/^image\/(jpeg|png|webp)$/.test(f0.type)) {
        if (!/^image\//.test(f0.type)) throw new Error(`«${f0.name}»: нужен PDF или фото`);
        try { file = await toJpeg(f0); name = f0.name.replace(/\.[^.]+$/, '') + '.jpg'; } catch { throw new Error(`«${f0.name}»: не удалось прочитать фото`); }
      }
      if (file.size > (pdf ? 25 : 40) * 1048576) throw new Error(`«${f0.name}»: больше ${pdf ? 25 : 40} МБ`);
      const r = await api(`/api/trees/${S.doc.id}/doc`, { method: 'POST', raw: file, headers: { 'Content-Type': pdf ? 'application/pdf' : file.type } });
      S.edit.docs.push({ id: uuid(), file: r.url, type: r.type, kind: guessKind(name), title: name.replace(/\.[^.]+$/, '').slice(0, 80), name, size: r.size, added: Date.now() });
      S.edit.dirty = true; done++; renderDocsEdit();
    } catch (err) { toast(err.message, true); }
  }
  btn.disabled = false; btn.textContent = old;
  if (done) toast(done === 1 ? 'Файл загружен. Нажмите «Сохранить», чтобы он остался в карточке.' : `Загружено файлов: ${done}. Нажмите «Сохранить».`);
}

function findDuplicates(person) {
  const n = norm(person.name), by = yearOf(person.birth);
  return Object.values(people()).filter(q => q.id !== person.id && norm(q.name) === n && !(by !== null && yearOf(q.birth) !== null && yearOf(q.birth) !== by));
}
async function savePerson() {
  const ed = S.edit, v = id => $(id).value.trim(), err = $('editErr'); err.textContent = '';
  if (!v('fName')) { err.textContent = 'Укажите имя'; $('fName').focus(); return; }
  const person = { id: ed.id, name: v('fName'), maidenName: v('fMaiden'), sex: $('fSex').value, birth: v('f-birth'), death: v('f-death'), birthPlace: v('f-birthPlace'), deathPlace: v('f-deathPlace'),
    school: v('f-school'), education: v('f-education'), occupation: v('f-occupation'), workplace: v('f-workplace'), phone: v('f-phone'), email: v('f-email'), address: v('f-address'), docs: ed.docs, bio: $('f-bio').value.trim(), photo: ed.photo,
    parents: ed.pickers.parents.get(), spouses: ed.pickers.spouses.get(), siblings: ed.pickers.siblings.get() };
  person.marriages = person.spouses.filter(id => (ed.marriage[id] || '').trim()).map(id => ({ with: id, date: ed.marriage[id].trim() }));
  if (ed.isNew) { // защита от дублей: такой человек уже есть?
    const dups = findDuplicates(person);
    if (dups.length && !(await dialog({ title: 'Такой человек уже есть?', ok: 'Всё равно создать', text: `В древе уже есть: ${dups.map(d => fullName(d) + (lifeText(d) ? ' (' + lifeText(d) + ')' : '')).join('; ')}. Если это он — отмените и выберите его в полях «Родители» или «Супруги», новую карточку создавать не нужно.` }))) return;
  }
  const ops = [{ op: 'put', person, base: ed.base }];
  if (ed.preset?.rel === 'parent') { const c = people()[ed.preset.of]; if (c) ops.push({ op: 'put', person: { ...c, parents: [...new Set([...c.parents, ed.id])] }, base: c.r }); }
  const btn = $('saveBtn'); btn.disabled = true;
  try {
    const patch = await api(`/api/trees/${S.doc.id}/save`, { method: 'POST', body: { ops, cid: CID, note: (ed.isNew ? 'Добавлен: ' : 'Правка: ') + person.name } });
    applyPatch(patch);
    S.edit = null; S.sel = ed.id; markSelected(); setFocus(ed.id); renderView(ed.id); toast('Сохранено — все устройства получили обновление');
    if (ed.isNew) { await new Promise(r => setTimeout(r, 30)); ensureVisible(ed.id); }
  } catch (e) {
    btn.disabled = false;
    if (e.status === 409) { try { await resync(); } catch { /* офлайн */ } showEditNotice('Пока вы правили, эту карточку изменили на другом устройстве.', !people()[ed.id] && !ed.isNew); }
    else err.textContent = e.message;
  }
}
async function deletePerson() {
  const ed = S.edit, p = people()[ed.id];
  if (!(await dialog({ title: `Удалить «${p.name}»?`, text: 'Карточка и связи с ней исчезнут. Предыдущую версию можно вернуть из истории.', ok: 'Удалить', danger: true }))) return;
  try { applyPatch(await api(`/api/trees/${S.doc.id}/save`, { method: 'POST', body: { ops: [{ op: 'del', id: ed.id, base: ed.base }], cid: CID, note: 'Удалён: ' + p.name } })); await closeDrawer(true); toast('Участник удалён'); }
  catch (e) { toast(e.message, true); if (e.status === 409) resync().catch(() => {}); }
}
addEventListener('beforeunload', e => { if (S.edit?.dirty) { e.preventDefault(); e.returnValue = ''; } });

// ================= объединение дублей =================
function openMerge(keepId) {
  const keep = people()[keepId]; if (!keep) return;
  const first = norm(keep.name).split(/\s+/)[0];
  const body = openModal('Объединить с дубликатом', `<p style="margin:0 0 8px;color:var(--muted)">Карточка «${esc(keep.name)}» останется. Выбранный дубликат будет удалён, а его связи и непустые данные перейдут к ней.</p>
    <input id="mgSearch" placeholder="Имя дубликата" autocomplete="off" value="${esc(first)}"><div id="mgList" style="margin-top:8px"></div>`);
  const draw = () => {
    const others = Object.values(people()).filter(p => p.id !== keepId), q = $('mgSearch').value.trim();
    const list = (q ? searchPeople(others, q, 10) : others.slice(0, 10));
    $('mgList').innerHTML = list.length ? list.map(p => `<div class="h-item"><div><b>${esc(fullName(p))}</b><br><small>${esc(lifeText(p))}${p.occupation ? ' · ' + esc(p.occupation) : ''}</small></div><button class="btn ghost sm" data-m="${esc(p.id)}">Объединить</button></div>`).join('') : '<p style="color:var(--muted)">Никого не найдено</p>';
  };
  draw(); $('mgSearch').addEventListener('input', draw);
  body.onclick = async e => {
    const id = e.target.closest('[data-m]')?.dataset.m; if (!id) return;
    const drop = people()[id];
    if (!(await dialog({ title: 'Объединить карточки?', ok: 'Объединить', danger: true, text: `«${drop.name}» будет удалена, а её связи перейдут к «${keep.name}». Прежнее состояние можно вернуть из истории.` }))) return;
    try { await mergeInto(keepId, id); closeModal(); toast('Карточки объединены'); } catch (err) { toast(err.message, true); }
  };
  $('mgSearch').focus();
}
async function mergeInto(keepId, dropId) {
  const P = people(), keep = P[keepId], drop = P[dropId], pick = (a, b) => a || b;
  const merged = { ...keep };
  for (const k of ['maidenName', 'birth', 'death', 'birthPlace', 'deathPlace', 'school', 'education', 'occupation', 'workplace', 'phone', 'email', 'address', 'photo']) merged[k] = pick(keep[k], drop[k]);
  { const seen = new Set(); merged.docs = [...(keep.docs || []), ...(drop.docs || [])].filter(d => !seen.has(d.file) && seen.add(d.file)).slice(0, 40); }
  merged.bio = keep.bio && drop.bio && keep.bio !== drop.bio ? keep.bio + '\n\n' + drop.bio : pick(keep.bio, drop.bio);
  for (const k of ['parents', 'spouses', 'siblings']) merged[k] = uniq([...keep[k], ...drop[k]]).filter(x => x !== keepId && x !== dropId);
  if (merged.parents.length > 4) throw new Error('У объединённой карточки получилось больше 4 родителей — сначала уберите лишних.');
  merged.marriages = merged.spouses.map(id => { const d = (keep.marriages || []).find(m => m.with === id)?.date || (drop.marriages || []).find(m => m.with === id)?.date; return d ? { with: id, date: d } : null; }).filter(Boolean);
  const ops = [];
  for (const q of Object.values(P)) { // дети дубликата становятся детьми основной карточки
    if (q.id !== keepId && q.id !== dropId && q.parents.includes(dropId)) ops.push({ op: 'put', person: { ...q, parents: uniq(q.parents.map(x => (x === dropId ? keepId : x))) }, base: q.r });
  }
  ops.push({ op: 'put', person: merged, base: keep.r }, { op: 'del', id: dropId, base: drop.r });
  applyPatch(await api(`/api/trees/${S.doc.id}/save`, { method: 'POST', body: { ops, cid: CID, note: `Объединены: ${keep.name} ← ${drop.name}` } }));
  S.edit = null; S.sel = keepId; markSelected(); setFocus(keepId); renderView(keepId);
}

// ================= поиск =================
let sIdx = 0, sList = [];
const sInput = $('search'), sBox = $('searchResults');
function runSearch() {
  sList = searchPeople(Object.values(people()), sInput.value); sIdx = 0;
  sBox.hidden = !sInput.value.trim();
  sBox.innerHTML = sList.length ? sList.map((p, i) => `<button type="button" data-id="${esc(p.id)}" class="${i === 0 ? 'sel' : ''}">${esc(fullName(p))}<small>${esc(lifeText(p))}${p.occupation ? ' · ' + esc(p.occupation) : ''}</small></button>`).join('') : '<div style="padding:10px 12px;color:var(--muted)">Никого не найдено</div>';
}
function pickSearch(id) { sBox.hidden = true; sInput.value = ''; $('searchBox').classList.remove('open'); selectPerson(id); centerOn(id, 0.9); }
sInput.addEventListener('input', runSearch);
sInput.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sIdx = (sIdx + (e.key === 'ArrowDown' ? 1 : -1) + sList.length) % (sList.length || 1); [...sBox.children].forEach((b, i) => b.classList.toggle('sel', i === sIdx)); }
  else if (e.key === 'Enter' && sList[sIdx]) pickSearch(sList[sIdx].id);
  else if (e.key === 'Escape') { sBox.hidden = true; sInput.value = ''; sInput.blur(); }
});
sBox.addEventListener('mousedown', e => { const b = e.target.closest('button'); if (b) { e.preventDefault(); pickSearch(b.dataset.id); } });
sInput.addEventListener('blur', () => setTimeout(() => { sBox.hidden = true; $('searchBox').classList.remove('open'); }, 150));
document.addEventListener('keydown', e => {
  if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) && S.doc) { e.preventDefault(); sInput.focus(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && S.edit) { e.preventDefault(); savePerson(); }
  if (e.key === 'Escape') {
    if (!$('lightbox').hidden) $('lightbox').click();
    else if (!$('modal').hidden) closeModal();
    else if (!$('menu').hidden) $('menu').hidden = true;
    else if ($('drawer').classList.contains('open') && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) closeDrawer();
  }
});



// ================= полная копия всех данных (владелец сервера) =================
async function backupAll() {
  const ok = await dialog({ title: 'Полная копия', ok: 'Скачать',
    text: 'Скачается один ZIP-файл: все древа и все аккаунты сервера (пароли — только в виде хешей), фотографии и история правок. Это личные данные — храните файл так же бережно, как сами документы и фото. Файл сохранится в «Загрузки»; для больших древ с фото подготовка может занять до минуты.' });
  if (!ok) return;
  const a = document.createElement('a'); a.href = '/api/admin/backup'; a.download = ''; a.hidden = true;
  document.body.append(a); a.click(); a.remove();
  toast('Готовим копию… Файл появится в «Загрузках»');
}


// ================= приглашение родственников по ссылке =================
const isPrivateHost = h => /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(h) || h.endsWith('.local');
async function openInviteLinks() {
  const d = S.doc; if (!d?.isOwner || S.ro) return;
  let info = {}; try { info = await api('/api/public-info'); } catch { /* ничего */ }
  const base0 = store.get('rod:publicUrl') || info.publicUrl || (isPrivateHost(location.hostname) ? '' : location.origin);
  const body = openModal('Пригласить родственника', `<form id="invForm">
    <p class="hint-line" style="margin:0 0 6px">Человек откроет ссылку, придумает логин и пароль — и сразу сможет вносить данные в «${esc(d.name)}» со своего телефона или компьютера, из любой сети. Всё, что он изменит, видно в «Истории» с его именем, любую правку можно откатить.</p>
    <label for="invNote">Для кого (чтобы не запутаться)</label><input id="invNote" maxlength="60" placeholder="например, тётя Лена">
    <div class="row2"><div><label for="invDays">Ссылка действует</label><select id="invDays"><option value="1">1 день</option><option value="7" selected>7 дней</option><option value="30">30 дней</option></select></div>
    <div><label for="invUses">Сколько человек</label><select id="invUses"><option value="1" selected>1 человек</option><option value="3">до 3</option><option value="10">до 10</option><option value="20">до 20</option></select></div></div>
    <label for="invBase">Адрес сервера для родственников</label><input id="invBase" type="url" inputmode="url" placeholder="https://rod.example.com" value="${esc(base0)}">
    <p class="warn-line" id="invWarn" hidden></p>
    <div class="err" id="invErr" role="alert"></div>
    <div id="invResult" hidden><label for="invLink">Ссылка (показывается один раз — скопируйте и отправьте)</label>
      <div class="copy-row"><input id="invLink" readonly><button class="btn" type="button" id="invCopy">Копировать</button></div>
      <div class="copy-row"><button class="btn ghost" type="button" id="invShare" hidden>Отправить…</button></div></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px"><button class="btn ghost" type="button" id="invClose">Закрыть</button><button class="btn" type="submit">Создать ссылку</button></div>
    <div class="inv-list" id="invList" aria-live="polite"></div></form>`);
  const $b = id => body.querySelector('#' + id);
  const checkBase = () => {
    let host = ''; try { host = new URL($b('invBase').value).hostname; } catch { /* пусто */ }
    const w = $b('invWarn'); w.hidden = !(host && (isPrivateHost(host) || !/^https:/.test($b('invBase').value)));
    w.textContent = host && isPrivateHost(host) ? 'Этот адрес открывается только в вашей домашней сети — родственникам из других мест он не подойдёт. Нужен публичный адрес (см. «ДОСТУП-ИЗ-ИНТЕРНЕТА.md»).'
      : 'Без https пароль родственников пойдёт по сети открытым текстом. Лучше публичный адрес с https.';
  };
  $b('invBase').oninput = checkBase; checkBase();
  const loadList = async () => {
    try {
      const { invites } = await api(`/api/trees/${d.id}/invites`);
      $b('invList').innerHTML = invites.length ? '<label>Действующие ссылки</label>' + invites.map(i => `<div class="inv-item"><span>${esc(i.note || 'без пометки')}<small>до ${new Date(i.exp).toLocaleDateString('ru')} · осталось ${i.usesLeft}</small></span><button class="btn ghost" type="button" data-id="${esc(i.id)}">Отозвать</button></div>`).join('') : '';
    } catch { /* ничего */ }
  };
  loadList();
  $b('invList').onclick = async e => { const b = e.target.closest('button[data-id]'); if (!b) return; try { await api(`/api/trees/${d.id}/invites`, { method: 'DELETE', body: { id: b.dataset.id } }); toast('Ссылка отозвана'); loadList(); } catch (err) { toast(err.message); } };
  $b('invClose').onclick = closeModal;
  $b('invCopy').onclick = async () => { const v = $b('invLink').value; try { await navigator.clipboard.writeText(v); } catch { $b('invLink').select(); document.execCommand?.('copy'); } toast('Ссылка скопирована'); };
  if (navigator.share) { $b('invShare').hidden = false; $b('invShare').onclick = () => navigator.share({ title: `Приглашение в древо «${d.name}»`, text: `Приглашаю вас в семейное древо «${d.name}»:`, url: $b('invLink').value }).catch(() => {}); }
  $b('invForm').onsubmit = async e => {
    e.preventDefault(); $b('invErr').textContent = '';
    let base = $b('invBase').value.trim().replace(/\/+$/, '');
    try { base = new URL(base).origin; } catch { $b('invErr').textContent = 'Укажите адрес сервера, например https://rod.example.com — по нему родственники откроют древо'; return; }
    try {
      const r = await api(`/api/trees/${d.id}/invites`, { method: 'POST', body: { note: $b('invNote').value.trim(), days: +$b('invDays').value, uses: +$b('invUses').value } });
      store.set('rod:publicUrl', base);
      $b('invLink').value = `${base}/?invite=${r.token}`; $b('invResult').hidden = false; $b('invLink').focus(); $b('invLink').select();
      $b('invNote').value = ''; loadList();
    } catch (err) { $b('invErr').textContent = err.message; }
  };
}
$('linkInviteBtn').onclick = () => { closeSide(); openInviteLinks(); };

// ================= подсветка семей =================
function openHighlight(pre) {
  const P = people(), idx = surnameIndex(P), cur = S.hl?.spec;
  const start = pre || cur || (idx.list.length ? { kind: 'surname' } : { kind: 'family' });
  const persons = Object.values(P).sort((a, b) => (a.name || '').localeCompare(b.name || '', 'ru'));
  const body = openModal('Подсветка', `<form id="hlForm">
    <div class="seg" role="tablist"><button type="button" data-k="surname" role="tab">По фамилии</button><button type="button" data-k="family" role="tab">Одна семья</button></div>
    <div id="hlSurname"><label for="hlKey">Фамилия</label>
      <select id="hlKey">${idx.list.map(r => `<option value="${esc(r.key)}">${esc(r.label)} — ${r.count}${r.maidenOnly ? ` (+${r.maidenOnly} урожд.)` : ''}</option>`).join('')}</select>
      <label class="chk"><input type="checkbox" id="hlMaiden"> Включать женщин, для которых это девичья фамилия</label></div>
    <div id="hlFamily" hidden><label for="hlPerson">Человек</label>
      <select id="hlPerson">${persons.map(p => `<option value="${esc(p.id)}">${esc(p.name || 'Без имени')}${p.birth ? ' · ' + esc(String(p.birth).slice(-4)) : ''}</option>`).join('')}</select>
      <label class="chk"><input type="radio" name="hlMode" value="own"> Своя семья — человек, супруг(а), дети</label>
      <label class="chk"><input type="radio" name="hlMode" value="parents"> Родительская семья — родители и все их дети</label>
      <label class="chk"><input type="radio" name="hlMode" value="branch"> Вся ветвь — все предки и потомки</label></div>
    <div class="err" id="hlErr" role="alert"></div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">${S.hl ? '<button class="btn ghost" type="button" id="hlOff">Снять подсветку</button>' : ''}<button class="btn ghost" type="button" id="hlNo">Отмена</button><button class="btn" type="submit">Показать</button></div></form>`);
  const $b = id => body.querySelector('#' + id);
  const setKind = k => { body.querySelectorAll('.seg button').forEach(b => b.classList.toggle('on', b.dataset.k === k)); $b('hlSurname').hidden = k !== 'surname'; $b('hlFamily').hidden = k !== 'family'; body.dataset.kind = k; };
  $b('hlMaiden').checked = start.maiden !== false;
  if (start.kind === 'surname' && start.key) $b('hlKey').value = start.key;
  const sel = start.kind === 'family' ? start.id : (S.sel && P[S.sel] ? S.sel : persons[0]?.id);
  if (sel) $b('hlPerson').value = sel;
  (body.querySelector(`input[name=hlMode][value=${start.mode || 'own'}]`) || body.querySelector('input[name=hlMode]')).checked = true;
  setKind(start.kind);
  body.querySelectorAll('.seg button').forEach(b => b.onclick = () => setKind(b.dataset.k));
  $b('hlNo').onclick = closeModal;
  if ($b('hlOff')) $b('hlOff').onclick = () => { closeModal(); setHl(null); };
  $b('hlForm').onsubmit = e => {
    e.preventDefault();
    const kind = body.dataset.kind;
    let spec; // значения читаем до закрытия: закрытие очищает форму
    if (kind === 'surname') { if (!$b('hlKey').value) { $b('hlErr').textContent = 'В древе пока нет фамилий'; return; } spec = { kind, key: $b('hlKey').value, maiden: $b('hlMaiden').checked }; }
    else { if (!$b('hlPerson').value) { $b('hlErr').textContent = 'В древе пока нет людей'; return; } spec = { kind, id: $b('hlPerson').value, mode: body.querySelector('input[name=hlMode]:checked').value }; }
    closeModal(); setHl(spec);
    if (S.hl) { closeDrawer(true); S.sel = null; markSelected(); }
    toast(S.hl ? `Подсвечено: ${S.hl.set.size} чел. Остальные приглушены — крестик вверху снимает подсветку` : 'Никого не нашлось');
  };
}

// ================= боковая панель (мобильная), меню =================
const openSide = () => { $('side').classList.add('open'); $('sideScrim').classList.add('on'); };
const closeSide = () => { $('side').classList.remove('open'); $('sideScrim').classList.remove('on'); };
$('menuBtn').onclick = openSide; $('sideScrim').onclick = closeSide;
$('moreBtn').onclick = e => {
  e.stopPropagation(); const m = $('menu'); if (!m.hidden) { m.hidden = true; return; }
  const mob = isMobile(), has = !!S.doc;
  const items = [
    mob && has && ['search', 'Поиск по людям'], mob && has && ['stats', 'Статистика'], mob && has && ['history', 'История версий'], mob && has && ['export', 'Скачать архив + Obsidian'],
    has && ['poster', 'Скачать SVG-плакат'], S.me?.admin && !S.ro && ['backup', 'Полная копия всех данных (ZIP)…'], !S.ro && ['import', 'Импорт из архива'], '-',
    has && ['hl', S.hl ? 'Подсветка: изменить…' : 'Подсветить семью или фамилию…'], S.hl && ['hloff', 'Снять подсветку'], has && ['line', SET.line === 'male' ? 'Вести пары по линии матери' : 'Вести пары по линии отца'], has && ['dir', SET.dir === 'up' ? 'Потомки снизу (классика)' : 'Потомки сверху'], has && ['time', SET.time ? 'Шкала по годам: выключить' : 'Шкала по годам (эксперимент)'],
    installEvt && ['install', 'Установить приложение'],
    ['theme', document.documentElement.dataset.theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'], !S.ro && ['password', 'Сменить пароль'],
    has && S.doc.isOwner && !S.ro && ['delete', 'Удалить древо…'], '-', !S.ro && ['logout', 'Выйти']].filter(Boolean);
  m.innerHTML = items.map(i => i === '-' ? '<hr>' : `<button role="menuitem" data-m="${i[0]}">${esc(i[1])}</button>`).join('').replace(/<hr><hr>/g, '<hr>');
  const r = $('moreBtn').getBoundingClientRect(); m.hidden = false;
  m.style.top = r.bottom + 6 + 'px'; m.style.left = Math.max(8, Math.min(innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth)) + 'px';
};
document.addEventListener('click', e => { if (!e.target.closest('#menu,#moreBtn')) $('menu').hidden = true; });
$('menu').addEventListener('click', async e => {
  const a = e.target.closest('[data-m]')?.dataset.m; if (!a) return; $('menu').hidden = true;
  if (a === 'theme') { const t = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(t); store.set('rod:theme', t); }
  else if (a === 'hl') openHighlight();
  else if (a === 'hloff') setHl(null);
  else if (a === 'line') { SET.line = SET.line === 'male' ? 'female' : 'male'; store.set('rod:line', SET.line); relayout(); fit(); toast(SET.line === 'male' ? 'Пары стоят рядом с родителями мужа: люди одной отцовской фамилии собраны вместе' : 'Пары стоят рядом с родителями жены'); }
  else if (a === 'dir') { SET.dir = SET.dir === 'up' ? 'down' : 'up'; store.set('rod:dir', SET.dir); relayout(); fit(); }
  else if (a === 'time') { SET.time = !SET.time; store.set('rod:time', SET.time ? '1' : '0'); relayout(); fit(); toast(SET.time ? 'Шкала по годам включена: расстояние по вертикали соответствует разнице в годах рождения' : 'Шкала по годам выключена'); }
  else if (a === 'install') { installEvt.prompt(); installEvt = null; }
  else if (a === 'logout') { await api('/api/logout', { method: 'POST' }).catch(() => {}); S.ws?.close(); S.doc = null; S.me = null; location.reload(); }
  else if (a === 'password') changePassword();
  else if (a === 'import') $('importInput').click();
  else if (a === 'backup') backupAll();
  else if (a === 'poster') downloadPoster();
  else if (a === 'stats') showStats();
  else if (a === 'history') showHistory();
  else if (a === 'export') $('exportBtn').click();
  else if (a === 'search') { $('searchBox').classList.add('open'); sInput.focus(); }
  else if (a === 'delete') deleteTree();
});
$('statsBtn').onclick = showStats; $('historyBtn').onclick = showHistory;

async function newTree(sample, defName) {
  const v = await dialog({ title: sample ? 'Образец древа' : 'Новое древо', fields: [{ id: 'name', label: 'Название', value: defName || 'Семья ' + (S.me?.username || ''), validate: x => (x.trim() ? '' : 'Введите название') }], ok: 'Создать' });
  if (!v) return;
  try { const r = await api('/api/trees', { method: 'POST', body: { name: v.name.trim(), sample: !!sample } }); const d = await api('/api/me'); S.trees = d.trees; closeSide(); await openTree(r.id); }
  catch (e) { toast(e.message, true); }
}
$('newTree').onclick = () => newTree(false);
$('importBtn').onclick = () => $('importInput').click();
$('importInput').onchange = async e => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  toast('Импортируем…');
  try {
    const r = await api('/api/trees/import?name=' + encodeURIComponent(f.name.replace(/\.(zip|json)$/i, '')), { method: 'POST', raw: f, headers: { 'Content-Type': 'application/octet-stream' } });
    const d = await api('/api/me'); S.trees = d.trees; closeSide(); await openTree(r.id); toast('Древо импортировано как новое');
  } catch (err) { toast(err.message, true); }
};
$('renameBtn').onclick = async () => {
  const v = await dialog({ title: 'Название древа', fields: [{ id: 'name', label: 'Название', value: S.doc.name, validate: x => (x.trim() ? '' : 'Введите название') }], ok: 'Сохранить' });
  if (!v || v.name.trim() === S.doc.name) return;
  try { applyPatch(await api(`/api/trees/${S.doc.id}/save`, { method: 'POST', body: { ops: [], name: v.name.trim(), cid: CID, note: 'Переименование древа' } })); } catch (e) { toast(e.message, true); }
};
async function deleteTree() {
  const v = await dialog({ title: `Удалить древо «${S.doc.name}»?`, text: 'Будут удалены все люди, фото и история. Это действие нельзя отменить. Для подтверждения введите название древа.',
    fields: [{ id: 'n', label: 'Название древа', validate: x => (x.trim() === S.doc.name ? '' : 'Название не совпадает') }], ok: 'Удалить навсегда', danger: true });
  if (!v) return;
  try { await api('/api/trees/' + S.doc.id, { method: 'DELETE' }); S.ws && (S.ws.onclose = null); store.set('rod:last', ''); toast('Древо удалено'); await boot(); } catch (e) { toast(e.message, true); }
}
async function changePassword() {
  const v = await dialog({ title: 'Смена пароля', text: 'На остальных устройствах придётся войти заново.', ok: 'Сменить', fields: [
    { id: 'o', label: 'Текущий пароль', type: 'password', validate: x => (x ? '' : 'Введите текущий пароль') },
    { id: 'n', label: 'Новый пароль (от 8 символов)', type: 'password', validate: x => (x.length >= 8 ? '' : 'Не короче 8 символов') },
    { id: 'n2', label: 'Повторите новый пароль', type: 'password', validate: (x, a) => (x === a.n ? '' : 'Пароли не совпадают') }] });
  if (!v) return;
  try { await api('/api/password', { method: 'POST', body: { oldPassword: v.o, newPassword: v.n } }); toast('Пароль изменён'); } catch (e) { toast(e.message, true); }
}
function downloadPoster() {
  const svg = treeSvg(people(), S.L, { theme: document.documentElement.dataset.theme });
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  a.download = (S.doc.name.replace(/[^\p{L}\p{N}]+/gu, '_') || 'tree') + '.svg'; document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ================= статистика и история =================
function showStats() {
  if (!S.doc) return;
  const s = stats(people()), up = upcoming(people());
  const box = (n, t) => `<div class="stat"><b>${n}</b><span>${t}</span></div>`;
  const list = (t, arr) => arr.length ? `<h3 class="d-h">${t}</h3><div class="chips">${arr.map(([k, n]) => `<span class="chip">${esc(k)} · ${n}</span>`).join('')}</div>` : '';
  const body = openModal('Статистика', s.total ? `<div class="stat-grid">${box(s.total, 'участников')}${box(s.generations, plural(s.generations, 'поколение', 'поколения', 'поколений'))}${box(s.living, 'живых')}${box(s.deceased, 'ушли из жизни')}${box(s.male + ' / ' + s.female, 'мужчин / женщин')}${box(s.avgLifespan ?? '—', 'средняя продолжительность жизни, лет')}</div>
    ${s.oldest ? `<p>Старший по возрасту: <button class="chip" data-go="${esc(s.oldest.id)}">${esc(s.oldest.name)}</button> — ${s.oldest.years} ${plural(s.oldest.years, 'год', 'года', 'лет')}</p>` : ''}
    ${list('Профессии', s.occupations)}${list('Места рождения', s.places)}${list('Частые имена', s.names)}
    <h3 class="d-h">Ближайшие даты (45 дней)</h3>${up.length ? up.map(u => `<div class="h-item"><div><b>${esc(u.name)}</b><br><small>${u.kind === 'birthday' ? `День рождения, исполняется ${u.years}` : u.kind === 'wedding' ? `Годовщина свадьбы, ${u.years} ${plural(u.years, 'год', 'года', 'лет')}${u.jubilee ? ' (' + u.jubilee + ')' : ''}` : `Годовщина памяти, ${u.years} ${plural(u.years, 'год', 'года', 'лет')}`} · ${u.left === 0 ? 'сегодня' : `через ${u.left} ${plural(u.left, 'день', 'дня', 'дней')}`}</small></div></div>`).join('') : '<p style="color:var(--muted)">Нет — даты считаются только по полной дате вида 12.05.1930.</p>'}` : '<p>В древе пока никого нет.</p>');
  body.onclick = e => { const g = e.target.closest('[data-go]'); if (g) { closeModal(); selectPerson(g.dataset.go); centerOn(g.dataset.go, .9); } };
}
const ago = ts => { const m = Math.round((Date.now() - ts) / 60000); if (m < 1) return 'только что'; if (m < 60) return `${m} мин назад`; const h = Math.round(m / 60); if (h < 24) return `${h} ч назад`; return new Date(ts).toLocaleString('ru', { dateStyle: 'medium', timeStyle: 'short' }); };
async function showHistory() {
  if (!S.doc) return;
  const body = openModal('История версий', '<p style="color:var(--muted)">Загрузка…</p>');
  try {
    const { rev, items } = await api(`/api/trees/${S.doc.id}/history`);
    const tags = c => { const t = c.slice(0, 5).map(x => `<span class="tag ${x.kind}">${{ add: '＋', del: '−', edit: '✎' }[x.kind]} ${esc(x.name)}</span>`).join(''); return t + (c.length > 5 ? `<span class="tag">и ещё ${c.length - 5}</span>` : ''); };
    body.innerHTML = `<p style="color:var(--muted);margin:0 0 4px">Каждая правка сохранена с автором и временем. Восстановление создаёт новую версию, ничего не стирая.</p>` + (items.length ? items.map(v => `
      <div class="h-item${v.rev === rev ? ' cur' : ''}"><div><b>r${v.rev} · ${esc(v.note)}</b><br><small>@${esc(v.author)} · ${esc(ago(v.ts))}</small><div>${tags(v.changes)}${v.renamed ? '<span class="tag">название</span>' : ''}</div></div>
      ${v.rev === rev ? '<small>текущая</small>' : S.ro ? '' : `<button class="btn ghost sm" data-r="${v.rev}">Восстановить</button>`}</div>`).join('') : '<p>Правок пока нет.</p>');
    body.onclick = async e => {
      const b = e.target.closest('[data-r]'); if (!b) return;
      if (!(await dialog({ title: `Вернуть древо к версии r${b.dataset.r}?`, text: 'Текущее состояние останется в истории, его можно будет вернуть.', ok: 'Восстановить' }))) return showHistory();
      try { applyPatch(await api(`/api/trees/${S.doc.id}/restore`, { method: 'POST', body: { rev: Number(b.dataset.r), cid: CID } })); toast('Версия восстановлена на всех устройствах'); closeModal(); }
      catch (err) { toast(err.message, true); showHistory(); }
    };
  } catch (e) { body.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}

// ================= установка как приложения (Android, Windows, ChromeOS) =================
let installEvt = null;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; });
addEventListener('appinstalled', () => { installEvt = null; toast('Приложение установлено'); });

// ================= запуск =================
$('searchBtn').onclick = () => { $('searchBox').classList.add('open'); sInput.focus(); };
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
setAuthMode(false);
boot();
