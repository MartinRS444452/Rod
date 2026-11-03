// Сквозная проверка в настоящем Chromium. Запуск:  node tools/e2e.mjs
// Нужен playwright (npm i -D playwright && npx playwright install chromium). Скриншоты — в ./shots
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startServer } from '../server.js';
import { readZip } from '../lib/zip.js';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/home/claude/.npm-global/lib/node_modules/playwright')); }
const SHOTS = path.resolve('shots'); fs.mkdirSync(SHOTS, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-e2e-'));
const app = await startServer({ port: 0, dataDir: dir, host: '127.0.0.1', env: { REG_LIMIT_PER_HOUR: '1000' } });
const base = `http://127.0.0.1:${app.port}`;
const browser = await chromium.launch({ args: ['--no-sandbox'] });
const problems = [], results = [];
const watch = (page, tag) => {
  page.on('pageerror', e => problems.push(`[${tag}] pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|Failed to load resource.*(401|403|409|400|404)/.test(m.text() + (m.location()?.url || ''))) problems.push(`[${tag}] console.error: ${m.text()}`); });
};
async function step(name, fn) {
  const t = Date.now();
  try { await fn(); results.push(['ok', name]); console.log(`  ✓ ${name} (${Date.now() - t} мс)`); }
  catch (e) { try { const pg = (typeof A !== 'undefined') ? A : null; if (pg) await pg.screenshot({ path: path.join(SHOTS, 'FAIL-' + results.length + '.png') }); } catch {} results.push(['fail', name, e.message]); console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').slice(0, 16).join('\n      ')}`); }
}
const shot = (p, n) => p.screenshot({ path: path.join(SHOTS, n + '.png') });
const cards = p => p.locator('.person');
// как пользователь: если панель карточки закрывает нужную карточку — сначала закрыть панель
const pick = async (p, name) => {
  if (await p.locator('#drawer.open').count()) { await p.evaluate(() => document.getElementById('closeDrawer').click()); await p.waitForFunction(() => !document.getElementById('drawer').classList.contains('open')); await p.waitForTimeout(350); }
  await p.evaluate(() => document.getElementById('fit').click()); await p.waitForTimeout(120);   // «показать всё», как сделал бы человек
  await p.locator('.person', { hasText: name }).click();
};
const fillPersonForm = async (p, v) => { for (const [k, val] of Object.entries(v)) await p.locator(k).fill(val); };

const ctx1 = await browser.newContext({ viewport: { width: 1280, height: 800 }, serviceWorkers: 'allow', acceptDownloads: true });
const A = await ctx1.newPage(); watch(A, 'A');
console.log('Десктоп, устройство A:');

await step('страница входа открывается, регистрация через форму', async () => {
  await A.goto(base);
  await A.waitForSelector('#auth:not([hidden])');
  await shot(A, '01-auth');
  await A.waitForFunction(() => document.getElementById('authTitle').textContent === 'Новый кабинет', null, { timeout: 5000 });   // самый первый запуск: сразу регистрация
  await A.fill('#login', 'tester'); await A.fill('#password', 'password-123');
  await A.click('#authBtn');
  await A.waitForSelector('#app:not([hidden])');
  await A.waitForSelector('#emptyState h3');
  assert.match(await A.textContent('#emptyState h3'), /первое древо/);
});

await step('создание образца: 5 карточек, пары в одном ряду, дети ниже', async () => {
  await A.click('#emptyState [data-e=sample]');
  await A.fill('#dlg-name', 'Род Родовых');
  await A.click('#dlg button[type=submit]');
  await A.waitForFunction(() => document.querySelectorAll('.person').length === 5);
  const pos = await A.evaluate(() => Object.fromEntries([...document.querySelectorAll('.person')].map(e => [e.querySelector('.p-name').textContent, [parseInt(e.style.left), parseInt(e.style.top)]])));
  assert.equal(pos['Пётр Родов'][1], pos['Анна Соколова'][1], 'Пётр и Анна в одном ряду');
  assert.ok(pos['Елена Родова'][1] < pos['Пётр Родов'][1] && pos['Пётр Родов'][1] < pos['Иван Родов'][1], 'дети выше родителей (жизнь растёт вверх)');
  assert.equal(await A.textContent('#treeName'), 'Род Родовых');
  assert.equal(await A.locator('#ruler .gen').count(), 3, 'три поколения в линейке');
  assert.equal(await A.locator('.person.dead').count(), 3, 'траурный уголок у троих умерших');
  await shot(A, '02-tree');
});

await step('клик по карточке открывает профиль со связями; чип ведёт к родственнику', async () => {
  await A.locator('.person', { hasText: 'Елена Родова' }).click();
  await A.waitForSelector('#drawer.open .d-name');
  assert.match(await A.textContent('#drawerBody'), /Пётр Родов[\s\S]*Анна Соколова/);
  assert.match(await A.textContent('.d-life'), /род\. 1960 · \d+ (год|года|лет)/);
  await shot(A, '03-profile');
  await A.locator('#drawerBody [data-go]', { hasText: 'Пётр Родов' }).click();
  await A.waitForFunction(() => document.querySelector('.d-name')?.textContent === 'Пётр Родов');
  assert.equal(await A.locator('.person.sel').count(), 1);
  assert.ok(await A.locator('.person.dim').count() >= 1, 'остальные карточки приглушены, линия рода подсвечена');
  assert.ok(await A.locator('#edges path.hl').count() >= 2);
});

await step('редактирование: поля, поиск связи по началу имени (чипы), сохранение', async () => {
  await A.click('[data-act=edit]');
  await A.waitForSelector('#editForm');
  await A.fill('#f-occupation', 'Инженер-мостостроитель');
  await A.fill('#f-school', 'Школа №5'); await A.fill('#f-education', 'МИИТ'); await A.fill('#f-deathPlace', 'Москва');
  await A.fill('#pk-siblings input', 'ел');
  await A.waitForSelector('#pk-siblings .pk-list button');
  assert.match(await A.textContent('#pk-siblings .pk-list'), /Елена Родова/);
  await A.keyboard.press('Enter');
  assert.match(await A.textContent('#pk-siblings .chips'), /Елена Родова/);
  await A.click('#saveBtn');   // Елена — дочь Петра: «братом» её указать нельзя
  await A.waitForFunction(() => /прямой предок или потомок/.test(document.getElementById('editErr').textContent));
  await A.click('#pk-siblings .x');  // убираем ошибочную связь
  await A.click('#saveBtn');
  await A.waitForSelector('#drawerBody .facts');
  const t = await A.textContent('#drawerBody .facts');
  assert.match(t, /Школа №5/); assert.match(t, /МИИТ/); assert.match(t, /Москва/);
  assert.match(await A.textContent('.person.sel .p-sub'), /Инженер-мостостроитель/);
});

await step('«＋ Ребёнок»: родители подставлены, новая карточка появляется и центрируется', async () => {
  await A.locator('.person', { hasText: 'Елена Родова' }).click();
  await A.waitForFunction(() => document.querySelector('.d-name')?.textContent === 'Елена Родова');
  await A.click('[data-add=child]');
  await A.waitForSelector('#editForm');
  assert.match(await A.textContent('#editForm .hint-line'), /Ребёнок для: Елена Родова/);
  await fillPersonForm(A, { '#fName': 'Иван Младший', '#f-birth': '12.05.1990' });
  await A.click('#saveBtn');
  await A.waitForFunction(() => document.querySelectorAll('.person').length === 6);
  assert.match(await A.textContent('.d-life'), /1990/);
  assert.match(await A.textContent('#drawerBody'), /Родители[\s\S]*Елена Родова/);
});

await step('«＋ Родитель» меняет и нового человека, и ребёнка одной операцией', async () => {
  await A.locator('.person', { hasText: 'Иван Младший' }).click();
  await A.click('[data-add=parent]');
  await A.fill('#fName', 'Сергей Иванов'); await A.click('#saveBtn');
  await A.waitForFunction(() => document.querySelectorAll('.person').length === 7);
  await A.locator('.person', { hasText: 'Иван Младший' }).click();
  await A.waitForFunction(() => document.querySelector('.d-name')?.textContent === 'Иван Младший');
  assert.match(await A.textContent('#drawerBody'), /Родители[\s\S]*Елена Родова[\s\S]*Сергей Иванов/);
});

await step('фото: загрузка оригинала, миниатюра на карточке, большой просмотр', async () => {
  const sharp = require('sharp');
  const png = await sharp({ create: { width: 2400, height: 1800, channels: 3, background: '#2a6' } }).png().toBuffer();
  fs.writeFileSync(path.join(dir, 'big.png'), png);
  await A.locator('.person', { hasText: 'Сергей Иванов' }).click();
  await A.click('[data-act=edit]');
  await A.setInputFiles('#photoInput', path.join(dir, 'big.png'));
  await A.waitForSelector('#photoPrev img');
  await A.click('#saveBtn');
  await A.waitForSelector('#bigPhoto');
  const src = await A.getAttribute('.person.sel .avatar', 'src').catch(() => null) || await A.locator('.person', { hasText: 'Сергей Иванов' }).locator('img.avatar').getAttribute('src');
  assert.match(src, /^\/thumb\/[\w-]+\/[\w-]+\.png\?s=s$/);
  await A.waitForFunction(() => { const i = document.querySelector('.person img.avatar'); return i && i.complete && i.naturalWidth > 0; });
  await A.click('#bigPhoto'); await A.waitForSelector('#lightbox:not([hidden])');
  await A.waitForFunction(() => { const i = document.querySelector('#lightbox img'); return i.complete && i.naturalWidth === 2400; });
  await A.click('#lightbox'); await shot(A, '04-photo');
});

await step('поиск с опечаткой и переход к человеку', async () => {
  await A.keyboard.press('Escape'); await A.waitForTimeout(100);
  await A.click('#search'); await A.fill('#search', 'Соколва');
  await A.waitForSelector('#searchResults button');
  assert.match(await A.textContent('#searchResults'), /Анна Соколова/);
  await A.keyboard.press('Enter');
  await A.waitForFunction(() => document.querySelector('.d-name')?.textContent === 'Анна Соколова');
});

console.log('Два устройства (B — тот же аккаунт в отдельном браузерном контексте):');
const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const B = await ctx2.newPage(); watch(B, 'B');
await step('B входит, видит то же древо и присутствие обоих', async () => {
  await B.goto(base); await B.fill('#login', 'tester'); await B.fill('#password', 'password-123'); await B.click('#authBtn');
  await B.waitForFunction(() => document.querySelectorAll('.person').length === 7);
  await B.waitForFunction(() => document.querySelector('#presenceText').textContent.length > 0 && document.querySelector('#presence').classList.contains('on'));
});

await step('правка на A мгновенно видна на B (WebSocket) с тостом автора', async () => {
  await pick(A, 'Анна Соколова');
  await A.click('[data-act=edit]'); await A.fill('#f-occupation', 'Врач-педиатр высшей категории'); await A.click('#saveBtn');
  await B.waitForFunction(() => [...document.querySelectorAll('.person')].some(c => c.textContent.includes('высшей категории')), null, { timeout: 5000 });
  assert.match(await B.textContent('#toasts'), /tester: Правка: Анна Соколова/);
  assert.equal(await A.locator('#toasts .toast', { hasText: 'tester:' }).count(), 0, 'своя правка не показывается как чужая');
  const rul = await B.evaluate(() => { const g = [...document.querySelectorAll('#ruler .gen')]; return { n: g.length, uniq: new Set(g.map(e => e.style.transform)).size }; });
  assert.ok(rul.n >= 3 && rul.uniq === rul.n, 'подписи поколений разнесены по рядам и после удалённого обновления: ' + JSON.stringify(rul));
});

await step('конфликт: B правит карточку, A сохраняет её раньше → B видит выбор', async () => {
  await pick(B, 'Пётр Родов');
  await B.click('[data-act=edit]'); await B.fill('#f-workplace', 'Мостоотряд (правка B)');
  await pick(A, 'Пётр Родов');
  await A.click('[data-act=edit]'); await A.fill('#f-workplace', 'Главмосстрой (правка A)'); await A.click('#saveBtn');
  await B.waitForSelector('#editNotice .notice', { timeout: 5000 });
  assert.match(await B.textContent('#editNotice'), /изменили на другом устройстве/);
  assert.equal(await B.inputValue('#f-workplace'), 'Мостоотряд (правка B)', 'введённое не потеряно');
  await shot(B, '05-conflict');
  await B.click('[data-n=reload]');
  await B.waitForFunction(() => document.querySelector('#f-workplace')?.value.includes('Главмосстрой'));
  await B.click('#cancelBtn');
});

await step('правки РАЗНЫХ карточек на двух устройствах не конфликтуют', async () => {
  await pick(B, 'Мария Родова'); await B.click('[data-act=edit]'); await B.fill('#f-occupation', 'Учитель словесности');
  await pick(A, 'Иван Родов'); await A.click('[data-act=edit]'); await A.fill('#f-occupation', 'Часовых дел мастер'); await A.click('#saveBtn');
  await B.click('#saveBtn');
  await B.waitForSelector('#drawerBody .facts');
  assert.equal(await B.locator('#editNotice .notice').count(), 0);
  await A.waitForFunction(() => [...document.querySelectorAll('.person')].some(c => c.textContent.includes('Учитель словесности')));
});

await step('история: автор и время, откат создаёт новую версию и синхронизируется', async () => {
  await A.keyboard.press('Escape');
  await A.click('#historyBtn'); await A.waitForSelector('#modalBody .h-item');
  const n = await A.locator('#modalBody .h-item').count();
  assert.ok(n >= 8, 'записей: ' + n);
  assert.match(await A.textContent('#modalBody'), /@tester/);
  await shot(A, '06-history');
  // найдём версию «до добавления Сергея Иванова» и вернёмся к ней
  const target = A.locator('#modalBody .h-item', { hasText: 'Добавлен: Иван Младший' });
  await target.locator('[data-r]').click();
  await A.waitForSelector('#dlg');
  await A.click('#dlg button[type=submit]');
  await A.waitForFunction(() => document.querySelectorAll('.person').length === 6, null, { timeout: 5000 });
  await B.waitForFunction(() => document.querySelectorAll('.person').length === 6, null, { timeout: 5000 });
  await A.click('#historyBtn'); await A.waitForSelector('#modalBody .h-item');
  assert.match(await A.textContent('#modalBody .h-item'), /Восстановление версии/);
  await A.keyboard.press('Escape');
});

await step('статистика и тёмная тема', async () => {
  await A.click('#statsBtn'); await A.waitForSelector('.stat-grid');
  assert.match(await A.textContent('.stat-grid'), /6\s*участников/);
  await A.keyboard.press('Escape');
  await A.click('#moreBtn'); await A.click('[data-m=theme]');
  assert.equal(await A.evaluate(() => document.documentElement.dataset.theme), 'dark');
  await shot(A, '07-dark');
  await A.click('#moreBtn'); await A.click('[data-m=theme]');
});

await step('кнопка «＋» добавляет человека, а «Удалить» его убирает', async () => {
  if (await A.locator('#drawer.open').count()) { await A.evaluate(() => document.getElementById('closeDrawer').click()); await A.waitForTimeout(400); }
  const before = await cards(A).count();
  await A.click('#addPerson');
  await A.waitForSelector('#editForm');
  assert.match(await A.textContent('#drawerBody h2'), /Новый участник/);
  await A.fill('#fName', 'Тест Кнопки'); await A.click('#saveBtn');
  await A.waitForFunction(n => document.querySelectorAll('.person').length === n + 1, before);
  await A.waitForFunction(() => document.querySelector('.d-name')?.textContent === 'Тест Кнопки');
  await A.click('[data-act=edit]'); await A.click('#delBtn');
  await A.waitForSelector('#dlg'); await A.click('#dlg button[type=submit]');
  await A.waitForFunction(n => document.querySelectorAll('.person').length === n, before);
});

console.log('Новые возможности:');
const tops = p => p.evaluate(() => Object.fromEntries([...document.querySelectorAll('.person')].map(e => [e.querySelector('.p-name').textContent, parseInt(e.style.top)])));
const menu = async (p, k) => { await p.click('#moreBtn'); await p.click(`[data-m=${k}]`); await p.waitForTimeout(150); };

await step('девичья фамилия: поле, карточка, профиль, поиск', async () => {
  await pick(A, 'Анна Соколова'); await A.click('[data-act=edit]'); await A.fill('#fMaiden', 'Иванова'); await A.click('#saveBtn');
  await A.waitForFunction(() => document.querySelector('.d-maiden')?.textContent === 'урожд. Иванова');
  assert.match(await A.locator('.person', { hasText: 'Анна Соколова' }).textContent(), /урожд\. Иванова/);
  await A.evaluate(() => document.getElementById('closeDrawer').click()); await A.waitForTimeout(400);
  await A.fill('#search', 'Иванова'); await A.waitForSelector('#searchResults button');
  assert.match(await A.textContent('#searchResults'), /Анна Соколова \(урожд\. Иванова\)/);
  await A.keyboard.press('Escape');
});

await step('годовщина свадьбы: дата у одного видна у обоих, годы вместе, год на линии брака', async () => {
  await pick(A, 'Пётр Родов'); await A.click('[data-act=edit]');
  await A.waitForSelector('#marriageRows [data-wed]');
  assert.match(await A.textContent('#marriageRows'), /Дата свадьбы с Анна Соколова/);
  await A.fill('#marriageRows [data-wed]', '14.06.1958'); await A.click('#saveBtn');
  await A.waitForFunction(() => /Свадьба с Анна Соколова:14\.06\.1958/.test(document.querySelector('#drawerBody .facts + .chips, #drawerBody')?.textContent || ''));
  assert.match(await A.textContent('#drawerBody'), /53 года в браке/, 'Пётр умер в 2011 — считаем до его смерти');
  await pick(A, 'Анна Соколова');
  assert.match(await A.textContent('#drawerBody'), /Свадьба с Пётр Родов:14\.06\.1958/);
  assert.equal((await A.locator('#edges text.my').allTextContents()).join(','), '1958');
  await shot(A, '13-wedding');
});

await step('защита от дублей: предупреждение при создании тёзки', async () => {
  await A.evaluate(() => document.getElementById('closeDrawer').click()); await A.waitForTimeout(400);
  const before = await cards(A).count();
  await A.click('#addPerson'); await A.fill('#fName', 'Анна Соколова'); await A.fill('#f-birth', '1933'); await A.click('#saveBtn');
  await A.waitForSelector('#dlg');
  assert.match(await A.textContent('#modalTitle'), /Такой человек уже есть/); assert.match(await A.textContent('#modalBody'), /Анна Соколова/);
  await A.click('#dlgNo');
  assert.equal(await cards(A).count(), before, 'после отмены дубль не создан');
  await A.click('#cancelBtn');
});

await step('выбор связи не создаёт дублей даже при двойном срабатывании', async () => {
  await pick(A, 'Иван Младший'); await A.click('[data-act=edit]');
  await A.fill('#pk-parents input', 'пё'); await A.waitForSelector('#pk-parents .pk-list button');
  await A.evaluate(() => { const b = document.querySelector('#pk-parents .pk-list button'); b.click(); b.click(); });
  assert.equal(await A.locator('#pk-parents .chip').count(), 2, 'Елена + Пётр — по одному разу');
  await A.click('#cancelBtn');
});

await step('объединение дублей: дети переходят к основной карточке, лишний родитель исчезает', async () => {
  await pick(A, 'Елена Родова'); await A.click('[data-add=parent]');
  await A.fill('#fName', 'Анна Соколова'); await A.fill('#f-occupation', 'Дубль'); await A.click('#saveBtn');
  await A.waitForSelector('#dlg'); await A.click('#dlg button[type=submit]');   // «Всё равно создать»
  await A.waitForFunction(() => document.querySelectorAll('.person').length === 7);
  await pick(A, 'урожд. Иванова');
  await A.click('[data-act=merge]'); await A.waitForSelector('#mgList .h-item');
  await A.locator('#mgList .h-item', { hasText: 'Дубль' }).locator('button').click();
  await A.waitForSelector('#dlg'); await A.click('#dlg button[type=submit]');
  await A.waitForFunction(() => document.querySelectorAll('.person').length === 6);
  await pick(A, 'Елена Родова');
  const parents = await A.locator('#drawerBody .chips').first().locator('.chip').allTextContents();
  assert.equal(parents.length, 2, 'у Елены снова два родителя: ' + parents.join('|'));
});

await step('направление и «шкала по годам»', async () => {
  await A.evaluate(() => document.getElementById('closeDrawer').click()); await A.waitForTimeout(400);
  let t = await tops(A);
  assert.ok(t['Иван Родов'] > t['Пётр Родов'] && t['Пётр Родов'] > t['Елена Родова'], 'по умолчанию потомки сверху');
  await menu(A, 'dir'); t = await tops(A);
  assert.ok(t['Иван Родов'] < t['Пётр Родов'] && t['Пётр Родов'] < t['Елена Родова'], 'переключено: потомки снизу');
  await menu(A, 'dir');
  await menu(A, 'time'); await A.waitForTimeout(200); t = await tops(A);
  assert.equal(t['Иван Родов'] - t['Елена Родова'], (1960 - 1902) * 8, 'вертикальное расстояние = разнице лет × масштаб (58 лет)');
  assert.ok(t['Иван Родов'] - t['Пётр Родов'] === (1930 - 1902) * 8);
  assert.ok((await A.locator('#ruler .gen').allTextContents()).includes('1950'), 'на линейке годы');
  assert.ok(await A.locator('#edges line.tk').count() >= 5, 'линии десятилетий');
  await shot(A, '14-timeline');
  await menu(A, 'time');
  assert.equal(await A.locator('#edges line.tk').count(), 0);
});

await step('фото в «чужом» формате (GIF/HEIC/AVIF…) преобразуется в JPEG', async () => {
  fs.writeFileSync(path.join(dir, 'x.gif'), Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'));
  await pick(A, 'Иван Младший'); await A.click('[data-act=edit]');
  await A.setInputFiles('#photoInput', path.join(dir, 'x.gif'));
  await A.waitForSelector('#photoPrev img');
  assert.match(await A.textContent('#toasts'), /преобразован в JPEG/);
  await A.click('#saveBtn'); await A.waitForSelector('#bigPhoto');
  const url = await A.evaluate(() => document.querySelector('.person.sel img.avatar')?.getAttribute('src') || '');
  assert.match(url, /\.jpg\?s=s$/);
});

await step('установка приложения: пункт меню появляется по событию браузера (и меню доступно при открытой карточке)', async () => {
  await pick(A, 'Елена Родова'); await A.waitForSelector('#drawer.open');
  await A.evaluate(() => window.dispatchEvent(new Event('beforeinstallprompt')));
  await A.click('#moreBtn');
  assert.equal(await A.locator('[data-m=install]').count(), 1);
  await A.keyboard.press('Escape'); await A.click('#treeName');
});

await step('подсветка: по фамилии (с девичьей), одна семья, плашка и снятие', async () => {
  await A.evaluate(() => document.getElementById('closeDrawer').click()); await A.waitForTimeout(350);
  await A.evaluate(() => document.getElementById('fit').click()); await A.waitForTimeout(150);
  const total = await cards(A).count();
  await menu(A, 'hl'); await A.waitForSelector('#hlForm');
  const opts = await A.locator('#hlKey option').allTextContents();
  assert.ok(opts.some(o => o.startsWith('Родов')), 'в списке есть фамилия Родов: ' + opts.join('|'));
  await A.selectOption('#hlKey', { label: opts.find(o => o.startsWith('Родов')) });
  await A.click('#hlForm button[type=submit]');
  await A.waitForSelector('#hlBar:not([hidden])');
  const dimmed = await A.locator('.person.dim').count(), lit = total - dimmed;
  assert.ok(lit >= 3 && dimmed >= 1, `подсвечены Родовы, остальные приглушены: ${lit}/${total}`);
  assert.ok(await A.locator('#edges .e.hl').count() > 0, 'линии между подсвеченными выделены');
  assert.ok(await A.locator('#edges .e.dim').count() > 0, 'остальные линии приглушены');
  // наведение мыши не сбивает постоянную подсветку
  await A.locator('.person:not(.dim)').first().hover(); await A.waitForTimeout(120);
  assert.equal(await A.locator('.person.dim').count(), dimmed, 'наведение не меняет подсветку');
  await shot(A, '22-highlight-surname');
  // снимается крестиком
  await A.click('#hlClear'); await A.waitForTimeout(120);
  assert.equal(await A.locator('.person.dim').count(), 0); assert.equal(await A.locator('#hlBar:not([hidden])').count(), 0);
  // одна семья из профиля: человек + супруг + дети
  await pick(A, 'Пётр Родов'); await A.click('[data-act=hlfam]'); await A.waitForSelector('#hlForm');
  assert.equal(await A.locator('#hlPerson').inputValue() !== '', true);
  await A.click('#hlForm button[type=submit]'); await A.waitForSelector('#hlBar:not([hidden])');
  const lab = await A.locator('#hlLabel').textContent(); assert.ok(/Семья: Пётр Родов/.test(lab), lab);
  assert.ok(await A.locator('.person.dim').count() >= 1 && await A.locator('.person:not(.dim)').count() >= 2, 'подсвечена только семья Петра');
  // сохраняется при правке и пересчёте раскладки, снимается через меню
  await menu(A, 'dir'); await menu(A, 'dir');
  assert.equal(await A.locator('#hlBar:not([hidden])').count(), 1, 'подсветка пережила перестройку раскладки');
  await menu(A, 'hloff'); assert.equal(await A.locator('.person.dim').count(), 0);
});

await step('полная копия из меню: диалог с предупреждением, скачивается ZIP с базой и фото', async () => {
  await A.evaluate(() => document.getElementById('closeDrawer').click()); await A.waitForTimeout(300);
  await A.click('#moreBtn');
  assert.equal(await A.locator('[data-m=backup]').count(), 1, 'владелец сервера видит пункт');
  await A.click('[data-m=backup]'); await A.waitForSelector('#dlg');
  assert.match(await A.locator('#modalBody').textContent(), /аккаунты|аккаунтов/, 'предупреждение о содержимом');
  await shot(A, '26-full-backup-dialog');
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('#dlg button[type=submit]')]);
  assert.match(dl.suggestedFilename(), /^rod-backup-\d{8}-\d{6}\.zip$/);
  const f = path.join(dir, 'ui-backup.zip'); await dl.saveAs(f);
  const z = readZip(fs.readFileSync(f)), man = JSON.parse(z.get('manifest.json')().toString());
  assert.equal(man.format, 'rod-backup'); assert.ok(man.people >= 1 && man.trees >= 1 && z.get('rod.db'), JSON.stringify(man));
  assert.ok([...z].some(([n]) => n.startsWith('media/')), 'фото попали в копию');
});

