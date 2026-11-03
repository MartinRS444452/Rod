// Копирует сервер и интерфейс из корня проекта в desktop/app (электрону нужны файлы внутри своей папки).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url)), root = path.resolve(here, '..'), out = path.join(here, 'app');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of ['server.js', 'lib', 'public']) fs.cpSync(path.join(root, f), path.join(out, f), { recursive: true });
fs.copyFileSync(path.join(root, 'public/icons/icon-512.png'), path.join(here, 'icon.png'));
console.log('desktop/app обновлён');
