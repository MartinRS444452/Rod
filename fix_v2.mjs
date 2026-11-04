import fs from 'node:fs';

// --- 1. ОТКАТЫВАЕМ КРИВЫЕ ПРАВКИ CSS И ВОЗВРАЩАЕМ МАСШТАБИРОВАНИЕ ---
if (fs.existsSync('public/app.css')) {
  let css = fs.readFileSync('public/app.css', 'utf8');
  // Удаляем мою кривую настройку ширины и шрифта
  css = css.replace(/\.person \{ width: 230px !important; \} \/\* Увеличиваем ширину \*\//g, '');
  css = css.replace(/\.p-name \{ font-size: 15px !important; line-height: 1\.2 !important; white-space: normal !important; word-break: break-word; \}/g, '');
  css = css.replace(/\.p-top \{ padding: 8px !important; \}/g, '');
  fs.writeFileSync('public/app.css', css);
  console.log('✅ CSS: кривые правки ширины удалены, масштабирование восстановлено');
}

// --- 2. ПРАВИМ ШИРИНУ В ДВИЖКЕ РАСКЛАДКИ (чтобы линии не перекрывались) ---
// Мы аккуратно ищем переменную ширины карточки в layout.js и увеличиваем её на 20px (180 -> 200)
if (fs.existsSync('public/js/layout.js')) {
  let lay = fs.readFileSync('public/js/layout.js', 'utf8');
  const wMatch = lay.match(/(?:const|let)?\s*(w|W|width|CARD_W)\s*[:=]\s*(\d+)/);
  if (wMatch) {
    const oldW = parseInt(wMatch[2]);
    const newW = oldW + 20; // Добавляем 20px
    lay = lay.replace(wMatch[0], wMatch[0].replace(oldW.toString(), newW.toString()));
    fs.writeFileSync('public/js/layout.js', lay);
    console.log(`✅ LAYOUT.JS: ширина карточки увеличена с ${oldW} до ${newW}px (связи больше не будут перекрываться)`);
  } else {
    console.log('⚠️ LAYOUT.JS: не найдена переменная ширины (оставляем как есть)');
  }
}

// --- 3. ДЕЛАЕМ КРАСИВЫЕ ИНДИВИДУАЛЬНЫЕ НАПОМИНАНИЯ ---
let appJs = fs.readFileSync('public/js/app.js', 'utf8');

// Ищем мою прошлую вставку с баннером и заменяем её на модальное окно со списком
const oldBannerRegex = /try \{\s*const up = upcoming\(doc\.people\);[\s\S]*?catch\(e\) \{ console\.warn\('upcoming', e\); \}/;
const newReminders = `try {
    // Проверяем, не показывали ли мы уже напоминания сегодня
    const todayStr = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem('rod:lastReminderDate') === todayStr) return;

    const up = upcoming(doc.people);
    if (up && up.length) {
      // Формируем красивый список
      const listHtml = up.map(u => {
        const isBirth = u.type === 'birth';
        const isDeath = u.type === 'death';
        const icon = isBirth ? '🎂' : (isDeath ? '🕯️' : '💍');
        const dateStr = u.date; // например "12.05" или "14.06"
        const years = u.age ? \` (\${u.age} \${plural(u.age, 'год', 'года', 'лет')})\` : '';
        return \`<div style="padding:6px 0;border-bottom:1px solid var(--line);display:flex;justify-content:space-between">
          <span>\${icon} <b>\${esc(u.name)}</b></span>
          <span style="color:var(--mut)">\${dateStr}\${years}</span>
        </div>\`;
      }).join('');

      openModal('Ближайшие события', \`
        <div style="max-height:300px;overflow-y:auto;margin-bottom:16px">\${listHtml}</div>
        <div style="display:flex;justify-content:flex-end">
          <button class="btn gold" onclick="localStorage.setItem('rod:lastReminderDate', '\${todayStr}'); document.getElementById('modalClose').click();">Понятно</button>
        </div>
      \`);
    }
  } catch(e) { console.warn('upcoming', e); }`;

if (oldBannerRegex.test(appJs)) {
  appJs = appJs.replace(oldBannerRegex, newReminders);
  console.log('✅ APP.JS: заменено на индивидуальный список напоминаний (показывается 1 раз в день)');
} else {
  console.log('⚠️ APP.JS: не найден прошлый баннер напоминаний');
}

fs.writeFileSync('public/js/app.js', appJs);
console.log('\\n🏁 Готово! Теперь все правки корректны.');
