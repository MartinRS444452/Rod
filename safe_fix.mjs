import fs from 'node:fs';

// 1. Убираем точку в index.html
let html = fs.readFileSync('public/index.html', 'utf8');
html = html.replace(/<div class="brand">Род<span>\.<\/span><\/div>/g, '<div class="brand">Род</div>');
html = html.replace(/<h1>Род<i>\.<\/i><\/h1>/g, '<h1>Род</h1>');
fs.writeFileSync('public/index.html', html);
console.log('✅ Точка убрана');

// 2. Меняем ширину в layout.js
let lay = fs.readFileSync('public/js/layout.js', 'utf8');
// Ищем любую ширину 160 или 180 и меняем на 210
const oldW = lay.match(/(w|W|width|CARD_W)\s*[:=]\s*(160|180)/);
if (oldW) {
  const newW = oldW[0].replace(/160|180/, '210');
  lay = lay.replace(oldW[0], newW);
  fs.writeFileSync('public/js/layout.js', lay);
  console.log(`✅ layout.js: ширина карточки изменена на 210px`);
} else {
  console.log('⚠️ layout.js: ширина 160/180 не найдена, возможно она другая.');
}

// 3. Синхронизируем ширину в app.css
let css = fs.readFileSync('public/app.css', 'utf8');
// Находим блок .person и ставим width: 210px
css = css.replace(/(\.person\s*\{[^}]*?width:\s*)\d+px;/g, '$1 210px;');
// Если width не было, добавляем
if (!css.includes('.person { width: 210px;')) {
   css = css.replace(/\.person\s*\{/, '.person { width: 210px; ');
}
fs.writeFileSync('public/app.css', css);
console.log('✅ app.css: ширина карточки 210px');

console.log('🏁 Готово!');
