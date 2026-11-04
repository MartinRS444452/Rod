import fs from 'node:fs';

const patch = (file, search, replace, desc) => {
  if (!fs.existsSync(file)) return console.log(`❌ ${file} не найден`);
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(search)) {
    fs.copyFileSync(file, file + '.bak');
    fs.writeFileSync(file, s.replace(search, replace));
    console.log(`✅ ${desc} — применено`);
  } else {
    console.log(`⚠️ ${desc} — НЕ НАЙДЕНО (пропущено)`);
  }
};

// 1. УВЕЛИЧИВАЕМ КАРТОЧКИ И ДОБАВЛЯЕМ СТИЛИ ТЕМ
if (fs.existsSync('public/app.css')) {
  fs.appendFileSync('public/app.css', `
/* --- ФИКС: Ширина карточек и Темы --- */
.person { width: 230px !important; } /* Увеличиваем ширину */
.p-name { font-size: 15px !important; line-height: 1.2 !important; white-space: normal !important; word-break: break-word; }
.p-top { padding: 8px !important; }
.m.divorced { stroke-dasharray: 6, 6 !important; stroke: #B8665C !important; }
[data-theme="sepia"] { --bg:#F4ECD8; --ink:#5B4636; --line:#D1C5B4; --card:#FDF8F0; --mut:#8E8378; --gold:#B38A3C; }
[data-theme="forest"] { --bg:#1A2F1A; --ink:#E6EDE9; --line:#2E4A2E; --card:#223B22; --mut:#8EA39B; --gold:#D2A857; }
[data-theme="ocean"] { --bg:#0B1B2B; --ink:#E6EDE9; --line:#1A365D; --card:#13293D; --mut:#8EA39B; --gold:#D2A857; }
`);
  console.log('✅ CSS: карточки расширены, темы добавлены');
}

// 2. ВНЕДРЯЕМ ЛОГИКУ ТЕМ И РАЗВОДОВ В APP.JS
let appJs = fs.readFileSync('public/js/app.js', 'utf8');

// 2.1. Заменяем функцию applyTheme на поддержку 5 тем
const oldApply = `function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#0F1A18' : '#0E2B28';
}`;
const newApply = `function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  const colors = { dark: '#0F1A18', light: '#0E2B28', sepia: '#F4ECD8', forest: '#1A2F1A', ocean: '#0B1B2B' };
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = colors[t] || '#0E2B28';
  const vp = document.getElementById('viewport');
  if (vp) { const bg = localStorage.getItem('rod:bg'); vp.style.backgroundImage = bg ? \`url(\${bg})\` : ''; }
}`;
if (appJs.includes(oldApply)) {
  appJs = appJs.replace(oldApply, newApply);
  console.log('✅ APP.JS: функция applyTheme обновлена (5 тем + фон)');
} else {
  console.log('⚠️ APP.JS: не найдена старая applyTheme');
}

// 2.2. Учим кнопку переключать темы по кругу
// Ищем место, где обрабатывается клик по теме
const themeClickRegex = /if\s*\(a\s*===\s*'theme'\)\s*\{[\s\S]*?\}/;
if (themeClickRegex.test(appJs)) {
  appJs = appJs.replace(themeClickRegex, `if (a === 'theme') {
    const themes = ['light', 'dark', 'sepia', 'forest', 'ocean'];
    const cur = store.get('rod:theme') || 'light';
    const next = themes[(themes.indexOf(cur) + 1) % themes.length];
    store.set('rod:theme', next);
    applyTheme(next);
    toast('Тема: ' + next);
  }`);
  console.log('✅ APP.JS: кнопка смены темы теперь переключает 5 вариантов');
} else {
  // Если regex не сработал, попробуем найти просто вызов applyTheme
  const fallbackRegex = /applyTheme\((?:[^)]+)\);\s*store\.set\('rod:theme',\s*[^)]+\);/;
  if (fallbackRegex.test(appJs)) {
      appJs = appJs.replace(fallbackRegex, `const themes = ['light', 'dark', 'sepia', 'forest', 'ocean']; const cur = store.get('rod:theme')||'light'; const next = themes[(themes.indexOf(cur)+1)%themes.length]; store.set('rod:theme', next); applyTheme(next); toast('Тема: '+next);`);
      console.log('✅ APP.JS: переключение тем исправлено (fallback)');
  } else {
      console.log('⚠️ APP.JS: не найдено место клика по теме');
  }
}

// 2.3. Добавляем галочку "Развод" в карточку редактирования
// Ищем генерацию поля data-wed
const wedInputRegex = /(<input[^>]*?data-wed="([^"]+)"[^>]*?>)/g;
let hasWed = false;
appJs = appJs.replace(wedInputRegex, (match, input, withId) => {
  hasWed = true;
  return `${input}<label style="font-size:12px;margin-left:8px;display:inline-flex;align-items:center;gap:4px"><input type="checkbox" class="divorced-cb" data-for="${withId}"> Развод</label>`;
});
if (hasWed) console.log('✅ APP.JS: добавлен чекбокс «Развод» в карточку');
else console.log('⚠️ APP.JS: не найдено поле даты свадьбы для чекбокса');

// 2.4. Сохраняем статус развода при сохранении карточки
const saveWedRegex = /(marriages:\s*\[[\s\S]*?\])/;
if (saveWedRegex.test(appJs)) {
  appJs = appJs.replace(saveWedRegex, `marriages: [...document.querySelectorAll('[data-wed]')].map(inp => {
    const withId = inp.getAttribute('data-wed');
    const cb = document.querySelector(\`.divorced-cb[data-for="\${withId}"]\`);
    return { with: withId, date: inp.value, divorced: cb ? cb.checked : false };
  })`);
  console.log('✅ APP.JS: сохранение статуса развода добавлено');
}

// 2.5. Рисуем пунктирную линию на дереве
const svgLine = `L.spouseLinks.map(l => \`<g class="lk" data-a="\${esc(l.a)}" data-b="\${esc(l.b)}"><path class="m" d="\${l.d}"/>\${l.mx !== null ? \`<circle class="u" cx="\${l.mx}" cy="\${l.y}" r="4"/>\${wedYear(l) ? \`<text class="my" x="\${l.mx}" y="\${l.y - 8}" text-anchor="middle">\${wedYear(l)}</text>\` : ''}\` : ''}</g>\`).join('')`;
const svgLineNew = `L.spouseLinks.map(l => {
    const mar = P[l.a]?.marriages?.find(m => m.with === l.b);
    const isDiv = mar?.divorced;
    return \`<g class="lk" data-a="\${esc(l.a)}" data-b="\${esc(l.b)}"><path class="m \${isDiv ? 'divorced' : ''}" d="\${l.d}"/>\${l.mx !== null ? \`<circle class="u" cx="\${l.mx}" cy="\${l.y}" r="4"/>\${wedYear(l) ? \`<text class="my" x="\${l.mx}" y="\${l.y - 8}" text-anchor="middle">\${wedYear(l)}</text>\` : ''}\` : ''}</g>\`;
  }).join('')`;

if (appJs.includes(svgLine)) {
  appJs = appJs.replace(svgLine, svgLineNew);
  console.log('✅ APP.JS: пунктирная линия для развода внедрена в SVG');
} else {
  console.log('⚠️ APP.JS: не найдена строка генерации spouseLinks (возможно, отличается кавычками)');
}

fs.writeFileSync('public/js/app.js', appJs);
console.log('\\n🏁 Готово!');
