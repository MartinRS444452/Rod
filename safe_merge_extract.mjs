import fs from 'node:fs';
import { execSync } from 'node:child_process';

const backup = (f) => fs.copyFileSync(f, f + '.bak');
const rollback = (f) => { if (fs.existsSync(f + '.bak')) { fs.copyFileSync(f + '.bak', f); fs.unlinkSync(f + '.bak'); } };

try {
  let app = fs.readFileSync('public/js/app.js', 'utf8');
  backup('public/js/app.js');

  // 1. ВНЕДРЯЕМ РАСПАКОВКУ СРАЗУ ПОСЛЕ ЧТЕНИЯ TREE.JSON
  const anchor1 = `const treeJson = JSON.parse(await treeFile.async('string'));`;

  const replacement1 = `const treeJson = JSON.parse(await treeFile.async('string'));

        // ИЗВЛЕКАЕМ ФОТО И ДОКУМЕНТЫ (ДЛЯ ВСЕХ ОПЕРАЦИЙ - ИМПОРТ И СЛИЯНИЕ)
        const mediaMap = {};
        let filesFound = 0;
        let replacedCount = 0;
        for (const [filename, file] of Object.entries(zip.files)) {
          if (file.dir) continue;
          const ext = filename.split('.').pop().toLowerCase();
          if (['jpg', 'jpeg', 'png', 'webp', 'pdf'].includes(ext)) {
            const base64 = await file.async('base64');
            const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'pdf' ? 'application/pdf' : 'image/jpeg';
            mediaMap[filename.split('/').pop()] = \`data:\${mime};base64,\${base64}\`;
            filesFound++;
          }
        }

        for (const p of Object.values(treeJson.people)) {
          if (p.photo) {
            const fname = p.photo.split('/').pop();
            if (mediaMap[fname]) { p.photo = mediaMap[fname]; replacedCount++; }
          }
          if (p.docs) {
            p.docs.forEach(d => {
              if (d.file) {
                const fname = d.file.split('/').pop();
                if (mediaMap[fname]) d.file = mediaMap[fname];
              }
            });
          }
        }
        
        if (url.includes('/import') || url.includes('/apply-merge')) {
           alert(\`Диагностика: Найдено файлов: \${filesFound}, подставлено: \${replacedCount}\`);
        }`;

  if (app.includes(anchor1)) {
    app = app.replace(anchor1, replacement1);
    console.log('✅ app.js: распаковка вынесена наверх (работает и при слиянии)');
  } else {
    console.log('❌ ОШИБКА: не найдена строка treeJson');
    process.exit(1);
  }

  // 2. УДАЛЯЕМ СТАРЫЙ БЛОК ВНУТРИ /import (чтобы не делать работу дважды)
  const anchor2 = `          // Достаем картинки из ZIP и сохраняем их в память телефона
          const mediaMap = {};
          for (const [filename, file] of Object.entries(zip.files)) {
            if (file.dir) continue;
            const ext = filename.split('.').pop().toLowerCase();
            // Ищем ЛЮБЫЕ картинки и PDF, независимо от папки
            if (['jpg', 'jpeg', 'png', 'webp', 'pdf'].includes(ext)) {
              const base64 = await file.async('base64');
              const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'pdf' ? 'application/pdf' : 'image/jpeg';
              mediaMap[filename.split('/').pop()] = \`data:\${mime};base64,\${base64}\`;
              filesFound++;
            }
          }

          // Подменяем пути к фото в базе на извлеченные Base64
          for (const p of Object.values(treeJson.people)) {
            if (p.photo) {
              const fname = p.photo.split('/').pop();
              if (mediaMap[fname]) { p.photo = mediaMap[fname]; replacedCount++; }
            }
            if (p.docs) {
              p.docs.forEach(d => {
                if (d.file) {
                  const fname = d.file.split('/').pop();
                  if (mediaMap[fname]) d.file = mediaMap[fname];
                }
              });
            }
          }
`;

  if (app.includes(anchor2)) {
    app = app.replace(anchor2, '');
    console.log('✅ app.js: старый дублирующий блок удален');
  } else {
    console.log('⚠️ app.js: старый блок не найден (возможно, уже удален)');
  }

  fs.writeFileSync('public/js/app.js', app);
  execSync('node --check public/js/app.js');
  console.log('✅ Синтаксис в порядке.');

  fs.unlinkSync('public/js/app.js.bak');

} catch (e) {
  console.error('❌ ОШИБКА! Откат...', e.message);
  rollback('public/js/app.js');
  process.exit(1);
}
