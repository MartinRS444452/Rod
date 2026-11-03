// Минимальный ZIP без зависимостей (замена archiver и JSZip).
// Запись: потоковая, по одному файлу в памяти. Чтение: через центральный каталог.
// Ограничения: без ZIP64 (архив < 4 ГБ, < 65535 файлов), без шифрования.
import zlib from 'node:zlib';
import fs from 'node:fs';

const crc32 = zlib.crc32; // Node >= 22.2

function dosTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(d.getFullYear(), 1980) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
const STORE_EXT = /\.(jpe?g|png|webp|gif|zip|gz|mp4|heic)$/i;

/**
 * @param {Array<{name:string, data?:Buffer|string, file?:string, mtime?:Date}>} entries
 * @yields {Buffer}
 */
export async function* zipStream(entries) {
  if (entries.length > 65000) throw new Error('Слишком много файлов для ZIP');
  const central = [];
  let offset = 0;
  const now = new Date();
  for (const e of entries) {
    const raw = e.file ? await fs.promises.readFile(e.file) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? '', 'utf8');
    if (raw.length >= 0xFFFFFFFF) throw new Error('Файл слишком велик для ZIP');
    const name = Buffer.from(e.name, 'utf8');
    const method = STORE_EXT.test(e.name) || raw.length < 64 ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(raw, { level: 6 }) : raw;
    const { time, date } = dosTime(e.mtime || now);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    central.push({ name, method, time, date, crc, csize: body.length, size: raw.length, offset });
    yield lh; yield name; yield body;
    offset += 30 + name.length + body.length;
    if (offset >= 0xFFFFFFFF) throw new Error('Архив слишком велик для ZIP');
  }
  const cdStart = offset;
  let cdSize = 0;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(0x031e, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0800, 8);
    h.writeUInt16LE(c.method, 10); h.writeUInt16LE(c.time, 12); h.writeUInt16LE(c.date, 14); h.writeUInt32LE(c.crc, 16);
    h.writeUInt32LE(c.csize, 20); h.writeUInt32LE(c.size, 24); h.writeUInt16LE(c.name.length, 28);
    h.writeUInt32LE(0o100644 << 16 >>> 0, 38); h.writeUInt32LE(c.offset, 42);
    yield h; yield c.name; cdSize += 46 + c.name.length;
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdStart, 16);
  yield end;
}

export async function zipBuffer(entries) {
  const parts = [];
  for await (const c of zipStream(entries)) parts.push(c);
  return Buffer.concat(parts);
}

/**
 * Чтение ZIP из буфера. Возвращает Map имя → () => Buffer (ленивая распаковка с проверкой CRC).
 * Защита от zip-бомб: лимит на суммарный распакованный размер и число файлов.
 */
export function readZip(buf, { maxTotal = 600 * 1024 * 1024, maxFiles = 30000 } = {}) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Это не ZIP-архив');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > maxFiles) throw new Error('В архиве слишком много файлов');
  const out = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Повреждённый ZIP');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + el + cl;
    if (name.endsWith('/')) continue;
    if (flags & 1) throw new Error('Зашифрованные архивы не поддерживаются');
    total += size;
    if (total > maxTotal) throw new Error('Архив слишком большой после распаковки');
    out.set(name, () => {
      if (lho + 30 > buf.length || buf.readUInt32LE(lho) !== 0x04034b50) throw new Error('Повреждённый ZIP');
      const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
      if (start + csize > buf.length) throw new Error('Повреждённый ZIP');
      const body = buf.subarray(start, start + csize);
      let data;
      if (method === 0) data = body;
      else if (method === 8) data = zlib.inflateRawSync(body, { maxOutputLength: size + 1 });
      else throw new Error('Неподдерживаемый метод сжатия');
      if (data.length !== size || crc32(data) !== crc) throw new Error('Контрольная сумма файла не совпала: ' + name);
      return data;
    });
  }
  return out;
}