await step('приглашение по ссылке: родственник «из другого дома» регистрируется и сразу попадает в древо', async () => {
  await A.evaluate(() => document.getElementById('closeDrawer').click()); await A.waitForTimeout(300);
  const treeName = (await A.locator('#treeName').textContent()).trim();
  await A.click('#linkInviteBtn'); await A.waitForSelector('#invForm');
  await A.fill('#invBase', base); assert.ok(await A.locator('#invWarn').isVisible(), 'для домашнего адреса есть предупреждение');
  await A.fill('#invNote', 'тётя Лена'); await A.click('#invForm button[type=submit]'); await A.waitForSelector('#invResult:not([hidden])');
  const link = await A.inputValue('#invLink'); assert.match(link, /\/\?invite=[\w-]{30,}$/);
  assert.match(await A.locator('#invList').textContent(), /тётя Лена/);
  await shot(A, '27-invite-dialog');
  await A.click('#invClose'); await A.waitForSelector('#modal', { state: 'hidden' });
  // родственник: чистый браузер без cookies
  const ctxR = await browser.newContext({ viewport: { width: 1280, height: 800 } }), R = await ctxR.newPage(); watch(R, 'R');
  await R.goto(link); await R.waitForSelector('#inviteBanner:not([hidden])');
  assert.match(await R.locator('#inviteBanner').textContent(), /приглашает вас в древо/);
  assert.ok(!R.url().includes('invite'), 'токен убран из адресной строки');
  assert.equal(await R.locator('#authTitle').textContent(), 'Новый кабинет');
  await shot(R, '28-invite-register');
  await R.fill('#login', 'tyotya_' + Date.now().toString(36)); await R.fill('#password', 'password-lena-1'); await R.click('#authBtn');
  await R.waitForSelector('#app:not([hidden])'); await R.waitForFunction(() => document.querySelectorAll('.person').length > 0);
  assert.equal((await R.locator('#treeName').textContent()).trim(), treeName, 'сразу открыто приглашавшее древо');
  assert.equal(await R.locator('#linkInviteBtn').isHidden(), true, 'приглашать дальше может только владелец');
  // ссылка одноразовая; без ссылки регистрации нет
  const ctxX = await browser.newContext({ viewport: { width: 1280, height: 800 } }), X = await ctxX.newPage(); watch(X, 'X');
  await X.goto(link); await X.waitForSelector('#authErr:not(:empty)');
  assert.match(await X.locator('#authErr').textContent(), /недействительна|использована/); assert.equal(await X.locator('#inviteBanner').isHidden(), true);
  await X.goto(base); await X.waitForSelector('#regHint:not([hidden])');
  assert.equal(await X.locator('#switchAuth').isHidden(), true, 'без приглашения кнопки «Создать аккаунт» нет');
  await ctxR.close(); await ctxX.close();
});

