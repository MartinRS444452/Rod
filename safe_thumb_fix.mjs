import fs from 'node:fs';
import { execSync } from 'node:child_process';

const backup = (f) => fs.copyFileSync(f, f + '.bak');
const rollback = (f) => { if (fs.existsSync(f + '.bak')) { fs.copyFileSync(f + '.bak', f); fs.unlinkSync(f + '.bak'); } };

try {
  let app = fs.readFileSync('public/js/app.js', 'utf8');
  backup('public/js/app.js');

  // 1. УБИРАЕМ СЛОМАННЫЙ ИМПОРТ thumbUrl
  const oldImport = `import { esc, lifeText, ageText, matchPrefix, searchPeople, thumbUrl, plural, yearOf, parseDate, fullName, marriageInfo, norm } from './util.js';`;
  const newImport = `import { esc, lifeText, ageText, matchPrefix, searchPeople, plural, yearOf, parseDate, fullName, marriageInfo, norm } from './util.js';`;
  
  if (app.includes(oldImport)) {
    app = app.replace(oldImport, newImport);
    console.log('✅ app.js: удален сломанный импорт thumbUrl');
  }

  // 2. ДОБАВЛЯЕМ БЕЗОПАСНУЮ ЗАГЛУШКУ (возвращает исходный URL/Base64)
  const anchor = `const $ = id => document.getElementById(id);`;
  const safeThumb = `const thumbUrl = (url, size) => url;\nconst $ = id => document.getElementById(id);`;
  
  if (app.includes(anchor) && !app.includes('const thumbUrl = (url, size) => url;')) {
    app = app.replace(anchor, safeThumb);
    console.log('✅ app.js: добавлена безопасная заглушка для thumbUrl');
  }

  fs.writeFileSync('public/js/app.js', app);
  
  // ТЕСТ (Правило №9)
  console.log('🧪 Тестирование синтаксиса...');
  execSync('node --check public/js/app.js');
  console.log('✅ Синтаксис в порядке. Код чист.');
  
  fs.unlinkSync('public/js/app.js.bak');

} catch (e) {
  console.error('❌ ОШИБКА! Откат...', e.message);
  rollback('public/js/app.js');
  process.exit(1);
}
