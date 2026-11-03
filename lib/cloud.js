// Облачная копия (S3-совместимое хранилище: Yandex Object Storage, Cloudflare R2, MinIO, AWS).
// Все выгрузки идут через постоянную очередь (таблица outbox): при сбое сети повторяются
// с нарастающей паузой и переживают перезапуск сервера.
import crypto from 'node:crypto';
import fs from 'node:fs';

const hex = b => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());

/**
 * AWS Signature V4. headers — все подписываемые заголовки (включая host).
 * Возвращает значение заголовка Authorization.
 */
export function signV4({ method, url, headers, payloadHash, accessKey, secret, region, service = 's3', amzDate }) {
  const u = new URL(url), day = amzDate.slice(0, 8);
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim().replace(/\s+/g, ' ')]));
  const canonPath = u.pathname.split('/').map(s => enc(decodeURIComponent(s))).join('/') || '/';
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, canonPath, query, names.map(n => `${n}:${lower[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, hex(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + secret, day), region), service), 'aws4_request');
  const sig = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${sig}`;
}

export class Cloud {
  constructor(store, env = process.env) {
    this.store = store;
    this.cfg = { endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, key: env.S3_KEY, secret: env.S3_SECRET,
      region: env.S3_REGION || 'ru-central1', prefix: env.S3_PREFIX ?? 'rod/' };
    this.enabled = !!(this.cfg.endpoint && this.cfg.bucket && this.cfg.key && this.cfg.secret);
    this.dbBackupEvery = Number(env.S3_DB_BACKUP_INTERVAL_MS) || 24 * 3600e3;
    this.timer = null; this.busy = false; this.lastError = null;
  }

  enqueue(key, ctype, payload) { if (this.enabled) this.store.outboxPut(key, ctype, payload); }

  async put(key, ctype, body) {
    const c = this.cfg;
    const url = `${c.endpoint.replace(/\/$/, '')}/${c.bucket}/${(c.prefix + key).split('/').map(enc).join('/')}`;
    const amzDate = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const payloadHash = hex(body);
    const headers = { host: new URL(url).host, 'content-type': ctype, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
    const Authorization = signV4({ method: 'PUT', url, headers, payloadHash, accessKey: c.key, secret: c.secret, region: c.region, amzDate });
    const r = await fetch(url, { method: 'PUT', body, signal: AbortSignal.timeout(60000),
      headers: { 'Content-Type': ctype, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate, Authorization } });
    if (!r.ok) throw new Error(`S3 ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  }

  /** Обрабатывает очередь. Возвращает число отправленных объектов. */
  async drain() {
    if (!this.enabled || this.busy || this.stopped) return 0;
    this.busy = true; let sent = 0;
    try {
      for (const it of this.store.outboxDue(10)) {
        try {
          const body = it.file ? await fs.promises.readFile(it.file) : Buffer.from(it.body ?? '');
          await this.put(it.key, it.ctype, body);
          this.store.outboxDone(it.id); sent++; this.lastError = null;
        } catch (e) {
          if (e.code === 'ENOENT') { this.store.outboxDone(it.id); continue; }
          this.lastError = e.message; this.store.outboxFail(it.id, it.tries + 1);
          console.error(`cloud: ${it.key} (попытка ${it.tries + 1}): ${e.message}`);
        }
      }
    } finally { this.busy = false; }
    return sent;
  }

  start(dataDir) {
    if (!this.enabled) return;
    this.dataDir = dataDir;
    this.timer = setInterval(() => { this.drain().catch(() => {}); this.maybeBackupDb(); }, 5000);
    this.timer.unref?.();
    this.maybeBackupDb();
  }
  stop() { clearInterval(this.timer); this.stopped = true; }

  /** Раз в сутки — согласованная копия всей БД (аккаунты, древа, история). */
  maybeBackupDb() {
    if (!this.enabled) return;
    const last = Number(this.store.meta('last_db_backup') || 0);
    if (Date.now() - last < this.dbBackupEvery) return;
    try {
      const f = `${this.dataDir}/backup-tmp.db`;
      fs.rmSync(f, { force: true });
      this.store.backupTo(f);
      this.store.outboxPut(`db/rod-${new Date().toISOString().slice(0, 10)}.db`, 'application/octet-stream', { file: f });
      this.store.setMeta('last_db_backup', Date.now());
    } catch (e) { console.error('cloud: бэкап БД не создан:', e.message); }
  }

  /** Постановка в очередь после правки древа. */
  onCommit(tree, patch) {
    if (!this.enabled) return;
    this.enqueue(`versions/${tree.id}/r${patch.rev}.json`, 'application/json', {
      body: JSON.stringify({ rev: patch.rev, ts: patch.ts, author: patch.by, note: patch.note, diff: patch.diff }) });
    this.enqueue(`trees/${tree.id}/head.json`, 'application/json', {
      body: JSON.stringify({ id: tree.id, name: patch.name, rev: patch.rev, people: tree.people }) });
    setImmediate(() => this.drain().catch(() => {}));
  }
}