await step('контакты: телефон, e-mail, адрес сохраняются, показываются ссылками, ищутся; неверный e-mail не сохраняется', async () => {
  await A.evaluate(() => document.getElementById('closeDrawer').click()); await A.waitForTimeout(300);
  await pick(A, 'Елена Родова'); await A.click('[data-act=edit]');
  await A.fill('#f-phone', '+380 50 123-45-67'); await A.fill('#f-email', 'elena@example.com'); await A.fill('#f-address', 'Киев, ул. Лесная, 5, кв. 12');
  await shot(A, '29-contacts-form');
  await A.click('#saveBtn'); await A.waitForSelector('#drawerBody a[href^="tel:"]');
  assert.equal(await A.getAttribute('#drawerBody a[href^="tel:"]', 'href'), 'tel:+380501234567', 'ссылка для звонка без пробелов и дефисов');
  assert.equal(await A.getAttribute('#drawerBody a[href^="mailto:"]', 'href'), 'mailto:elena@example.com');
  assert.match(await A.locator('#drawerBody').textContent(), /Лесная, 5, кв\. 12/);
  await shot(A, '30-contacts-view');
  // поиск по номеру и по e-mail находит эту карточку
  await A.fill('#search', '501234567'); await A.waitForSelector('#searchResults:not([hidden]) >> text=Елена');
  await A.fill('#search', 'elena@exa'); await A.waitForSelector('#searchResults:not([hidden]) >> text=Елена'); await A.fill('#search', '');
  // неверный e-mail: сохранение не проходит, введённое не теряется
  await A.click('[data-act=edit]'); await A.fill('#f-email', 'не-адрес'); await A.click('#saveBtn');
  assert.equal(await A.locator('#f-email').evaluate(e => e.validity.valid), false, 'браузер подсвечивает неверный e-mail');
  assert.equal(await A.inputValue('#f-email'), 'не-адрес'); assert.equal(await A.locator('#drawerBody a[href^="mailto:"]').count(), 0, 'форма осталась открытой');
  await A.fill('#f-email', 'elena@example.com'); await A.click('#saveBtn'); await A.waitForSelector('#drawerBody a[href^="mailto:"]');
  // второе устройство получает контакты по синхронизации
  const people = await B.evaluate(async () => { const t = (await (await fetch('/api/me')).json()).trees[0]; const d = await (await fetch('/api/trees/' + t.id)).json(); return Object.values(d.people || {}); });
  assert.ok(people.some(p => p.name === 'Елена Родова' && p.phone === '+380 50 123-45-67' && p.email === 'elena@example.com'), 'контакты на сервере');
});

