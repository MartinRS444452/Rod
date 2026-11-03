import path from 'node:path';
import fs from 'node:fs';
import { layout, assignGenerations, relatives } from '../public/js/layout.js';
import { treeSvg } from '../public/js/svg.js';
import { esc, lifeText, ageText, roman, marriageInfo } from '../public/js/util.js';

const slug = s => String(s || 'Без имени').replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'person';
export const fileBase = p => `${slug(p.name)}-${p.id.slice(0, 6)}`;
const label = s => String(s || '').replace(/[|[\]#^]/g, ' ').replace(/\s+/g, ' ').trim();
const link = p => `[[${fileBase(p)}|${label(p.name)}]]`;
const q = s => JSON.stringify(String(s ?? ''));

const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g' };
/** ASCII-имя файла: надёжно скачивается во всех браузерах (транслитерация названия древа). */
export const exportFileName = tree => {
  const t = [...String(tree.name).toLowerCase()].map(ch => TR[ch] ?? ch).join('').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return `rod-${t || 'tree'}-r${tree.rev}.zip`;
};

function personMd(p, people) {
  const rel = relatives(people, p.id);
  const L = ids => ids.map(id => people[id]).filter(Boolean);
  const fm = ['---', `title: ${q(p.name)}`, `aliases: [${[p.name, ...(p.maidenName ? [`${p.name} (урожд. ${p.maidenName})`] : [])].map(q).join(', ')}]`, `person_id: ${q(p.id)}`, `sex: ${q(p.sex)}`];
  const add = (k, v) => { if (v) fm.push(`${k}: ${q(v)}`); };
  add('maiden_name', p.maidenName);
  add('born', p.birth); add('died', p.death); add('birth_place', p.birthPlace); add('death_place', p.deathPlace);
  add('school', p.school); add('education', p.education); add('occupation', p.occupation); add('workplace', p.workplace);
  add('phone', p.phone); add('email', p.email); add('address', p.address);
  for (const [k, ids] of [['parents', rel.parents], ['spouses', rel.spouses], ['siblings', rel.siblings], ['children', rel.children]]) {
    if (ids.length) fm.push(`${k}: [${L(ids).map(x => q(link(x))).join(', ')}]`);
  }
  const wed = (p.marriages || []).filter(m => people[m.with]);
  if (wed.length) fm.push(`marriages: [${wed.map(m => q(`${link(people[m.with])} — ${m.date}`)).join(', ')}]`);
  fm.push('tags: [person]', '---', '');
  const out = [...fm, `# ${p.name}`, ''];
  if (p.photo) out.push(`![[${p.photo.split('/').pop()}|320]]`, '');
  const docs = (p.docs || []).filter(d => d.file);
  const life = lifeText(p), age = ageText(p);
  if (life) out.push(`**${life}**${age ? ` · ${age}` : ''}`, '');
  const facts = [['Девичья фамилия', p.maidenName], ['Место рождения', p.birthPlace], ['Место смерти / захоронения', p.deathPlace], ['Школа', p.school], ['Образование', p.education], ['Профессия', p.occupation], ['Место работы', p.workplace], ['Телефон', p.phone], ['E-mail', p.email], ['Адрес проживания', p.address]]
    .filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`);
  if (facts.length) out.push(...facts, '');
  if (p.bio) out.push('## Биография', '', p.bio, '');
  const sections = [['Родители', rel.parents], ['Супруги', rel.spouses], ['Братья и сёстры', rel.siblings], ['Дети', rel.children]].filter(([, ids]) => ids.length);
  if (sections.length) {
    out.push('## Родственные связи', '');
    const wedding = x => { const m = (p.marriages || []).find(w => w.with === x.id); if (!m) return ''; const mi = marriageInfo(p, x, m.date); return ` — свадьба ${m.date}${mi ? ` (${mi.years} лет вместе${mi.jubilee ? ', ' + mi.jubilee : ''})` : ''}`; };
    for (const [t, ids] of sections) out.push(`### ${t}`, ...L(ids).map(x => `- ${link(x)}${t === 'Супруги' ? wedding(x) : ''}`), '');
  }
  if (docs.length) out.push('## Документы', ...docs.map(d => `- [[${d.file.split('/').pop()}|${(d.title || d.name || 'Документ').replace(/[\]|[]/g, ' ')}]]${d.kind ? ` — ${d.kind}` : ''}`), '');
  return out.join('\n');
}

function indexMd(tree) {
  const g = assignGenerations(tree.people), byGen = {};
  for (const p of Object.values(tree.people)) (byGen[g[p.id]] ??= []).push(p);
  const out = [`# ${tree.name}`, '', `Участников: ${Object.keys(tree.people).length}. Экспорт из «Род», ревизия r${tree.rev}.`, ''];
  Object.keys(byGen).map(Number).sort((a, b) => a - b).forEach((k, i) => {
    out.push(`## Поколение ${roman(i + 1)}`, '');
    for (const p of byGen[k].sort((a, b) => a.name.localeCompare(b.name, 'ru'))) out.push(`- ${link(p)}${lifeText(p) ? ' — ' + lifeText(p) : ''}`);
    out.push('');
  });
  return out.join('\n');
}

export function offlineHtml(tree) {
  const people = tree.people, L = layout(people);
  const svg = treeSvg(people, L, { imageBase: 'Obsidian/media/', anchors: true });
  const g = assignGenerations(people);
  const order = Object.values(people).sort((a, b) => g[a.id] - g[b.id] || a.name.localeCompare(b.name, 'ru'));
  const cards = order.map(p => {
    const rel = relatives(people, p.id);
    const wd = id => { const m = (p.marriages || []).find(w => w.with === id); return m ? ` <span class="life">(свадьба ${esc(m.date)})</span>` : ''; };
    const refs = (t, ids) => ids.length ? `<p><b>${t}:</b> ${ids.map(id => `<a href="#p-${esc(id)}">${esc(people[id].name)}</a>${t === 'Супруги' ? wd(id) : ''}`).join(', ')}</p>` : '';
    const facts = [['Девичья фамилия', p.maidenName], ['Место рождения', p.birthPlace], ['Место смерти', p.deathPlace], ['Школа', p.school], ['Образование', p.education], ['Профессия', p.occupation], ['Место работы', p.workplace], ['Телефон', p.phone], ['E-mail', p.email], ['Адрес проживания', p.address]]
      .filter(([, v]) => v).map(([k, v]) => `<li><b>${k}:</b> ${esc(v)}</li>`).join('');
    const photo = p.photo ? `<img src="Obsidian/media/${esc(p.photo.split('/').pop())}" alt="${esc(p.name)}" loading="lazy">` : '';
    return `<article id="p-${esc(p.id)}">${photo}<div><h3>${esc(p.name)}</h3><p class="life">${esc(lifeText(p))}${ageText(p) ? ' · ' + esc(ageText(p)) : ''}</p>${facts ? `<ul>${facts}</ul>` : ''}${(p.docs || []).length ? `<p class="docs">Документы: ${p.docs.map(d => `<a href="Obsidian/media/${esc(d.file.split('/').pop())}">${esc(d.title || d.name || 'Документ')}</a>`).join(', ')}</p>` : ''}${p.bio ? `<p class="bio">${esc(p.bio)}</p>` : ''}${refs('Родители', rel.parents)}${refs('Супруги', rel.spouses)}${refs('Братья и сёстры', rel.siblings)}${refs('Дети', rel.children)}</div></article>`;
  }).join('\n');
  return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(tree.name)} — офлайн</title>
<style>:root{color-scheme:light dark;--bg:#EEF0EB;--card:#FBFBF8;--ink:#0E2B28;--mut:#66756F;--line:#D3D8CF;--gold:#B38A3C}
@media(prefers-color-scheme:dark){:root{--bg:#0F1A18;--card:#172623;--ink:#E6EDE9;--mut:#8EA39B;--line:#2C403B;--gold:#D2A857}}
body{margin:0;font:15px/1.55 system-ui,sans-serif;background:var(--bg);color:var(--ink)}
header{padding:20px 24px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font:600 26px Georgia,serif;margin:0;flex:1}h3{font:600 20px Georgia,serif;margin:0 0 2px}
button{font:inherit;padding:6px 12px;border:1px solid var(--line);background:var(--card);color:var(--ink);border-radius:6px;cursor:pointer}
#wrap{overflow:auto;height:62vh;border-bottom:1px solid var(--line)}#wrap svg{display:block}
section{max-width:860px;margin:0 auto;padding:24px}
article{display:flex;gap:18px;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;margin:0 0 14px;scroll-margin-top:12px}
article:target{outline:2px solid var(--gold)}article img{width:120px;height:120px;object-fit:cover;border-radius:6px;flex:none}
.life{color:var(--mut);margin:0 0 8px}.bio{white-space:pre-wrap}ul{padding-left:18px;margin:6px 0}a{color:inherit;text-decoration-color:var(--gold)}
@media(max-width:600px){article{flex-direction:column}}</style></head><body>
<header><h1>${esc(tree.name)}</h1><button id="zo">−</button><button id="zi">+</button><button id="zf">По ширине</button></header>
<div id="wrap">${svg}</div>
<section><h2>Все участники (${order.length})</h2>${cards}</section>
<script>(function(){var s=document.querySelector('#wrap svg'),w=s.getAttribute('width')*1,k=1;
function ap(){s.setAttribute('width',w*k);s.setAttribute('height',s.getAttribute('viewBox').split(' ')[3]*k)}
document.getElementById('zi').onclick=function(){k*=1.25;ap()};document.getElementById('zo').onclick=function(){k/=1.25;ap()};
document.getElementById('zf').onclick=function(){k=document.getElementById('wrap').clientWidth/w;ap()};
if(w>document.body.clientWidth){k=document.getElementById('wrap').clientWidth/w;if(k<.35)k=.35;ap()}})();</script></body></html>`;
}

/** Собирает список файлов для ZIP. mediaDir — каталог оригиналов фото для этого древа. */
export function buildExportEntries(tree, mediaDir) {
  const people = tree.people, entries = [];
  const used = new Set();
  const addMedia = p => {
    if (!p.photo) return;
    const base = path.basename(p.photo), abs = path.join(mediaDir, base);
    if (!used.has(base) && fs.existsSync(abs)) { used.add(base); entries.push({ name: `Obsidian/media/${base}`, file: abs }); }
  };
  entries.push({ name: 'README.md', data: readme(tree) });
  entries.push({ name: 'tree.json', data: JSON.stringify({ format: 'rod-tree', version: 2, exportedAt: new Date().toISOString(), id: tree.id, name: tree.name, rev: tree.rev, people }, null, 2) });
  entries.push({ name: 'tree.html', data: offlineHtml(tree) });
  entries.push({ name: `Obsidian/${slug(tree.name)}.md`, data: indexMd(tree) });
  entries.push({ name: 'Obsidian/.obsidian/app.json', data: JSON.stringify({ attachmentFolderPath: 'media', useMarkdownLinks: false, newLinkFormat: 'shortest' }, null, 2) });
  for (const p of Object.values(people)) {
    entries.push({ name: `Obsidian/People/${fileBase(p)}.md`, data: personMd(p, people) });
    addMedia(p);
    for (const d of p.docs || []) addMedia({ photo: d.file });
  }
  return entries;
}

const readme = tree => `# ${tree.name}

Архив из приложения «Род» (ревизия r${tree.rev}, ${Object.keys(tree.people).length} участников).

- **tree.html** — офлайн-версия: откройте двойным щелчком, интернет не нужен.
- **tree.json** — полные данные древа. Можно загрузить обратно через «Импорт» в «Род».
- **Obsidian/** — готовое хранилище: в Obsidian выберите «Открыть папку как хранилище» и укажите эту папку.
  Каждый человек — заметка со связями [[двойными ссылками]] (родители, супруги, братья/сёстры, дети),
  фотографии и вложенные документы (PDF, сканы) лежат в Obsidian/media/ в исходном виде.
`;
