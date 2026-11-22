import fs from 'node:fs';
import { execSync } from 'node:child_process';

const backup = (f) => fs.copyFileSync(f, f + '.bak');
const rollback = (f) => { if (fs.existsSync(f + '.bak')) { fs.copyFileSync(f + '.bak', f); fs.unlinkSync(f + '.bak'); } };

try {
  let app = fs.readFileSync('public/js/app.js', 'utf8');
  backup('public/js/app.js');

  // --- 1. ЧИНИМ СОХРАНЕНИЕ В СЛОТ (Заменяем блок) ---
  const oldSaveStart = `  body.querySelectorAll('[data-save]').forEach(btn => {
    btn.onclick = () => {`;
  const oldSaveEnd = `      localStorage.setItem('rod:theme_slot_' + slot, JSON.stringify(data));
      toast('Тема "' + name + '" сохранена в слот ' + slot);
      closeModal(); openThemePicker(); // Перерисовываем окно
    };
  });`;

  const newSaveLogic = `  body.querySelectorAll('[data-save]').forEach(btn => {
    btn.onclick = async () => {
      const slot = btn.getAttribute('data-save');
      const name = body.querySelector(\`[data-slotname="\${slot}"]\`).value.trim() || ('Слот ' + slot);

      let saveBg = selectedBase64;
      if (saveBg && saveBg.startsWith('data:') && saveBg.length > 1500000) {
        saveBg = ''; 
        toast('Фон слишком большой (лимит 1 МБ). Используйте имена файлов.', true);
      }

      let finalBgName = '';
      if (saveBg && saveBg.startsWith('data:')) {
        finalBgName = 'custom_bg_' + Date.now() + '.jpg';
        const mmStr = await idb.get('mediaMap');
        let mm = mmStr ? JSON.parse(mmStr) : {};
        mm[finalBgName] = saveBg;
        await idb.set('mediaMap', JSON.stringify(mm));
      }

      const data = {
        name,
        colors: {
          bg: body.querySelector('#c-bg').value, surface: body.querySelector('#c-surface').value,
          text: body.querySelector('#c-text').value, line: body.querySelector('#c-line').value,
          edge: body.querySelector('#c-edge').value, lineWidth: parseFloat(body.querySelector('#c-linewidth').value),
          spouseLine: body.querySelector('#c-spouseline').value, spouseLineWidth: parseFloat(body.querySelector('#c-spousewidth').value),
          divorceColor: body.querySelector('#c-divorce').value, bgImg: finalBgName
        }
      };
      localStorage.setItem('rod:theme_slot_' + slot, JSON.stringify(data));
      toast('Тема "' + name + '" сохранена в слот ' + slot);
      closeModal(); openThemePicker(); 
    };
  });`;

  const startIndex = app.indexOf(oldSaveStart);
  if (startIndex !== -1) {
    const endIndex = app.indexOf(oldSaveEnd, startIndex) + oldSaveEnd.length;
    app = app.substring(0, startIndex) + newSaveLogic + app.substring(endIndex);
    console.log('✅ app.js: сохранение в слот переписано (теперь ждет записи и сохраняет имя файла)');
  } else {
    console.log('❌ ОШИБКА: не найден блок сохранения в слот.');
    process.exit(1);
  }

  // --- 2. ЧИНИМ ЗАГРУЗКУ ИЗ СЛОТА (Заменяем блок) ---
  const oldLoadStart = `  body.querySelectorAll('[data-load]').forEach(btn => {
    btn.onclick = () => {`;
  const oldLoadEnd = `      setInputs(data.colors);
      toast('Загружена тема "' + (data.name || 'Слот ' + slot) + '"');
    };
  });`;

  const newLoadLogic = `  body.querySelectorAll('[data-load]').forEach(btn => {
    btn.onclick = async () => {
      const slot = btn.getAttribute('data-load');
      const saved = localStorage.getItem('rod:theme_slot_' + slot);
      if (!saved) return;
      const data = JSON.parse(saved);
      
      // Если в теме есть имя файла, достаем саму картинку из базы
      if (data.colors.bgImg && !data.colors.bgImg.startsWith('data:')) {
        const mmStr = await idb.get('mediaMap');
        if (mmStr) {
          const mm = JSON.parse(mmStr);
          if (mm[data.colors.bgImg]) {
            data.colors.bgImg = mm[data.colors.bgImg];
          }
        }
      }
      setInputs(data.colors);
      toast('Загружена тема "' + (data.name || 'Слот ' + slot) + '"');
    };
  });`;

  const loadStartIndex = app.indexOf(oldLoadStart);
  if (loadStartIndex !== -1) {
    const loadEndIndex = app.indexOf(oldLoadEnd, loadStartIndex) + oldLoadEnd.length;
    app = app.substring(0, loadStartIndex) + newLoadLogic + app.substring(loadEndIndex);
    console.log('✅ app.js: загрузка из слота переписана (теперь ищет картинку по имени)');
  } else {
    console.log('❌ ОШИБКА: не найден блок загрузки из слота.');
    process.exit(1);
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