await step('документы: PDF и фото загружаются, подписываются, открываются, ищутся и удаляются', async () => {
  await A.evaluate(() => document.getElementById('closeDrawer').click()); await A.waitForTimeout(300);
  await pick(A, 'Елена Родова'); await A.click('[data-act=edit]');
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  // неподходящий файл отклоняется понятным сообщением и не попадает в карточку
  await A.setInputFiles('#docInput', { name: 'заметки.txt', mimeType: 'text/plain', buffer: Buffer.from('просто текст') });
  await A.waitForSelector('.toast.err, .toast:has-text("нужен PDF или фото")'); assert.equal(await A.locator('.doc-edit').count(), 0);
  await A.setInputFiles('#docInput', [{ name: 'Свидетельство о смерти Петра.pdf', mimeType: 'application/pdf', buffer: pdf }, { name: 'диплом.png', mimeType: 'image/png', buffer: png }]);
  await A.waitForFunction(() => document.querySelectorAll('.doc-edit').length === 2, null, { timeout: 15000 });
  assert.equal(await A.locator('.doc-edit select[data-f=kind]').first().inputValue(), 'Свидетельство о смерти', 'вид угадан по названию файла');
  assert.equal(await A.locator('.doc-edit select[data-f=kind]').nth(1).inputValue(), 'Диплом / аттестат');
  await A.locator('.doc-edit input[data-f=title]').first().fill('Метрика Петра Родова');
  await shot(A, '31-docs-form');
  await A.click('#saveBtn'); await A.waitForSelector('#drawerBody .doc-row');
  assert.equal(await A.locator('#drawerBody .doc-row').count(), 2);
  assert.match(await A.locator('#drawerBody .doc-row').first().textContent(), /Метрика Петра Родова/);
  assert.equal(await A.locator('#drawerBody .doc-row img.doc-thumb').count(), 1, 'у фото — миниатюра, у PDF — значок');
  await shot(A, '32-docs-view');
  // файл реально открывается по ссылке «Открыть» и это PDF
  const href = await A.getAttribute('#drawerBody .doc-row a[target=_blank]', 'href');
  const got = await A.evaluate(async h => { const r = await fetch(h); return { s: r.status, t: r.headers.get('content-type'), n: (await r.arrayBuffer()).byteLength }; }, href);
  assert.deepEqual([got.s, got.t, got.n], [200, 'application/pdf', pdf.length]);
  assert.equal(await A.getAttribute('#drawerBody .doc-row a[download]', 'download'), 'Свидетельство о смерти Петра.pdf', 'скачивается под исходным именем');
  // поиск по названию документа
  await A.fill('#search', 'метрика петр'); await A.waitForSelector('#searchResults:not([hidden]) >> text=Елена'); await A.fill('#search', '');
  // удаление одного документа
  await A.click('[data-act=edit]'); await A.click('[data-rm="0"]'); assert.equal(await A.locator('.doc-edit').count(), 1);
  await A.click('#saveBtn'); await A.waitForFunction(() => document.querySelectorAll('#drawerBody .doc-row').length === 1);
  // второе устройство видит документы после синхронизации
  const docs = await B.evaluate(async () => { const t = (await (await fetch('/api/me')).json()).trees[0]; const d = await (await fetch('/api/trees/' + t.id)).json(); return Object.values(d.people).find(p => p.name === 'Елена Родова').docs; });
  assert.equal(docs.length, 1); assert.equal(docs[0].kind, 'Диплом / аттестат');
});

