import fs from 'node:fs';
import path from 'node:path';

// Читаем .env напрямую, чтобы не зависеть от флагов запуска
function loadEnv() {
  const envPath = path.resolve('.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (match) {
        let val = (match[2] || '').trim();
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        if (!process.env[match[1]]) process.env[match[1]] = val;
      }
    }
  }
}
loadEnv();

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

export function startTelegramNotifier(store) {
  if (!TOKEN || !CHAT_ID) {
    console.log('Telegram: уведомления выключены (нет токена в .env)');
    return;
  }

  const check = async () => {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    
    // Отправляем 1 раз в день
    if (store.meta('last_telegram_sent') === todayStr) return;

    const trees = store.db.prepare('SELECT id FROM trees').all();
    let messages = [];

    for (const t of trees) {
      const people = store.loadPeople(t.id);
      for (const p of Object.values(people)) {
        if (p.birth) {
          const m = p.birth.match(/(\d{1,2})[.\-/](\d{1,2})/);
          if (m) {
            const d = new Date(today.getFullYear(), parseInt(m[2])-1, parseInt(m[1]));
            // Если дата уже прошла в этом году, переносим её на следующий год
            if (d < today) d.setFullYear(today.getFullYear() + 1);
            
            // Считаем точную разницу в целых днях (округление вниз, чтобы предупредить заранее)
            const diff = Math.floor((d - today) / 86400000);
            
            if (diff === 0) messages.push(`🎂 Сегодня день рождения у <b>${p.name}</b>!`);
            else if (diff > 0 && diff <= 7) messages.push(`⏳ Через ${diff} дн. (${d.toLocaleDateString('ru-RU')}): <b>${p.name}</b>`);
          }
        }
      }
    }

    if (messages.length) {
      const text = `🌳 <b>Род: Ближайшие события</b>\n\n` + messages.join('\n');
      try {
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
          method: 'POST', headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' })
        });
        store.setMeta('last_telegram_sent', todayStr);
        console.log('Telegram: уведомления отправлены');
      } catch(e) { console.error('Telegram error:', e.message); }
    } else {
      store.setMeta('last_telegram_sent', todayStr);
    }
  };

  check();
  setInterval(check, 3 * 3600 * 1000).unref(); // проверка каждые 3 часа
}
