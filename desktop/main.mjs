// «Род» для Windows (Electron). Запускает встроенный сервер на этом компьютере (данные — в профиле пользователя)
// либо подключается к вашему серверу, если в config.json указан serverUrl.
import { app, BrowserWindow, Menu, shell } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cfgFile = () => path.join(app.getPath('userData'), 'config.json');
function readConfig() {
  try { return JSON.parse(fs.readFileSync(cfgFile(), 'utf8')); } catch { return {}; }
}
let embedded = null, win = null;

async function startEmbedded(cfg) {
  const { startServer } = await import(pathToFileURL(path.join(here, 'app', 'server.js')).href);
  const dataDir = path.join(app.getPath('userData'), 'data');
  const want = Number(cfg.port) || 38417; // фиксированный порт: иначе при каждом запуске меняется адрес и слетает вход
  try { embedded = await startServer({ port: want, host: '127.0.0.1', dataDir }); }
  catch (e) { if (e.code !== 'EADDRINUSE') throw e; embedded = await startServer({ port: 0, host: '127.0.0.1', dataDir }); }
  return `http://127.0.0.1:${embedded.port}`;
}

async function createWindow() {
  const cfg = readConfig();
  const url = cfg.serverUrl || await startEmbedded(cfg);
  win = new BrowserWindow({ width: 1360, height: 860, minWidth: 420, minHeight: 600, backgroundColor: '#0E2B28', autoHideMenuBar: true,
    icon: path.join(here, 'icon.png'), webPreferences: { contextIsolation: true, sandbox: true } });
  win.webContents.setWindowOpenHandler(({ url: u }) => { if (/^https?:/.test(u)) shell.openExternal(u); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, u) => { if (new URL(u).origin !== new URL(url).origin) { e.preventDefault(); shell.openExternal(u); } });
  await win.loadURL(url);
}

const menu = Menu.buildFromTemplate([
  { label: 'Род', submenu: [
    { label: 'Открыть папку с данными и настройками', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' }, { role: 'reload', label: 'Обновить' }, { role: 'togglefullscreen', label: 'Во весь экран' }, { type: 'separator' }, { role: 'quit', label: 'Выход' }] },
  { label: 'Вид', submenu: [{ role: 'zoomIn', label: 'Увеличить' }, { role: 'zoomOut', label: 'Уменьшить' }, { role: 'resetZoom', label: 'Масштаб 100%' }] },
]);

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => { Menu.setApplicationMenu(menu); return createWindow(); })
    .catch(e => { console.error(e); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { embedded?.close().catch(() => {}); });
}