await step('PWA устанавливаема: Chrome не находит ошибок манифеста и установки', async () => {
  const cdp = await ctx1.newCDPSession(A);
  await A.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 10000 });
  const r = await cdp.send('Page.getInstallabilityErrors');
  assert.deepEqual(r.installabilityErrors, [], JSON.stringify(r.installabilityErrors));
  const m = await cdp.send('Page.getAppManifest'); assert.deepEqual(m.errors, []);
  const man = JSON.parse(m.data);
  assert.ok(man.icons.some(i => i.purpose === 'maskable'));
  assert.ok(man.screenshots?.some(x => x.form_factor === 'narrow') && man.screenshots?.some(x => x.form_factor === 'wide'), 'скриншоты для окна установки');
  for (const r of [...man.icons, ...man.screenshots]) {                                    // каждый ресурс манифеста реально отдаётся и нужного типа
    const resp = await fetch(new URL(r.src, base)); assert.equal(resp.status, 200, r.src);
    assert.equal(resp.headers.get('content-type'), r.type, r.src);
  }
});

await step('экспорт: скачивается валидный архив с Obsidian, фото и tree.html', async () => {
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('#exportBtn')]);
  const f = path.join(dir, 'dl.zip'); await dl.saveAs(f);
  const z = readZip(fs.readFileSync(f)), names = [...z.keys()];
  assert.ok(names.some(n => n.startsWith('Obsidian/People/')) && names.includes('tree.html') && names.includes('tree.json'));
  assert.equal(names.filter(n => n.startsWith('Obsidian/People/')).length, 6);
  assert.match(dl.suggestedFilename(), /^rod-.*\.zip$/);
});

