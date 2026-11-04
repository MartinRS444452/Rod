import fs from 'node:fs';

const file = 'public/js/app.js';
if (!fs.existsSync(file)) process.exit(1);
let s = fs.readFileSync(file, 'utf8');
fs.copyFileSync(file, file + '.bak');

// 1. Разрешаем редактирование в офлайне
s = s.replace(
  `S.me = JSON.parse(me); S.ro = true; document.body.classList.add('ro');`,
  `S.me = JSON.parse(me); S.ro = false; /* Разрешаем правки */`
);

// 2. Учим функцию api() складывать запросы в очередь при отсутствии сети
const apiOld = `  let r;
  try { r = await fetch(url, { method, headers: h, body: b, credentials: 'same-origin' }); }
  catch { throw Object.assign(new Error('Нет соединения с сервером'), { offline: true }); }`;
  
const apiNew = `  let r;
  try { 
    r = await fetch(url, { method, headers: h, body: b, credentials: 'same-origin' }); 
    if (r.ok && method !== 'GET' && url.includes('/save')) {
      // Если сеть появилась и это сохранение — очищаем дубли из очереди
      const q = JSON.parse(localStorage.getItem('rod:queue') || '[]');
      const newQ = q.filter(x => x.url !== url || JSON.stringify(x.body) !== JSON.stringify(body));
      localStorage.setItem('rod:queue', JSON.stringify(newQ));
    }
  }
  catch (e) { 
    if (method !== 'GET' && url.includes('/save')) {
      const q = JSON.parse(localStorage.getItem('rod:queue') || '[]');
      q.push({ url, method, body, headers: h });
      localStorage.setItem('rod:queue', JSON.stringify(q));
      toast('Нет сети: изменения сохранены локально и отправятся позже.', false);
      return { noop: false, rev: S.doc.rev + 1, local: true }; // Фейковый успех для UI
    }
    throw Object.assign(new Error('Нет соединения с сервером'), { offline: true }); 
  }`;
s = s.replace(apiOld, apiNew);

// 3. Добавляем механизм отправки очереди при появлении интернета
const syncLogic = `
async function syncQueue() {
  if (!navigator.onLine || !S.doc) return;
  const q = JSON.parse(localStorage.getItem('rod:queue') || '[]');
  if (!q.length) return;
  toast('Связь появилась: синхронизируем изменения...');
  for (const req of q) {
    try {
      const r = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
      if (r.status === 409) { toast('Конфликт правок: карточку изменили на другом устройстве!', true); }
    } catch (e) { break; } // Если сеть снова пропала — выходим
  }
  localStorage.removeItem('rod:queue');
  boot(); // Перезагружаем актуальные данные с сервера
}
window.addEventListener('online', syncQueue);
`;
s = s.replace(`addEventListener('online', () => { if (S.ro) boot(); });`, syncLogic);

fs.writeFileSync(file, s);
console.log('✅ Автономный режим с очередью синхронизации включен!');
