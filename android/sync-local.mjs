import fs from 'node:fs';
import path from 'node:path';

const out = 'www/app';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Копируем содержимое папки public
fs.cpSync('../public', out, { recursive: true });
console.log('✅ Файлы приложения скопированы в android/www/app');