await step('импорт этого архива через интерфейс создаёт копию древа', async () => {
  await A.setInputFiles('#importInput', path.join(dir, 'dl.zip'));
  await A.waitForFunction(() => document.querySelectorAll('#treeList .tree-item').length === 2, null, { timeout: 8000 });
  await A.waitForFunction(() => document.querySelectorAll('.person').length === 6);
});

await step('SVG-плакат скачивается и валиден', async () => {
  await A.click('#moreBtn');
  const [dl] = await Promise.all([A.waitForEvent('download'), A.click('[data-m=poster]')]);
  const f = path.join(dir, 'poster.svg'); await dl.saveAs(f);
  const svg = fs.readFileSync(f, 'utf8');
  assert.ok(svg.startsWith('<svg') && svg.includes('Анна Соколова'));
});

console.log('Большое древо и производительность:');
await step('600 человек: отсекаются невидимые карточки, панорамирование плавное', async () => {
  const cookie = (await ctx1.cookies()).find(c => c.name === 'rod');
  const H = { 'x-rod': '1', 'content-type': 'application/json', cookie: `rod=${cookie.value}` };
  const tid = (await (await fetch(base + '/api/trees', { method: 'POST', headers: H, body: JSON.stringify({ name: 'Большое' }) })).json()).id;
  const ids = Array.from({ length: 600 }, () => crypto.randomUUID()), ops = [];
  ids.forEach((id, i) => ops.push({ op: 'put', base: 0, person: { id, name: 'Человек ' + i, sex: i % 2 ? 'f' : 'm', birth: String(1800 + (i % 200)), parents: i < 2 ? [] : [ids[(i >> 1) - 1 < 0 ? 0 : (i >> 1) - 1]] } }));
  for (let i = 0; i < ops.length; i += 300) {
    const r = await fetch(`${base}/api/trees/${tid}/save`, { method: 'POST', headers: H, body: JSON.stringify({ ops: ops.slice(i, i + 300), note: 'масса' }) });
    assert.equal(r.status, 200, await r.text());
  }
  await A.reload(); await A.waitForSelector('#treeList .tree-item');
  await A.locator('.tree-item', { hasText: 'Большое' }).click();
  await A.waitForFunction(() => document.querySelector('#treeName').textContent === 'Большое');
  await A.waitForTimeout(300);
  const total = 600, rendered = await cards(A).count();
  assert.ok(rendered > 0 && rendered < total, `в DOM ${rendered} из ${total} карточек`);
  const fps = await A.evaluate(async () => {
    const vp = document.getElementById('viewport'); let frames = 0, t0 = performance.now();
    const r = vp.getBoundingClientRect();
    const fire = (type, x, y) => vp.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true, isPrimary: true }));
    fire('pointerdown', r.left + 400, r.top + 300);
    await new Promise(res => { let i = 0; const tick = () => { fire('pointermove', r.left + 400 - i * 6, r.top + 300 - i * 2); frames++; if (++i < 120) requestAnimationFrame(tick); else res(); }; tick(); });
    fire('pointerup', 0, 0);
    return frames / ((performance.now() - t0) / 1000);
  });
  console.log(`      ${rendered} из ${total} карточек в DOM, ~${fps | 0} кадров/с при панораме`);
  assert.ok(fps > 20, 'FPS ' + fps);
  await shot(A, '08-big');
});

