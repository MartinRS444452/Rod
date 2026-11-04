export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const DATE_RE = /^[\p{L}\p{N}\s.\-/~≈?]{0,32}$/u;
const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const LIMITS = { name: 120, maidenName: 120, birthPlace: 200, deathPlace: 200, school: 200, education: 300, occupation: 200, workplace: 200, phone: 80, email: 200, address: 300, bio: 20000 };
const LABEL = { name: 'Имя', maidenName: 'Девичья фамилия', marriageDate: 'Дата свадьбы', birthPlace: 'Место рождения', deathPlace: 'Место смерти', school: 'Школа', education: 'Образование', occupation: 'Профессия', workplace: 'Место работы', phone: 'Телефон', email: 'E-mail', address: 'Адрес проживания', docs: 'Документы', bio: 'Биография', birth: 'Дата рождения', death: 'Дата смерти' };

function text(v, field) {
  const s = String(v ?? '').replace(CTRL, '').replace(/\r\n?/g, '\n').trim();
  if (s.length > LIMITS[field]) throw new HttpError(400, `Поле «${LABEL[field]}» длиннее ${LIMITS[field]} символов`);
  return s;
}
function date(v, field) {
  const s = String(v ?? '').replace(CTRL, '').trim();
  if (!DATE_RE.test(s)) throw new HttpError(400, `Поле «${LABEL[field]}»: допустимы цифры, буквы, точка, дефис, до 32 символов`);
  return s;
}
function ids(v, max, field) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, `Поле «${field}» должно быть списком`);
  const out = [];
  for (const x of v) {
    if (typeof x !== 'string' || !ID_RE.test(x)) throw new HttpError(400, `Некорректный идентификатор в поле «${field}»`);
    if (!out.includes(x)) out.push(x);
  }
  if (out.length > max) throw new HttpError(400, `Слишком много связей в поле «${field}» (максимум ${max})`);
  return out;
}

/** Приводит человека к каноническому виду; неизвестные поля отбрасываются. */
/** Поля, добавленные после версии 2.0: у старых записей их нет, поэтому всегда подставляем значения по умолчанию. */
export const fillDefaults = p => ({ maidenName: '', phone: '', email: '', address: '', docs: [], marriages: [], ...p });

function marriages(v) {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new HttpError(400, 'Поле «Свадьбы» должно быть списком');
  const out = [];
  for (const m of v) {
    if (!m || typeof m !== 'object' || typeof m.with !== 'string' || !ID_RE.test(m.with)) throw new HttpError(400, 'Некорректные данные о свадьбе');
    const d = date(m.date, 'marriageDate');
    const dd = date(m.divorceDate, 'divorceDate');
    if (d && !out.some(x => x.with === m.with)) out.push({ with: m.with, date: d, divorced: !!m.divorced, divorceDate: dd });
  }
  if (out.length > 12) throw new HttpError(400, 'Слишком много свадеб');
  return out;
}

