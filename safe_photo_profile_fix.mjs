import fs from 'node:fs';
import { execSync } from 'node:child_process';

const backup = (f) => fs.copyFileSync(f, f + '.bak');
const rollback = (f) => { if (fs.existsSync(f + '.bak')) { fs.copyFileSync(f + '.bak', f); fs.unlinkSync(f + '.bak'); } };

try {
  let app = fs.readFileSync('public/js/app.js', 'utf8');
  backup('public/js/app.js');

  // 1. ФИКСИМ ФОТО В ПРОФИЛЕ (строка 835)
  const oldProfilePhoto = `    \${p.photo ? \`<div class="photo" id="bigPhoto" role="button" tabindex="0" aria-label="Открыть фото в полном размере"><img src="\${esc(thumbUrl(p.photo, 'm'))}" alt="\${esc(p.name)}"></div>\` : \`<div class="photo ph">\${esc(letter(p))}</div>\`}`;
  
  const newProfilePhoto = `    \${p.photo ? (() => {
      const isB64 = p.photo.startsWith('data:');
      const src = isB64 ? p.photo : esc(thumbUrl(p.photo, 'm'));
      return \`<div class="photo" id="bigPhoto" role="button" tabindex="0" aria-label="Открыть фото в полном размере"><img src="\${src}" alt="\${esc(p.name)}"></div>\`;
    })() : \`<div class="photo ph">\${esc(letter(p))}</div>\`}`;

  if (app.includes(oldProfilePhoto)) {
    app = app.replace(oldProfilePhoto, newProfilePhoto);
    console.log('✅ app.js: фото в профиле теперь поддерживает Base64');
  } else {
    console.log('⚠️ app.js: не найдена строка фото в профиле (возможно, изменилось форматирование)');
  }

  // 2. ФИКСИМ ФОТО В РЕДАКТОРЕ (строка 919)
  const oldEditPhoto = `    <div class="photo-edit"><div class="photo" id="photoPrev" style="cursor:default">\${ed.photo ? \`<img src="\${esc(thumbUrl(ed.photo, 'm'))}" alt="">\` : \`<span style="font-size:14px;font-family:var(--sans)">Фото не загружено</span>\`}</div>`;
  
  const newEditPhoto = `    <div class="photo-edit"><div class="photo" id="photoPrev" style="cursor:default">\${ed.photo ? (() => {
      const isB64 = ed.photo.startsWith('data:');
      const src = isB64 ? ed.photo : esc(thumbUrl(ed.photo, 'm'));
      return \`<img src="\${src}" alt="">\`;
    })() : \`<span style="font-size:14px;font-family:var(--sans)">Фото не загружено</span>\`}</div>`;

  if (app.includes(oldEditPhoto)) {
    app = app.replace(oldEditPhoto, newEditPhoto);
    console.log('✅ app.js: фото в редакторе теперь поддерживает Base64');
  } else {
    console.log('⚠️ app.js: не найдена строка фото в редакторе');
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