console.log('Мобильное устройство (390×844, касания):');
const ctx3 = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, serviceWorkers: 'allow' });
const M = await ctx3.newPage(); watch(M, 'M');
await step('вход, дерево помещается без горизонтальной прокрутки, боковая панель и поиск', async () => {
  await M.goto(base); await M.fill('#login', 'tester'); await M.fill('#password', 'password-123'); await M.click('#authBtn');
  await M.waitForSelector('#treeList .tree-item', { state: 'attached' });
  await M.evaluate(() => [...document.querySelectorAll('#treeList .tree-item')].find(b => b.textContent.includes('Род Родовых')).click());
  await M.waitForFunction(() => document.querySelectorAll('.person').length === 6);
  const overflow = await M.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false);
  await shot(M, '09-mobile-tree');
  await M.click('#menuBtn'); await M.waitForSelector('#side.open'); await shot(M, '10-mobile-side'); await M.click('#sideScrim', { position: { x: 370, y: 400 } });
  await M.click('#searchBtn'); await M.fill('#search', 'ел'); await M.waitForSelector('#searchResults button');
  await M.keyboard.press('Enter');
  await M.waitForSelector('#drawer.open .d-name');
  const box = await M.locator('#drawer').boundingBox();
  assert.ok(box.width >= 388 && box.y > 50, 'карточка — нижний лист');
  await shot(M, '11-mobile-sheet');
});
await step('касание карточки открывает профиль; жест перетаскивания не открывает', async () => {
  await M.keyboard.press('Escape'); await M.evaluate(() => document.getElementById('closeDrawer').click());
  await M.waitForTimeout(400);
  const pt = await M.evaluate(() => { const vh = innerHeight; for (const e of document.querySelectorAll('.person')) { const r = e.getBoundingClientRect(); if (r.top > 90 && r.bottom < vh - 60 && r.left > 0 && r.right < innerWidth) return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; } return null; });
  assert.ok(pt, 'на экране есть видимая карточка');
  await M.touchscreen.tap(pt.x, pt.y);
  await M.waitForSelector('#drawer.open');
});

