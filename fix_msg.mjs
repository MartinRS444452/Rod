import fs from 'node:fs';
const file = 'public/js/app.js';
let s = fs.readFileSync(file, 'utf8');
const oldMsg = `toast('Нет сети: изменения сохранены локально и отправятся позже.', false);`;
const newMsg = `toast('Нет связи с сервером. Нет возможности обновить данные — они сохранены локально и отправятся, как только связь появится.', false);`;

if (s.includes(oldMsg)) {
  s = s.replace(oldMsg, newMsg);
  fs.writeFileSync(file, s);
  console.log('✅ Текст уведомления успешно изменен!');
} else {
  console.log('⚠️ Старый текст не найден. Возможно, патч не применялся.');
}