// Контакты. E-mail — один или несколько адресов через запятую; телефон — свободная запись (несколько номеров через запятую)
const EMAIL_RE = /^[^\s@,;<>()[\]\\"]+@[^\s@,;<>()[\]\\"]+\.[^\s@,;<>()[\]\\"]{2,}$/;
const PHONE_RE = /^[\p{N}\p{L}\s+()\-.,;/#*]+$/u;
function emailField(v) {
  const s = text(v, 'email'); if (!s) return '';
  const parts = s.split(/[\s,;]+/).filter(Boolean), bad = parts.find(x => !EMAIL_RE.test(x));
  if (bad) throw new HttpError(400, `Поле «E-mail»: «${bad.slice(0, 40)}» не похоже на адрес`);
  return parts.join(', ');
}
function phoneField(v) {
  const s = text(v, 'phone'); if (!s) return '';
  if (!/\p{N}/u.test(s) || !PHONE_RE.test(s)) throw new HttpError(400, 'Поле «Телефон»: допустимы цифры, +, скобки, дефис, пробелы и запятая между номерами');
  return s;
}

// Вложенные документы (PDF и фото): метрики, свидетельства, дипломы…
export const DOC_KINDS = ['Свидетельство о рождении', 'Свидетельство о браке', 'Свидетельство о смерти', 'Метрическая запись', 'Диплом / аттестат', 'Паспорт / удостоверение', 'Военный билет', 'Письмо / открытка', 'Фото документа', 'Другое'];
export const MAX_DOCS = 40;
const DOC_TYPES = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf' };
const noCtl = s => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
/** Один документ или null, если путь не принадлежит этому древу / битый. */
export function cleanDoc(d, treeId) {
  const m = d && typeof d === 'object' ? new RegExp(`^/media/${treeId}/([A-Za-z0-9_-]+)\\.(jpg|png|webp|pdf)$`).exec(String(d.file ?? '')) : null;
  if (!m) return null;
  const size = Math.round(Number(d.size));
  return { id: /^[\w-]{1,40}$/.test(String(d.id ?? '')) ? String(d.id) : m[1].slice(0, 40), file: d.file, type: DOC_TYPES[m[2]],
    kind: DOC_KINDS.includes(d.kind) ? d.kind : '', title: noCtl(d.title).slice(0, 80), name: noCtl(String(d.name ?? '').replace(/[\\/]/g, '_')).slice(0, 120),
    size: Number.isFinite(size) ? Math.min(Math.max(size, 0), 200e6) : 0, added: Number.isFinite(Number(d.added)) ? Math.max(0, Math.round(Number(d.added))) : 0 };
}
function cleanDocs(raw, treeId, strict) {
  if (raw == null || raw === '') return [];
  if (!Array.isArray(raw)) { if (strict) throw new HttpError(400, 'Поле «Документы» должно быть списком'); return []; }
  if (strict && raw.length > MAX_DOCS) throw new HttpError(400, `У одного человека не больше ${MAX_DOCS} документов`);
  const seen = new Set(), out = [];
  for (const d of raw.slice(0, MAX_DOCS)) { const c = cleanDoc(d, treeId); if (c && !seen.has(c.file)) { seen.add(c.file); out.push(c); } }
  return out;
}

export function cleanPerson(raw, treeId) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new HttpError(400, 'Некорректные данные участника');
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) throw new HttpError(400, 'Некорректный идентификатор участника');
  const name = text(raw.name, 'name');
  if (!name) throw new HttpError(400, 'Укажите имя');
  let photo = String(raw.photo ?? '');
  if (photo && !new RegExp(`^/media/${treeId}/[A-Za-z0-9_-]+\\.(jpg|png|webp)$`).test(photo)) photo = '';
  return {
    id: raw.id, name, maidenName: text(raw.maidenName, 'maidenName'),
    sex: raw.sex === 'f' ? 'f' : 'm',
    birth: date(raw.birth, 'birth'), death: date(raw.death, 'death'),
    birthPlace: text(raw.birthPlace, 'birthPlace'), deathPlace: text(raw.deathPlace, 'deathPlace'),
    school: text(raw.school, 'school'), education: text(raw.education, 'education'),
    occupation: text(raw.occupation, 'occupation'), workplace: text(raw.workplace, 'workplace'),
    phone: phoneField(raw.phone), email: emailField(raw.email), address: text(raw.address, 'address'), docs: cleanDocs(raw.docs, treeId, true),
    bio: text(raw.bio, 'bio'), photo,
    parents: ids(raw.parents, 4, 'Родители'), spouses: ids(raw.spouses, 12, 'Супруги'), siblings: ids(raw.siblings, 30, 'Братья и сёстры'),
    marriages: marriages(raw.marriages),
  };
}

/** Мягкая очистка для миграции и импорта: не бросает на мусорных данных. */
export function lenientPerson(raw, treeId, fallbackId) {
  const o = { ...(raw || {}) };
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) o.id = fallbackId;
  if (!String(o.name ?? '').trim()) o.name = 'Без имени';
  // старый формат: место хранилось в начале биографии как «[место]\n»
  const m = /^\[([^\]\n]{1,200})\]\n/.exec(String(o.bio ?? ''));
  if (m) { if (!o.birthPlace) o.birthPlace = m[1]; o.bio = String(o.bio).slice(m[0].length); }
  o.docs = cleanDocs(raw.docs, treeId, false);
  // контакты при импорте: мусор отбрасываем, а не отказываем целиком
  o.email = String(o.email ?? '').split(/[\s,;]+/).filter(x => EMAIL_RE.test(x)).join(', ');
  o.phone = (PHONE_RE.test(String(o.phone ?? '')) && /\p{N}/u.test(String(o.phone))) ? String(o.phone) : '';
  for (const k of ['name', 'maidenName', 'birthPlace', 'deathPlace', 'school', 'education', 'occupation', 'workplace', 'phone', 'email', 'address', 'bio']) {
    const s = String(o[k] ?? '');
    o[k] = s.length > LIMITS[k] ? s.slice(0, LIMITS[k]) : s;
  }
  for (const k of ['birth', 'death']) { const s = String(o[k] ?? '').replace(CTRL, '').trim(); o[k] = DATE_RE.test(s) ? s : s.replace(/[^\p{L}\p{N}\s.\-/~≈?]/gu, '').slice(0, 32); }
  for (const [k, max] of [['parents', 4], ['spouses', 12], ['siblings', 30]]) {
    o[k] = (Array.isArray(o[k]) ? o[k] : []).filter(x => typeof x === 'string' && ID_RE.test(x)).slice(0, max);
  }
  o.marriages = (Array.isArray(o.marriages) ? o.marriages : []).filter(m => m && typeof m.with === 'string' && ID_RE.test(m.with)).map(m => ({ with: m.with, date: String(m.date ?? '').slice(0, 32) }));
  return cleanPerson(o, treeId);
}

export const cleanTreeName = v => {
  const s = String(v ?? '').replace(CTRL, '').trim();
  if (!s) throw new HttpError(400, 'Укажите название древа');
  if (s.length > 120) throw new HttpError(400, 'Название древа длиннее 120 символов');
  return s;
};
