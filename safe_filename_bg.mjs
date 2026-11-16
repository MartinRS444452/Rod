import fs from 'node:fs';
import { execSync } from 'node:child_process';

const backup = (f) => fs.copyFileSync(f, f + '.bak');
const rollback = (f) => { if (fs.existsSync(f + '.bak')) { fs.copyFileSync(f + '.bak', f); fs.unlinkSync(f + '.bak'); } };

try {
  let app = fs.readFileSync('public/js/app.js', 'utf8');
  backup('public/js/app.js');

  // 1. СОХРАНЯЕМ СПРАВОЧНИК КАРТИНОК ПРИ ИМПОРТЕ
  const oldImportSave = `            const jsonStr = JSON.stringify(treeJson);
            await idb.set('localTree', jsonStr);`;
  
  const newImportSave = `            const jsonStr = JSON.stringify(treeJson);
            await idb.set('localTree', jsonStr);
            await idb.set('mediaMap', JSON.stringify(mediaMap));`;

  if (app.includes(oldImportSave)) {
    app = app.replace(oldImportSave, newImportSave);
    console.log('✅ app.js: справочник картинок теперь сохраняется в память');
  } else {
    console.log('⚠️ app.js: не найден блок сохранения localTree (проверьте код)');
  }

  // 2. ПРИ ПРИМЕНЕНИИ ТЕМЫ ИЩЕМ КАРТИНКУ ПО ИМЕНИ
  const oldImportTheme = `    importBody.querySelector('#btn-apply-import').onclick = () => {
      const code = importBody.querySelector('#import-code').value.trim();
      if (!code) return;

      try {
        const data = JSON.parse(code);
        closeModal();
        setTimeout(() => {
          const c = data.colors || data;
          const colorMap = { bg: 'bg', surface: 'surface', text: 'text', line: 'line', edge: 'edge', spouseline: 'spouseline', divorce: 'divorce' };
          
          for (const [key, id] of Object.entries(colorMap)) {
            let val = c[key];
            if (!val && key === 'spouseline') val = c.spouseLine;
            if (!val && key === 'divorce') val = c.divorceColor;
            if (val) {
              body.querySelector('#c-' + id).value = val;
              body.querySelector('#h-' + id).value = val;
            }
          }
          
          if (c.lineWidth) body.querySelector('#c-linewidth').value = c.lineWidth;
          if (c.spouseLineWidth) body.querySelector('#c-spousewidth').value = c.spouseLineWidth;
          
          if (c.bgImg !== undefined) {
            selectedBase64 = c.bgImg;
            body.querySelector('#bgfile-name').textContent = selectedBase64 ? 'Картинка установлена' : 'Без картинки';
            document.body.style.backgroundImage = selectedBase64 ? \`url('\${selectedBase64}')\` : '';
          }
          
          updatePreview();
          const newColors = { bg: body.querySelector('#c-bg').value, surface: body.querySelector('#c-surface').value, text: body.querySelector('#c-text').value, line: body.querySelector('#c-line').value, edge: body.querySelector('#c-edge').value, lineWidth: parseFloat(body.querySelector('#c-linewidth').value), spouseLine: body.querySelector('#c-spouseline').value, spouseLineWidth: parseFloat(body.querySelector('#c-spousewidth').value), divorceColor: body.querySelector('#c-divorce').value, bgImg: selectedBase64 };
          localStorage.setItem('rod:customColors', JSON.stringify(newColors));
          applyCustomColors();
          if (typeof relayout === 'function') relayout();
          
          toast('Тема "' + (data.name || 'Импорт') + '" применена!');
        }, 100);
      } catch(e) { toast('Ошибка темы: ' + e.message, true); }
    };`;

  const newImportTheme = `    importBody.querySelector('#btn-apply-import').onclick = async () => {
      const code = importBody.querySelector('#import-code').value.trim();
      if (!code) return;

      try {
        const data = JSON.parse(code);
        closeModal();
        
        const c = data.colors || data;
        let bgUrl = '';
        if (c.bgImg) {
          if (c.bgImg.startsWith('data:')) {
            bgUrl = c.bgImg;
          } else {
            const mmStr = await idb.get('mediaMap');
            if (mmStr) {
              const mm = JSON.parse(mmStr);
              if (mm[c.bgImg]) bgUrl = mm[c.bgImg];
            }
          }
        }

        setTimeout(() => {
          const colorMap = { bg: 'bg', surface: 'surface', text: 'text', line: 'line', edge: 'edge', spouseline: 'spouseline', divorce: 'divorce' };
          for (const [key, id] of Object.entries(colorMap)) {
            let val = c[key];
            if (!val && key === 'spouseline') val = c.spouseLine;
            if (!val && key === 'divorce') val = c.divorceColor;
            if (val) {
              body.querySelector('#c-' + id).value = val;
              body.querySelector('#h-' + id).value = val;
            }
          }
          
          if (c.lineWidth) body.querySelector('#c-linewidth').value = c.lineWidth;
          if (c.spouseLineWidth) body.querySelector('#c-spousewidth').value = c.spouseLineWidth;
          
          selectedBase64 = bgUrl;
          body.querySelector('#bgfile-name').textContent = selectedBase64 ? 'Картинка найдена в базе' : 'Без картинки';
          document.body.style.backgroundImage = selectedBase64 ? \`url('\${selectedBase64}')\` : '';
          
          updatePreview();
          const newColors = { bg: body.querySelector('#c-bg').value, surface: body.querySelector('#c-surface').value, text: body.querySelector('#c-text').value, line: body.querySelector('#c-line').value, edge: body.querySelector('#c-edge').value, lineWidth: parseFloat(body.querySelector('#c-linewidth').value), spouseLine: body.querySelector('#c-spouseline').value, spouseLineWidth: parseFloat(body.querySelector('#c-spousewidth').value), divorceColor: body.querySelector('#c-divorce').value, bgImg: selectedBase64 };
          localStorage.setItem('rod:customColors', JSON.stringify(newColors));
          applyCustomColors();
          if (typeof relayout === 'function') relayout();
          
          toast('Тема "' + (data.name || 'Импорт') + '" применена!');
        }, 100);
      } catch(e) { toast('Ошибка темы: ' + e.message, true); }
    };`;

  if (app.includes(oldImportTheme)) {
    app = app.replace(oldImportTheme, newImportTheme);
    console.log('✅ app.js: импорт темы теперь умеет искать картинки по имени файла');
  } else {
    console.log('⚠️ app.js: не найден блок импорта темы');
  }

  fs.writeFileSync('public/js/app.js', app);
  
  // Тест перед внедрением (Правило №9)
  console.log('🧪 Тестирование синтаксиса...');
  execSync('node --check public/js/app.js');
  console.log('✅ Синтаксис в порядке. Все изменения применены.');
  
  fs.unlinkSync('public/js/app.js.bak');

} catch (e) {
  console.error('❌ ОШИБКА! Откат...', e.message);
  rollback('public/js/app.js');
  process.exit(1);
}