console.log('Офлайн (PWA):');
await step('сервис-воркер установлен; без сети открывается копия только для просмотра', async () => {
  await M.evaluate(() => document.getElementById('closeDrawer').click());
  await M.waitForFunction(async () => (await navigator.serviceWorker.getRegistration())?.active, null, { timeout: 8000 });
  await M.waitForTimeout(1200); // кэширование копии древа (debounce)
  await M.reload(); await M.waitForSelector('.person');
  await ctx3.setOffline(true);
  await M.reload({ waitUntil: 'domcontentloaded' });
  await M.waitForSelector('#banner:not([hidden])', { timeout: 8000 });
  assert.match(await M.textContent('#banner'), /только просмотр/);
  assert.ok(await M.locator('.person').count() > 0, 'карточки видны офлайн');
  assert.equal(await M.locator('#addPerson').isHidden(), true, 'правка недоступна');
  await shot(M, '12-offline');
  await ctx3.setOffline(false);
});

await browser.close(); await app.close(); fs.rmSync(dir, { recursive: true, force: true });
const failed = results.filter(r => r[0] === 'fail');
console.log(`\nИтого: ${results.length - failed.length}/${results.length} шагов OK`);
if (problems.length) { console.log('Ошибки страницы/консоли:'); [...new Set(problems)].forEach(p => console.log('  - ' + p)); }
process.exit(failed.length || problems.length ? 1 : 0);
