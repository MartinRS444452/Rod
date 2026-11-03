// Проверка без Electron: синхронизация файлов и запуск встроенного сервера так же, как это делает main.mjs.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
execFileSync(process.execPath, [path.join(here, 'sync.mjs')], { stdio: 'inherit' });
const { startServer } = await import(pathToFileURL(path.join(here, 'app', 'server.js')).href);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rod-desktop-'));
const s = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir });
const r = await fetch(`http://127.0.0.1:${s.port}/healthz`).then(r => r.json());
const idx = await fetch(`http://127.0.0.1:${s.port}/`);
console.log('healthz:', JSON.stringify(r), '| index:', idx.status);
await s.close(); fs.rmSync(dir, { recursive: true, force: true });
if (!r.ok || idx.status !== 200) process.exit(1);
