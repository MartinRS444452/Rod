import fs from 'node:fs';

// 1. ЧИНИМ ОБРЕЗАНИЕ ЛЕТ И ДОБАВЛЯЕМ СТИЛЬ РАЗВОДА
if (fs.existsSync('public/app.css')) {
  let css = fs.readFileSync('public/app.css', 'utf8');
  if (!css.includes('overflow: visible !important')) {
    css += '\n#edges { overflow: visible !important; }\n';
  }
  if (!css.includes('.m.divorced')) {
    css += '\n.m.divorced { stroke-dasharray: 6, 6 !important; stroke: #B8665C !important; stroke-width: 3px !important; }\n';
  }
  fs.writeFileSync('public/app.css', css);
  console.log('✅ CSS: исправлено обрезание лет и добавлен пунктир');
}

// 2. ФИКСИРУЕМ РАССТОЯНИЕ МЕЖДУ СУПРУГАМИ
if (fs.existsSync('public/js/layout.js')) {
  let lay = fs.readFileSync('public/js/layout.js', 'utf8');
  // Ищем переменную отступа (обычно SPOUSE_GAP, GAP или подобное)
  const gapMatch = lay.match(/(SPOUSE_GAP|spouseGap|GAP|spouseOffset)\s*=\s*\d+/);
  if (gapMatch) {
    lay = lay.replace(gapMatch[0], gapMatch[0].replace(/\d+/, '60')); // Делаем отступ 60px
    fs.writeFileSync('public/js/layout.js', lay);
    console.log('✅ layout.js: расстояние между супругами зафиксировано (60px)');
  } else {
    console.log('⚠️ layout.js: переменная отступа не найдена (пропускаем)');
  }
}

// 3. ДОБАВЛЯЕМ ПУНКТИР НА ДЕРЕВО И ГАЛОЧКУ В ФОРМУ (без правки сложных функций)
if (fs.existsSync('public/js/app.js')) {
  let app = fs.readFileSync('public/js/app.js', 'utf8');
  
  // Заменяем отрисовку пути брака на пунктир, если есть развод
  const oldLine = '<path class="m" d="${l.d}"/>';
  const newLine = '<path class="m ${P[l.a]?.marriages?.find(m => m.with === l.b)?.divorced ? \'divorced\' : \'\'}" d="${l.d}"/>';
  
  if (app.includes(oldLine)) {
    app = app.replace(oldLine, newLine);
    console.log('✅ app.js: пунктир для развода внедрен в SVG');
  }

  // Безопасный перехватчик: добавляем галочку при открытии формы и сохраняем её при отправке
  const safeInterceptor = `
// БЕЗОПАСНЫЙ ПЕРЕХВАТЧИК ДЛЯ РАЗВОДОВ
document.addEventListener('click', e => {
  if (e.target.closest('[data-act=edit]') || e.target.closest('[data-add]')) {
    setTimeout(() => {
      document.querySelectorAll('input[data-wed]').forEach(inp => {
        if (inp.nextElementSibling?.classList.contains('divorce-label')) return;
        const withId = inp.getAttribute('data-wed');
        const label = document.createElement('label');
        label.className = 'divorce-label';
        label.style.cssText = 'font-size:12px;margin-left:8px;display:inline-flex;align-items:center;gap:4px;color:#B8665C';
        label.innerHTML = \`<input type="checkbox" class="divorce-cb" data-for="\${withId}"> Развод\`;
        inp.after(label);
      });
    }, 150);
  }
});

const originalFetch = window.fetch;
window.fetch = async function(...args) {
  let [url, options] = args;
  if (url.includes('/save') && options && options.body) {
    try {
      const data = JSON.parse(options.body);
      if (data.ops) {
        data.ops.forEach(op => {
          if (op.op === 'put' && op.person && op.person.marriages) {
            op.person.marriages.forEach(m => {
              const cb = document.querySelector(\`.divorce-cb[data-for="\${m.with}"]\`);
              if (cb) m.divorced = cb.checked;
            });
          }
        });
        options.body = JSON.stringify(data);
      }
    } catch (e) {}
  }
  return originalFetch.apply(this, args);
};
`;
  // Добавляем перехватчик в самый конец файла
  if (!app.includes('БЕЗОПАСНЫЙ ПЕРЕХВАТЧИК ДЛЯ РАЗВОДОВ')) {
    app += '\n' + safeInterceptor;
    console.log('✅ app.js: добавлена галочка «Развод» и её сохранение');
  }
  
  fs.writeFileSync('public/js/app.js', app);
}

console.log('🏁 Готово!');
