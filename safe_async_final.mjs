import fs from 'node:fs';
import { execSync } from 'node:child_process';

const backup = (f) => fs.copyFileSync(f, f + '.bak');
const rollback = (f) => { if (fs.existsSync(f + '.bak')) { fs.copyFileSync(f + '.bak', f); fs.unlinkSync(f + '.bak'); } };

try {
  let app = fs.readFileSync('public/js/app.js', 'utf8');
  backup('public/js/app.js');

  // 1. Восстанавливаем объект idb, если он потерялся
  if (!app.includes('const idb = {')) {
    const idbCode = `const idb = {
  db: null,
  init: () => new Promise((resolve, reject) => {
    if (idb.db) return resolve();
    const req = indexedDB.open('rodDB', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onsuccess = e => { idb.db = e.target.result; resolve(); };
    req.onerror = e => reject(e.target.error);
  }),
  get: async (key) => { await idb.init(); return new Promise((resolve, reject) => {
    const tx = idb.db.transaction('kv', 'readonly').objectStore('kv').get(key);
    tx.onsuccess = () => resolve(tx.result);
    tx.onerror = () => reject(tx.error);
  }); },
  set: async (key, val) => { await idb.init(); return new Promise((resolve, reject) => {
    const tx = idb.db.transaction('kv', 'readwrite').objectStore('kv').put(val, key);
    tx.onsuccess = () => resolve();
    tx.onerror = () => reject(tx.error);
  }); }
};
`;
    app = app.replace("import { esc,", idbCode + "\nimport { esc,");
    console.log('✅ app.js: объект IndexedDB на месте');
  }

  // 2. Добавляем async в функцию, где была ошибка
  if (app.includes("warn.onclick = () => {")) {
    app = app.replace("warn.onclick = () => {", "warn.onclick = async () => {");
    console.log('✅ app.js: исправлена ошибка с async');
  }

  // 3. Заменяем оставшиеся localStorage на idb
  if (app.includes("localStorage.getItem('rod:localTree')")) {
    app = app.replace(/localStorage\.getItem\('rod:localTree'\)/g, `await idb.get('localTree')`);
  }
  if (app.includes("localStorage.setItem('rod:localTree'")) {
    app = app.replace(/localStorage\.setItem\('rod:localTree',\s*([^)]+)\)/g, `await idb.set('localTree', $1)`);
  }

  fs.writeFileSync('public/js/app.js', app);
  
  // Тест перед внедрением
  console.log('🧪 Тестирование синтаксиса...');
  execSync('node --check public/js/app.js');
  console.log('✅ Синтаксис в порядке. Все изменения применены.');
  
  fs.unlinkSync('public/js/app.js.bak');

} catch (e) {
  console.error('❌ ОШИБКА! Откат...', e.message);
  rollback('public/js/app.js');
  process.exit(1);
}
