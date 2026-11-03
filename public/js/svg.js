// Автономный SVG древа: «плакат» для печати и офлайн-страница в архиве.
import { esc, lifeText, ageText, parseDate } from './util.js';

export function wrapName(name, max = 17, lines = 2) {
  const out = []; let cur = '';
  for (const w of String(name || '').split(/\s+/).filter(Boolean)) {
    if ((cur + ' ' + w).trim().length <= max) cur = (cur + ' ' + w).trim();
    else { if (cur) out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > lines) { out.length = lines; out[lines - 1] = out[lines - 1].slice(0, max - 1) + '…'; }
  return out.map(l => (l.length > max ? l.slice(0, max - 1) + '…' : l));
}

/**
 * @param {object} people   id → человек
 * @param {object} L        результат layout()
 * @param {{imageBase?:string, theme?:'light'|'dark', anchors?:boolean}} o
 *   imageBase — префикс для путей фото (например «Obsidian/media/»), без него рисуются инициалы
 *   anchors — оборачивать карточки в <a href="#p-<id>">
 */
export function treeSvg(people, L, o = {}) {
  const dark = o.theme === 'dark';
  const c = dark
    ? { bg: '#0F1A18', card: '#172623', line: '#2C403B', ink: '#E6EDE9', muted: '#8EA39B', edge: '#7E968D', gold: '#D2A857' }
    : { bg: '#EEF0EB', card: '#FBFBF8', line: '#D3D8CF', ink: '#0E2B28', muted: '#66756F', edge: '#8A9A92', gold: '#B38A3C' };
  const W = L.bounds.w, H = L.bounds.h, parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Manrope, 'Segoe UI', system-ui, sans-serif">`);
  parts.push(`<rect width="${W}" height="${H}" fill="${c.bg}"/>`);
  parts.push(`<g fill="none" stroke="${c.edge}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">`);
  for (const e of L.edges) parts.push(`<path d="${e.d}"/>`);
  parts.push('</g>');
  if (L.ticks?.length) { // режим «по годам»: горизонтальная шкала
    parts.push(`<g stroke="${c.line}" stroke-width="1" stroke-dasharray="4 6" fill="${c.muted}" font-size="11">`);
    for (const t of L.ticks) parts.push(`<line x1="0" x2="${W}" y1="${t.yc}" y2="${t.yc}"/><text x="8" y="${t.yc - 4}" stroke="none">${t.label}</text>`);
    parts.push('</g>');
  }
  parts.push(`<g fill="none" stroke="${c.muted}" stroke-width="1.4" stroke-dasharray="3 4">`);
  for (const s of L.siblingLinks || []) parts.push(`<path d="${s.d}"/>`);
  parts.push('</g>');
  parts.push(`<g fill="none" stroke="${c.gold}" stroke-width="2">`);
  for (const s of L.spouseLinks) parts.push(`<path d="${s.d}"/>`);
  parts.push('</g>');
  for (const s of L.spouseLinks) if (s.mx !== null) {
    parts.push(`<circle cx="${s.mx}" cy="${s.y}" r="4" fill="${c.gold}"/>`);
    const md = parseDate(people[s.a]?.marriages?.find(m => m.with === s.b)?.date);
    if (md) parts.push(`<text x="${s.mx}" y="${s.y - 8}" text-anchor="middle" font-size="9" fill="${c.gold}">${md.y}</text>`);
  }

  const clips = [];
  for (const n of L.nodes) {
    const p = people[n.id]; if (!p) continue;
    const { x, y, w, h } = n, stripe = p.sex === 'f' ? '#B8665C' : '#5F8798';
    const dead = (p.death || '').trim();
    const lines = wrapName(p.name);
    const tag = o.anchors ? ['<a href="#p-' + esc(p.id) + '">', '</a>'] : ['', ''];
    parts.push(tag[0]);
    parts.push(`<rect x="${x + .5}" y="${y + .5}" width="${w - 1}" height="${h - 1}" rx="8" fill="${c.card}" stroke="${c.line}"/>`);
    parts.push(`<path d="M${x + 8} ${y + 1.5}H${x + w - 8}" stroke="${stripe}" stroke-width="3" stroke-linecap="round"/>`);
    if (n.est) parts.push(`<text x="${x + w - 30}" y="${y + 70}" font-size="10" fill="${c.muted}" opacity=".8">~год</text>`);
    if (dead) parts.push(`<path d="M${x + w - 22} ${y + .5}H${x + w - 8.5}A8 8 0 0 1 ${x + w - .5} ${y + 8.5}V${y + 22}Z" fill="#1B1B1A"/>`);
    const cx = x + 32, cy = y + 36;
    if (o.imageBase && p.photo) {
      const id = 'c' + clips.length; clips.push(id);
      parts.push(`<clipPath id="${id}"><circle cx="${cx}" cy="${cy}" r="19"/></clipPath>`);
      parts.push(`<image href="${esc(o.imageBase + p.photo.split('/').pop())}" x="${cx - 19}" y="${cy - 19}" width="38" height="38" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id})"/>`);
    } else {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="19" fill="${dark ? '#22362F' : '#E7EAE3'}"/>`);
      parts.push(`<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="15" font-weight="700" fill="${c.muted}">${esc((p.name || '?').trim()[0] || '?')}</text>`);
    }
    lines.forEach((l, i) => parts.push(`<text x="${x + 58}" y="${y + 30 + i * 16}" font-family="'Playfair Display', Georgia, serif" font-size="13.5" font-weight="600" fill="${c.ink}">${esc(l)}</text>`));
    const life = lifeText(p), age = ageText(p);
    if (life) parts.push(`<text x="${x + 12}" y="${y + 70}" font-size="11" fill="${c.muted}">${esc(life)}${age ? ' · ' + esc(age) : ''}</text>`);
    const sub = p.maidenName ? 'урожд. ' + p.maidenName : p.occupation || p.birthPlace || '';
    if (sub) parts.push(`<text x="${x + 12}" y="${y + 86}" font-size="10" fill="${c.muted}" opacity=".8">${esc(sub.length > 30 ? sub.slice(0, 29) + '…' : sub)}</text>`);
    parts.push(tag[1]);
  }
  parts.push('</svg>');
  return parts.join('\n');
}
