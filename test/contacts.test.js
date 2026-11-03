import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPerson, lenientPerson, fillDefaults } from '../lib/validate.js';
import { buildExportEntries, offlineHtml } from '../lib/export.js';
import { searchPeople } from '../public/js/util.js';

const ID = 'a'.repeat(8) + '-aaaa-4aaa-8aaa-' + 'a'.repeat(12), T = 'b'.repeat(8) + '-bbbb-4bbb-8bbb-' + 'b'.repeat(12);
const base = (o = {}) => ({ id: ID, name: 'Елена Родова', sex: 'f', ...o });

test('контакты: нормальные значения сохраняются, e-mail нормализуется', () => {
  const p = cleanPerson(base({ phone: '+380 (50) 123-45-67, 044 555 66 77', email: 'a@b.co;  c.d@e-f.org', address: 'Киев, ул. Лесная, 5, кв. 12' }), T);
  assert.equal(p.phone, '+380 (50) 123-45-67, 044 555 66 77');
  assert.equal(p.email, 'a@b.co, c.d@e-f.org');
  assert.equal(p.address, 'Киев, ул. Лесная, 5, кв. 12');
  const empty = cleanPerson(base(), T); assert.deepEqual([empty.phone, empty.email, empty.address], ['', '', '']);
});
test('контакты: мусор и опасные значения отклоняются понятной ошибкой', () => {
  for (const [f, v, re] of [['email', 'не-адрес', /не похоже на адрес/], ['email', 'a@b', /не похоже/], ['email', 'x@y.org, <script>@x.io', /не похоже/], ['phone', 'позвонить', /Телефон/], ['phone', '123<script>', /Телефон/], ['address', 'я'.repeat(301), /длиннее 300/], ['phone', '1'.repeat(81), /длиннее 80/]])
    assert.throws(() => cleanPerson(base({ [f]: v }), T), re, f + ': ' + v.slice(0, 20));
});
test('контакты: при импорте мусор отбрасывается, а не ломает загрузку; старые карточки получают пустые поля', () => {
  const p = lenientPerson(base({ phone: 'нет', email: 'ok@x.io, мусор, ещё@', address: 'я'.repeat(500) }), T, ID);
  assert.equal(p.phone, ''); assert.equal(p.email, 'ok@x.io'); assert.equal(p.address.length, 300);
  const old = fillDefaults({ id: ID, name: 'Старая' }); assert.deepEqual([old.phone, old.email, old.address], ['', '', '']);
});
const tree = () => ({ id: T, name: 'Семья', people: { [ID]: { ...fillDefaults(base({ phone: '+380501234567', email: 'e@x.io', address: 'Киев, ул. Лесная, 5' })), parents: [], spouses: [], siblings: [], marriages: [] } } });
test('контакты попадают в экспорт Obsidian и офлайн-страницу', () => {
  const md = buildExportEntries(tree(), '/nonexistent').find(e => e.name.endsWith('.md') && e.name.includes('People'));
  const text = String(md.data);
  assert.match(text, /phone: "\+380501234567"/); assert.match(text, /email: "e@x\.io"/); assert.match(text, /address: "Киев, ул\. Лесная, 5"/);
  assert.match(text, /- Телефон: \+380501234567/); assert.match(text, /- Адрес проживания: Киев, ул\. Лесная, 5/);
  const html = offlineHtml(tree()); assert.ok(html.includes('Телефон:') && html.includes('Киев, ул. Лесная, 5'));
});
test('поиск находит человека по адресу и e-mail', () => {
  const list = Object.values(tree().people);
  assert.equal(searchPeople(list, 'лесная').length, 1);
  assert.equal(searchPeople(list, 'e@x.io').length, 1);
  assert.equal(searchPeople(list, '+380 50 123').length, 1, 'начало номера находит');
  assert.equal(searchPeople(list, '50123').length, 0, 'короткие цифры (меньше 6) телефоном не считаются');
  assert.equal(searchPeople(list, '50 123 4567').length, 1, 'по телефону без кода страны и с пробелами');
  assert.equal(searchPeople(list, '1930').length, 0, 'четыре цифры — это год, а не телефон');
  assert.equal(searchPeople(list, 'неттакого').length, 0);
});
