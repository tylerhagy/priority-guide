#!/usr/bin/env node
/*
 * browser-test.mjs — drives the real app in Chromium against the real fixture.
 *
 * The File System Access API needs a user gesture and a real folder, so this
 * installs an in-memory folder handle before the module boots. Everything after
 * that point is the actual application code, not a stand-in for it.
 *
 * Playwright is optional. If it is not installed this exits 0 with a note —
 * test.mjs is the gate that must always run.
 */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let chromium;
const grab = (m) => (m && m.chromium) || (m && m.default && m.default.chromium) || null;
for (const spec of ['playwright', 'playwright-core', '@playwright/test']) {
  try { chromium = grab(await import(require.resolve(spec))); if (chromium) break; } catch { /* try the next */ }
}
if (!chromium && process.env.PLAYWRIGHT_PATH) {
  try { chromium = grab(await import(process.env.PLAYWRIGHT_PATH)); } catch { /* still none */ }
}
if (!chromium) {
  console.log('  playwright not installed — skipping browser tests (npm i -D playwright)');
  process.exit(0);
}

const PORT = 8154;
const FILE = readFileSync(path.join(HERE, 'fixtures', 'deskline.md'), 'utf8');

const server = spawn('python3', ['serve.py', String(PORT)], { cwd: HERE, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 900));

let pass = 0;
const fails = [];
const ok = (n, c, d) => { if (c) pass++; else fails.push(`${n}${d ? `\n       ${d}` : ''}`); };
const eq = (n, a, b) => ok(n, a === b, `expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.addInitScript((text) => {
  const store = { 'Priority Guides.md': text };
  const fileHandle = (name) => ({
    kind: 'file', name,
    getFile: async () => ({ text: async () => store[name] }),
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    createWritable: async () => ({
      write: async (t) => { store[name] = t; window.__written = t; },
      close: async () => {}
    })
  });
  const dir = {
    kind: 'directory', name: 'Priority Guides',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    entries: async function* () { for (const n of Object.keys(store)) yield [n, fileHandle(n)]; }
  };
  window.showDirectoryPicker = async () => dir;
  window.__store = store;
}, FILE);

await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector('#stage');
await page.click('.hello .btn.primary');
await page.waitForSelector('.item', { timeout: 8000 });

const text = (sel) => page.$eval(sel, (n) => n.textContent.trim()).catch(() => null);
const count = (sel) => page.$$eval(sel, (n) => n.length);
const written = () => page.evaluate(() => window.__written || null);
const current = () => page.evaluate(() => window.__store['Priority Guides.md']);
const line = async (prefix) => (await current()).split('\n').find((l) => l.startsWith(prefix)) || '';
let saveNo = 0;
const save = async () => {
  saveNo++;
  await page.keyboard.down('Meta'); await page.keyboard.press('s'); await page.keyboard.up('Meta');
  await page.waitForTimeout(400);
  // A save that does not settle means the app refused it or never heard it.
  const st = await page.$eval('#save', (n) => n.textContent.trim());
  ok(`save ${saveNo} settles`, st === 'Saved' || st === 'Read-only', `button says "${st}"`);
};
/** Click the item whose label contains this text. */
const pick = (needle) => page.evaluate((s) => {
  const it = [...document.querySelectorAll('.item')].find((n) => n.textContent.includes(s));
  if (!it) return false;
  it.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
}, needle);
const hasItem = (needle) => page.evaluate((s) =>
  [...document.querySelectorAll('.item')].some((n) => n.textContent.includes(s)), needle);
/** Type into the inline-editable node of the selected row. */
const typeInto = async (sel, value) => {
  await page.$eval(sel, (n, v) => {
    n.focus();
    n.textContent = v;
    n.blur();
  }, value);
  await page.waitForTimeout(200);
};
const panel = (i) => page.evaluate((k) => document.querySelectorAll('#railR .ptabs button')[k].click(), i);
/** Open an overflow menu and click the item whose label contains this text. */
const menu = async (openSel, label) => {
  await page.evaluate((sel) => document.querySelector(sel).click(), openSel);
  await page.waitForSelector('.menu', { timeout: 4000 });
  await page.evaluate((t) => {
    const b = [...document.querySelectorAll('.mitem')].find((n) => n.textContent.includes(t));
    if (!b) throw new Error('no menu item: ' + t);
    b.click();
  }, label);
  await page.waitForTimeout(300);
};
const openFn = (needle) => page.evaluate((s) => {
  const it = [...document.querySelectorAll('.item')].find((n) => n.textContent.includes(s));
  const row = it && it.closest('.cell');
  const fn = row && row.nextElementSibling && row.nextElementSibling.querySelector('.fn');
  if (!fn) return false;
  fn.click();
  return true;
}, needle);

function diffCount(after) {
  const a = FILE.split('\n');
  const b = after.split('\n');
  let n = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
}

// ---------------------------------------------------------------- opening
ok('the file opens without a read-only banner', (await count('.banner.err')) === 0);
eq('every guide is listed', await count('#railL .g-item'), 6);
eq('the page header says which guide you are on', await text('#pagehead h1'), 'Bookings — My Week');
ok('and how much of it there is, without repeating what the panel already says',
  (await text('#pagehead .sub')).includes('13 blocks')
  && !(await text('#pagehead .sub')).includes('Everyone with a desk'));
ok('the guide itself carries no context block', await page.$('.guide .ghead') === null);
eq('its blocks render as items in the stack', await count('.item'), 13);
ok('the open count is shown', (await text('#open')).includes('11 open'));

// ---------------------------------------------------------------- the three lanes
ok('the guide is a three-lane grid',
  await page.$eval('.guide', (n) => getComputedStyle(n).gridTemplateColumns.split(' ').length === 3));
ok('the stack sits in the middle lane',
  await page.$eval('.cell', (n) => getComputedStyle(n).gridColumnStart === '2'));
ok('notes annotate from the left', (await count('.lane-l .note')) >= 3);
ok('functionality annotates from the right', (await count('.lane-r .fn:not(.empty)')) >= 8);
ok('each annotation is joined to its row by a leader', (await count('.lead')) >= 10);
ok('an action item is styled as one', (await count('.lane-l .note.act')) >= 1);
ok('a row can carry more than one note',
  await page.evaluate(() => [...document.querySelectorAll('.notes')].some((n) => n.querySelectorAll('.note').length > 1)));
ok('a tall annotation does not tear a hole in the section panel',
  await page.evaluate(() => [...document.querySelectorAll('.band')]
    .filter((b) => !b.parentElement.classList.contains('top') && !b.parentElement.classList.contains('bot'))
    .every((b) => Math.abs(b.getBoundingClientRect().height - b.parentElement.getBoundingClientRect().height) < 2)));

// ---------------------------------------------------------------- the stack itself
ok('a data point with no control is plain text, not a box', (await count('.item.plain')) >= 4);
ok('a field with a form type renders as a control',
  (await count('.item:not(.plain):not(.linky):not(.visual)')) >= 1);
ok('a link renders as a link', (await count('.item.linky')) >= 2);
ok('a visual is marked as one', (await count('.item.visual')) >= 1);
ok('a select shows it has more behind it', (await count('.item .chev')) >= 1);
ok('the example sits under the name it belongs to, in the middle',
  await page.evaluate(() => {
    const it = [...document.querySelectorAll('.item')].find((n) => n.textContent.includes('Riverside, Northgate, Depot'));
    return !!it && !!it.querySelector('.lbl') && !!it.querySelector('.eg')
      && it.querySelector('.lbl').textContent.trim() === 'Building';
  }));
ok('and never in the functionality lane',
  await page.evaluate(() => ![...document.querySelectorAll('.lane-r')]
    .some((n) => n.textContent.includes('Riverside, Northgate, Depot'))));

// ---------------------------------------------------------------- icons
ok('functionality carries an icon', (await count('.fn .l svg')) >= 8);
ok('and says in plain words what the thing does',
  await page.evaluate(() => [...document.querySelectorAll('.fn')].some((n) => n.textContent.includes('Opens'))
    && [...document.querySelectorAll('.fn')].some((n) => n.textContent.includes('Takes one from a list'))
    && [...document.querySelectorAll('.fn')].some((n) => n.textContent.includes('Downloads a file'))));
ok('capabilities stay as words, which read faster than four unlearned glyphs',
  await page.evaluate(() => [...document.querySelectorAll('.fn .caps')].some((n) => n.textContent.includes('filter'))));

// ---------------------------------------------------------------- routes
ok('a route renders as a link to the guide it goes to',
  await page.$('.fn a.tgt[data-goto="Booking detail"]') !== null);
await page.click('.fn a.tgt[data-goto="Booking detail"]');
await page.waitForTimeout(250);
eq('following a route opens that guide', await text('#pagehead h1'), 'Booking detail');

// ---------------------------------------------------------------- a source on one block
ok('a source cited from one block shows as a note on that block',
  await page.evaluate(() => [...document.querySelectorAll('.lane-l .note')]
    .some((n) => n.textContent.includes('Why references are 4 digits'))));

await page.evaluate(() => {
  const b = [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Bookings'));
  b.click();
});
await page.waitForTimeout(250);

// ---------------------------------------------------------------- moving a block
await pick('Status');
await page.keyboard.press('Escape');
await page.keyboard.press('Alt+ArrowUp');
await page.waitForTimeout(180);
await save();
ok('a save happened', !!(await written()));
let out = await current();
eq('moving a block one place changes two lines', out ? diffCount(out) : -1, 2);
eq('the line count does not change', out.split('\n').length, FILE.split('\n').length);
ok('the moved line is the original text, not a re-render',
  out.includes('| Status | Booked, Checked in, No-show, Cancelled | filter, sort |  |  | No-show is set by the door reader, never by a person<br>Cancelled bookings stay on the list for the rest of the day |'));

await page.keyboard.press('Alt+ArrowDown');
await page.waitForTimeout(180);
await save();
eq('moving it back restores the file exactly', await current(), FILE);

// ---------------------------------------------------------------- across a group
await pick('Nothing booked this week');
await page.keyboard.press('Escape');
await page.keyboard.press('Alt+ArrowUp');
await page.waitForTimeout(200);
ok('a block at the top of a group crosses into the one above',
  await page.evaluate(() => {
    const items = [...document.querySelectorAll('.item')].map((n) => n.textContent);
    const i = items.findIndex((t) => t.includes('Nothing booked this week'));
    const j = items.findIndex((t) => t.includes('Export the week'));
    return i > -1 && j > -1 && i > j;
  }));
await save();
await page.reload();
await page.waitForSelector('#stage');
await page.click('.hello .btn.primary').catch(() => {});
await page.waitForSelector('.item', { timeout: 8000 });
ok('the moved block survived the reload', await hasItem('Nothing booked this week'));

// ---------------------------------------------------------------- editing one cell
await pick('Building');
await page.waitForTimeout(200);
ok('there is no form to open — the row is edited where it sits',
  await page.$('.ed') === null);
const beforeEdit = await current();
await typeInto('.rowsel .eg', 'Riverside, Northgate, Depot, Kilmore');
await save();
const afterEdit = await current();
eq('editing the example changes exactly one line',
  afterEdit.split('\n').filter((l, i) => beforeEdit.split('\n')[i] !== l).length, 1);
ok('the edit is in the file', afterEdit.includes('Riverside, Northgate, Depot, Kilmore'));

const beforeName = await current();
await pick('Building');
await page.waitForTimeout(150);
await typeInto('.rowsel .lbl', 'Building or site');
await save();
eq('renaming a block changes exactly one line',
  (await current()).split('\n').filter((l, i) => beforeName.split('\n')[i] !== l).length, 1);
await pick('Building or site');
await page.waitForTimeout(150);
await typeInto('.rowsel .lbl', 'Building');
await save();

// ---------------------------------------------------------------- the referee, live
await pick('Building');
await page.waitForTimeout(150);
await typeInto('.rowsel .lbl', 'Building dropdown');
const flagText = await page.$$eval('.flag', (ns) => ns.map((n) => n.textContent).join(' | '));
ok('the referee flags a visual answer', flagText.includes('dropdown') && flagText.includes('visual answer'));
ok('and says what to ask instead', flagText.includes('one from a list'));
ok('but does not rewrite it', await hasItem('Building dropdown'));
await pick('Building dropdown');
await page.waitForTimeout(150);
await typeInto('.rowsel .lbl', 'Building');

// ---------------------------------------------------------------- the functionality picker
ok('clicking functionality opens a picker, not a form', await openFn('Status'));
await page.waitForSelector('.pop', { timeout: 4000 });
eq('it asks the three things functionality is', await count('.pop label'), 3);
ok('the form types offered are behaviour, never a visual solution',
  await page.$$eval('.pop select', (ns) => {
    const opts = [...ns[1].options].map((o) => o.value);
    return opts.includes('single select') && !opts.includes('dropdown');
  }));
ok('there is nothing to save', await page.$eval('.pop', (n) => !/save/i.test(n.textContent)));
const beforeFn = await current();
await page.$$eval('.pop .tog', (ns) => { ns.find((n) => n.textContent === 'edit').click(); });
await page.waitForTimeout(300);
await save();
eq('a change applies the moment it is made', (await current()).split('\n')
  .filter((l, i) => beforeFn.split('\n')[i] !== l).length, 1);
ok('and lands in the file', (await current()).includes('| Status | Booked, Checked in, No-show, Cancelled | filter, sort, edit |'));
ok('and saving does not dismiss the picker you are working in', await page.$('.pop') !== null);
await page.$$eval('.pop .tog', (ns) => { ns.find((n) => n.textContent === 'edit').click(); });
await page.waitForTimeout(300);
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok('escape closes the picker', await page.$('.pop') === null);

// ---------------------------------------------------------------- notes
const noteRows = await count('.note');
await pick('Status');
await page.waitForTimeout(150);
await page.click('.rowsel .addnote');
await page.waitForTimeout(200);
await typeInto('.rowsel .note:last-of-type .t', 'Half-days were cut in review');
eq('a note can be added to any row', await count('.note'), noteRows + 1);
await page.evaluate(() => {
  const n = [...document.querySelectorAll('.note')].find((x) => x.textContent.includes('Half-days were cut in review'));
  n.querySelector('.tools button').click();
});
await page.waitForTimeout(250);
ok('and turned into a follow-up in one click',
  await page.evaluate(() => [...document.querySelectorAll('.note.act')]
    .some((n) => n.textContent.includes('Half-days were cut in review'))));
await save();
ok('which the file records as an action item',
  (await current()).includes('ACTION: Half-days were cut in review'));
ok('several notes on one row are kept apart by a line break, not run together',
  (await current()).includes('the rest of the day<br>ACTION: Half-days were cut in review'));
await page.evaluate(() => {
  const n = [...document.querySelectorAll('.note')].find((x) => x.textContent.includes('Half-days were cut in review'));
  n.querySelectorAll('.tools button')[1].click();
});
await page.waitForTimeout(250);
eq('and deleted again', await count('.note'), noteRows);

// ---------------------------------------------------------------- the prose under a heading
await save();
const beforeProse = await current();
await page.$eval('.sec-note', (n) => { n.focus(); n.textContent = 'Likely a table. One row per booking.'; n.blur(); });
await page.waitForTimeout(250);
await save();
eq('the line under a section heading is editable like everything else',
  (await current()).split('\n').filter((l, i) => beforeProse.split('\n')[i] !== l).length, 1);
ok('and it is written back as the line it was',
  (await current()).includes('*Likely a table. One row per booking.*'));

// ---------------------------------------------------------------- section controls
ok('there is no toolbar bolted to the bottom of the screen', await page.$('#tools') === null);
ok('a section carries the same overflow button as everything else',
  await page.$('.cell.sechead .more') !== null);
await page.evaluate(() => document.querySelector('.cell.sechead .more').click());
await page.waitForSelector('.menu');
eq('holding everything that section can do', await count('.mitem'), 9);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

const blocksBefore = await count('.item');
await menu('.cell.sechead .more', 'Add content');
eq('adding content adds it to that section', await count('.item'), blocksBefore + 1);
ok('and starts you naming it', await page.evaluate(() => document.activeElement.className.includes('lbl')));
await typeInto('.rowsel .lbl', 'A new thing');
await save();
ok('which lands in the file', (await current()).includes('| A new thing |'));

await menu('.cell.sechead .more', 'Add a divider');
ok('a divider is a rule and nothing else', await page.$('.item.divider .rule') !== null);
await save();
ok('and the file says so plainly', (await current()).includes('| [Divider] |'));

const secBefore = await count('.sec-title');
await menu('.cell.sechead .more', 'Add a section below');
eq('a section can be added right after this one', await count('.sec-title'), secBefore + 1);
await page.evaluate(() => {
  const t = [...document.querySelectorAll('.sec-title')].find((n) => n.textContent === 'New section');
  t.closest('.cell').querySelector('.more').click();
});
await page.waitForSelector('.menu');
await page.evaluate(() => [...document.querySelectorAll('.mitem')].find((n) => n.textContent.includes('Delete section')).click());
await page.waitForTimeout(300);
eq('and deleted again', await count('.sec-title'), secBefore);

// ---------------------------------------------------------------- what a block is
await pick('A new thing');
await page.waitForTimeout(200);
eq('every row says what it is', await text('.rowsel .rowtools .kind'), 'text');
await page.evaluate(() => document.querySelector('.rowsel .rowtools .kind').click());
await page.waitForSelector('.kindpop');
ok('and offers the others', (await count('.kindopt')) === 3 && (await count('.chartopt')) === 7);
await page.evaluate(() => [...document.querySelectorAll('.chartopt')]
  .find((b) => b.textContent.includes('Pie')).click());
await page.waitForTimeout(300);
await save();
ok('a data visual records the kind that was chosen',
  (await current()).includes('| [Chart: pie] A new thing |'));

await pick('A new thing');
await page.waitForTimeout(200);
await page.click('.rowsel .addnote');
await page.waitForTimeout(250);
await typeInto('.rowsel .note.fresh .t', 'Ideas: split by building');
await save();
await pick('A new thing');
await page.waitForTimeout(200);
await page.evaluate(() => document.querySelector('.rowsel .rowtools .kind').click());
await page.waitForSelector('.kindpop');
await page.evaluate(() => [...document.querySelectorAll('.kindopt')]
  .find((b) => b.textContent.includes('Visual')).click());
await page.waitForTimeout(300);
await save();
ok('changing what a block is keeps its notes',
  (await current()).includes('| [Visual] A new thing |')
  && (await current()).includes('Ideas: split by building'),
  (await current()).split('\n').find((l) => l.includes('A new thing')));

// ---------------------------------------------------------------- a row moves by its own arrows
const orderNow = () => page.$$eval('.item .lbl', (ns) => ns.map((n) => n.textContent.trim()));
await pick('A new thing');
await page.waitForTimeout(200);
const beforeMove = (await orderNow()).indexOf('A new thing');
await page.evaluate(() => document.querySelector('.rowsel .rowtools button.ic').click());
await page.waitForTimeout(300);
eq('a row has arrows of its own', (await orderNow()).indexOf('A new thing'), beforeMove - 1);
await page.evaluate(() => document.querySelectorAll('.rowsel .rowtools button.ic')[1].click());
await page.waitForTimeout(300);
eq('in both directions', (await orderNow()).indexOf('A new thing'), beforeMove);

// ---------------------------------------------------------------- choosing a reference
await menu('.cell.sechead .more', 'Add a reference');
await page.waitForSelector('.refpop', { timeout: 4000 });
ok('a new reference asks what it points at rather than waiting to be typed',
  await page.$('.refpop input') !== null);
ok('and lists the guides with enough of each to tell them apart',
  (await count('.refopt')) >= 4 && (await page.$eval('.refopt .m', (n) => n.textContent.includes('blocks'))));
await page.fill('.refpop input', 'cancel');
await page.waitForTimeout(200);
eq('and it can be searched, which is the point at scale', await count('.refopt'), 1);
await page.click('.refopt');
await page.waitForTimeout(300);
await save();
ok('the file records a real link, not free text',
  (await current()).includes('> See [[Cancel a booking]]'));
ok('and the flow map picks it up as a reference',
  (await current()).split('\n').filter((l) => l.startsWith('> See')).length >= 3);
const refsInFile = (t) => t.split('\n').filter((l) => l.startsWith('> See')).length;
const refsBeforeRemoval = refsInFile(await current());
await page.evaluate(() => {
  const r = [...document.querySelectorAll('.ref')].pop();
  if (r && r.querySelector('.refx')) r.querySelector('.refx').click();
});
await page.waitForTimeout(250);
await save();
eq('and it can be removed again', refsInFile(await current()), refsBeforeRemoval - 1);

// ---------------------------------------------------------------- renaming a role
await panel(0);
await page.waitForTimeout(200);
const before = await current();
await page.$eval('#railR .chip .nm', (n) => { n.focus(); n.textContent = 'Deskworker'; n.blur(); });
await page.waitForTimeout(400);
await save();
const after = await current();
const changed = after.split('\n').filter((l, i) => before.split('\n')[i] !== l);
ok('renaming a role fixes it in every guide at once, not one at a time',
  changed.length >= 2 && changed.every((l) => l.startsWith('**Primary users:**')),
  JSON.stringify(changed.slice(0, 4)));
ok('and it says how many it touched', await page.$('.banner.info') !== null);
ok('so the Users view stops showing one group twice',
  !after.includes('Everyone with a desk'));

// ---------------------------------------------------------------- adding inside a section
await pick('Time');
await page.waitForTimeout(200);
ok('a block carries its own controls', await page.$('.rowsel .rowtools') !== null);
const posBefore = await page.evaluate(() =>
  [...document.querySelectorAll('.item .lbl')].map((n) => n.textContent.trim()).indexOf('Time'));
await page.evaluate(() => document.querySelectorAll('.rowsel .rowtools button.ic')[2].click());
await page.waitForTimeout(300);
await typeInto('.rowsel .lbl', 'Room or desk');
const posAfter = await page.evaluate(() =>
  [...document.querySelectorAll('.item .lbl')].map((n) => n.textContent.trim()).indexOf('Room or desk'));
eq('and it lands right there, not at the end of the section', posAfter, posBefore + 1);
await save();
ok('which the file records in that position', (await current()).includes('| Room or desk |'));

await pick('Room or desk');
await page.waitForTimeout(150);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
ok('Enter does the same thing, the way an outliner would',
  await page.evaluate(() => document.activeElement.className.includes('lbl')
    && document.activeElement.textContent.trim() === ''));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);

// ---------------------------------------------------------------- an example is optional
ok('a block with no example says nothing about it',
  await page.evaluate(() => {
    const it = [...document.querySelectorAll('.item')]
      .find((n) => n.querySelector('.lbl') && n.querySelector('.lbl').textContent.trim() === 'Room or desk');
    return !!it && !it.querySelector('.eg');
  }));
eq('and nothing on the guide is flagged for missing one', await count('.flag'), 0);
await pick('Room or desk');
await page.waitForTimeout(200);
await menu('.rowsel .rowtools .more', 'Add an example');
ok('but there is a quiet way to add one', await page.$('.rowsel .eg') !== null);
await typeInto('.rowsel .eg', 'Desk 4-118');
await save();
ok('and it lands in the file', (await current()).includes('| Room or desk | Desk 4-118 |'));

// ---------------------------------------------------------------- a row can be duplicated and removed
const dupBefore = await count('.item');
await pick('Who it is for');
await page.waitForTimeout(200);
await menu('.rowsel .rowtools .more', 'Duplicate');
eq('a block can be duplicated', await count('.item'), dupBefore + 1);
await save();
eq('with everything it carried, notes included',
  (await current()).split('\n')
    .filter((l) => l.startsWith('| Who it is for |') && l.includes('Only office managers')).length, 2);
await menu('.rowsel .rowtools .more', 'Delete block');
await save();
eq('and removed again',
  (await current()).split('\n')
    .filter((l) => l.startsWith('| Who it is for |') && l.includes('Only office managers')).length, 1);

// ---------------------------------------------------------------- note tools do not move the page
await pick('Status');
await page.waitForTimeout(200);
ok('the tools on a note sit inside it and out of flow, so hovering shifts nothing',
  await page.evaluate(() => {
    const note = document.querySelector('.lane-l .note');
    const before = note.getBoundingClientRect();
    const tools = note.querySelector('.tools');
    if (!tools) return false;
    if (getComputedStyle(tools).position !== 'absolute') return false;
    tools.style.opacity = '1';
    const after = note.getBoundingClientRect();
    return Math.abs(after.width - before.width) < 0.5 && Math.abs(after.height - before.height) < 0.5;
  }));

// ---------------------------------------------------------------- saving while typing
await pick('Status');
await page.waitForTimeout(200);
await page.$eval('.rowsel .lbl', (n) => { n.focus(); n.textContent = 'Status of the booking'; });
ok('the caret is in the field', await page.evaluate(() => document.activeElement.className.includes('lbl')));
await page.keyboard.down('Meta'); await page.keyboard.press('s'); await page.keyboard.up('Meta');
await page.waitForTimeout(500);
ok('Cmd-S works while you are typing, which is when you want it',
  (await current()).includes('| Status of the booking |'), await text('#save'));
await pick('Status of the booking');
await page.waitForTimeout(200);
await typeInto('.rowsel .lbl', 'Status');
await save();

// ---------------------------------------------------------------- capture
await page.keyboard.press('c');
await page.waitForSelector('#cap:not([hidden])');
await page.fill('#capIn', 'Occupancy right now');
await page.keyboard.press('Enter');
await page.waitForTimeout(180);
await page.fill('#capIn', 'Who booked it');
await page.keyboard.press('Enter');
await page.waitForTimeout(180);
ok('capture keeps taking lines without a form', (await text('#capTally')).includes('2 added'));
ok('the captured blocks are in the guide', await hasItem('Occupancy right now'));
await page.keyboard.press('Escape');
ok('escape closes capture', await page.$eval('#cap', (n) => n.hidden));

// ---------------------------------------------------------------- the guides rail
ok('clicking a guide goes to it — it does not start renaming it',
  await page.evaluate(async () => {
    const items = [...document.querySelectorAll('#railL .g-item')];
    const target = items.find((n) => !n.classList.contains('on'));
    const name = target.querySelector('.n').textContent.trim();
    target.click();
    await new Promise((r) => setTimeout(r, 250));
    return document.querySelector('#pagehead h1').textContent.trim() === name
      && !document.querySelector('#railL .n[contenteditable]');
  }));
await page.evaluate(() => document.querySelectorAll('#railL .g-item')[0].click());
await page.waitForTimeout(250);

const railNames = () => page.$$eval('#railL .g-item .n', (ns) => ns.map((n) => n.textContent.trim()));
const orderBefore = await railNames();
ok('everything else a guide can do is behind one button',
  await page.$('#railL .g-item .more') !== null);
await menu('#railL .g-item .more', 'Rename');
ok('rename happens on purpose, from that menu',
  await page.$('#railL .g-item.on .n[contenteditable]') !== null);
await typeInto('#railL .g-item.on .n', 'Renamed guide');
await save();
ok('and lands in the file', (await current()).includes('## Renamed guide'));
await menu('#railL .g-item .more', 'Rename');
await typeInto('#railL .g-item.on .n', orderBefore[0]);
await save();

await menu('#railL .g-item .more', 'Move down');
eq('the menu can still move one', (await railNames())[0], orderBefore[1]);
await page.evaluate(() => document.querySelectorAll('#railL .g-item')[1].querySelector('.more').click());
await page.waitForSelector('.menu');
await page.evaluate(() => [...document.querySelectorAll('.mitem')].find((n) => n.textContent.includes('Move up')).click());
await page.waitForTimeout(300);
eq('and back', JSON.stringify(await railNames()), JSON.stringify(orderBefore));

// reordering is dragging, because that is what a list of things affords
const railDrag = await page.evaluate(() => {
  const items = [...document.querySelectorAll('#railL .g-item')];
  const from = items[0], to = items[2];
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const r = to.getBoundingClientRect();
  to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
  to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  return [...document.querySelectorAll('#railL .g-item .n')].map((n) => n.textContent.trim());
});
eq('a guide can be dragged to a new position', railDrag[2], orderBefore[0]);
await save();
ok('which the file records',
  (await current()).indexOf('## ' + orderBefore[1]) < (await current()).indexOf('## ' + orderBefore[0]));

await page.evaluate((names) => {
  const item = [...document.querySelectorAll('#railL .g-item')].find((n) => n.textContent.includes(names[2]));
  item.querySelector('.more').click();
}, orderBefore);
await page.waitForSelector('.menu');
await page.evaluate(() => [...document.querySelectorAll('.mitem')].find((n) => n.textContent.includes('Delete guide')).click());
await page.waitForTimeout(300);
eq('and deleted', await count('#railL .g-item'), orderBefore.length - 1);
const guidesNow = await count('#railL .g-item');
await save();

// ---------------------------------------------------------------- the rail belongs to the guide view
await page.click('#tabs button:nth-child(2)');
await page.waitForTimeout(250);
ok('the guides rail steps aside for a file-wide view',
  await page.evaluate(() => getComputedStyle(document.getElementById('railL')).display === 'none'));
await page.click('#tabs button:nth-child(1)');
await page.waitForTimeout(250);
ok('and comes back with it',
  await page.evaluate(() => getComputedStyle(document.getElementById('railL')).display !== 'none'));

// ---------------------------------------------------------------- context, explained
await panel(0);
await page.waitForTimeout(200);
ok('a field can say what it means', (await count('#railR .ctx-h .info')) >= 2);
await page.evaluate(() => document.querySelector('#railR .ctx-h .info').click());
await page.waitForTimeout(200);
ok('and does, on request', await page.$('#railR .means') !== null);
await page.evaluate(() => document.querySelector('#railR .ctx-h .info').click());
await page.waitForTimeout(200);
ok('and stops again', await page.$('#railR .means') === null);

const notesBefore = await count('#railR .gnote');
await page.evaluate(() => [...document.querySelectorAll('#railR .ctx-add')]
  .find((b) => b.textContent.includes('note')).click());
await page.waitForTimeout(250);
await typeInto('#railR .gnote:last-of-type .t', 'Phase two only');
eq('guide notes are separate blocks, added one at a time',
  await count('#railR .gnote'), notesBefore + 1);
await save();
ok('and the file keeps them apart', (await current()).includes('<br>Phase two only'));
await page.evaluate(() => {
  const n = [...document.querySelectorAll('#railR .gnote')].find((x) => x.textContent.includes('Phase two only'));
  n.querySelector('.x').click();
});
await page.waitForTimeout(250);
eq('and one can be removed on its own', await count('#railR .gnote'), notesBefore);

// ---------------------------------------------------------------- users
await page.click('#tabs button:nth-child(3)');
await page.waitForSelector('.usr');
eq('every user type in the file is listed', await count('.usr'), 3);
ok('each names its guides', (await count('.usr .oi')) >= guidesNow);
ok('the group that uses the most screens comes first',
  await page.evaluate(() => {
    const counts = [...document.querySelectorAll('.usr')].map((u) => u.querySelectorAll('.oi').length);
    return counts.every((n, i) => i === 0 || n <= counts[i - 1]);
  }));
const topUser = await text('.usr .n');
ok('a guide says whether it is their main screen',
  await page.evaluate(() => [...document.querySelectorAll('.usr .oi')].some((n) => n.textContent.includes('their main screen'))));
await page.click('.usr .btn');
await page.waitForTimeout(300);
ok('picking a group is a filter, not a presentation', await page.$('#userbar') !== null);
ok('it lands you in the guide view, still able to move about',
  await page.evaluate(() => !document.body.classList.contains('present'))
  && (await text('#tabs button.on')) === 'Guide');
ok('and says whose set you are looking at', (await text('#userbar')).includes(topUser));
eq('the rail narrows to their screens', await count('#railL .g-item'), guidesNow);

await page.keyboard.press('p');
await page.waitForTimeout(250);
ok('presenting from there keeps the filter', await page.$('#userbar') !== null);
ok('and gives you a way to move between their screens in the room',
  (await count('#pagehead .nav')) === 2 && (await text('#pagehead .count')).includes('of'));
const firstGuide = await text('#pagehead h1');
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(250);
ok('the arrow keys walk the set', (await text('#pagehead h1')) !== firstGuide);
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(250);
eq('in both directions', await text('#pagehead h1'), firstGuide);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
await page.click('#userbar .quiet');
await page.waitForTimeout(250);
eq('clearing the filter brings every guide back', await count('#railL .g-item'), guidesNow);

// ---------------------------------------------------------------- open items
await page.click('#tabs button:nth-child(4)');
await page.waitForSelector('.oi');
const openN = await count('.oi');
eq('the list is exactly what the header counts as open',
  openN, Number((await text('#open')).match(/\d+/)[0]));
ok('and there is something in it', openN > 0);
ok('each says where it came from', await page.$$eval('.oi .w', (ns) => ns.every((n) => n.textContent.trim())));
eq('an action note counts once per note, not once per row',
  await count('.oi.act'),
  (await current()).split('\n').filter((l) => l.startsWith('|'))
    .reduce((n, l) => n + (l.match(/ACTION:/g) || []).length, 0));
await page.evaluate(() => document.querySelector('.oi.act').click());
await page.waitForTimeout(300);
ok('clicking an action item goes to the block it came from', (await count('.rowsel')) >= 1);

// ---------------------------------------------------------------- flow
await page.click('#tabs button:nth-child(2)');
await page.waitForSelector('#flow svg');
eq('every guide is a node', await count('#flow .node'), guidesNow);
ok('routes are drawn', (await count('#flow .edge:not(.ref)')) >= 5);
eq('references are drawn differently from routes, when they resolve',
  await count('#flow .edge.ref'),
  await (async () => {
    const t = await current();
    const names = t.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim());
    return t.split('\n')
      .map((l) => /^> See \[\[([^\]]+)\]\]/.exec(l))
      .filter((m) => m && names.includes(m[1].trim())).length;
  })());
ok('the panel steps out of the way of a file-wide view',
  await page.evaluate(() => getComputedStyle(document.getElementById('railR')).display === 'none'));

// ---------------------------------------------------------------- sources
await page.click('#tabs button:nth-child(1)');
await page.waitForTimeout(250);
eq('the panel has three tabs, all at the guide\'s own altitude', await count('#railR .ptabs button'), 3);
ok('context opens first, because it is what you need to read the guide',
  (await text('#railR .ptabs button.on')).startsWith('Context'));
ok('and it holds the goals, the users and the notes',
  (await text('#railR .pbody')).includes('User goal') && (await text('#railR .pbody')).includes('Primary users'));
await panel(1);
await page.waitForTimeout(200);
ok('the rail lists what is attached here', (await count('#railR .src')) >= 2);
ok('a source is a title you can click', (await count('#railR .src .title')) >= 2);
eq('and carries no number anyone has to interpret', await count('#railR .src .n'), 0);
ok('a web source is a real link', await page.$('#railR .src a.title[href^="http"]') !== null);
ok('a local path is not offered as a link that would fail',
  await page.evaluate(() => [...document.querySelectorAll('#railR .src .title')]
    .some((n) => n.tagName === 'BUTTON' && n.className.includes('pathlink'))));

const srcBefore = await count('#railR .src');
await page.click('#railR .rail-add');
await page.waitForSelector('.srcform');
eq('adding one asks for a title and a link, and nothing else', await count('.srcform input'), 2);
await page.$$eval('.srcform input', (ns) => {
  ns[0].value = 'Door reader spec';
  ns[0].dispatchEvent(new Event('input', { bubbles: true }));
  ns[1].value = 'https://example.com/doors';
  ns[1].dispatchEvent(new Event('input', { bubbles: true }));
});
await page.click('.srcform .btn.primary');
await page.waitForTimeout(300);
eq('the new source appears in the rail', await count('#railR .src'), srcBefore + 1);
await save();
ok('it lands in the file as a definition, with a handle nobody had to invent',
  (await current()).includes('[door-reader-spec]: https://example.com/doors "Door reader spec"'));
ok('and is attached to the guide it was added from',
  (await line('**Sources:**')).includes('[door-reader-spec]'), await line('**Sources:**'));

await page.evaluate(() => {
  const card = [...document.querySelectorAll('#railR .src')].find((n) => n.textContent.includes('Door reader spec'));
  card.querySelector('.x').click();
});
await page.waitForTimeout(250);
await save();
ok('detaching takes it off the guide', !(await line('**Sources:**')).includes('door-reader-spec'));
ok('but leaves the source in the file for anything else to use',
  (await current()).includes('[door-reader-spec]: https://example.com/doors'));

// ---------------------------------------------------------------- links tab
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Booking detail'));
  b.click();
});
await page.waitForTimeout(250);
await panel(2);
await page.waitForTimeout(200);
ok('the links tab says what this guide leads to', (await text('#railR .pbody')).includes('Goes to'));
ok('and what leads here — the thing a design tool cannot tell you',
  (await text('#railR .pbody')).includes('Referenced by') || (await text('#railR .pbody')).includes('Mentioned by'));
ok('each one is a way to get there', (await count('#railR .linkrow')) >= 2);
await page.click('#railR .linkrow');
await page.waitForTimeout(250);
ok('and following one moves the guide', (await text('#pagehead h1')).length > 0);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Bookings'));
  b.click();
});
await page.waitForTimeout(250);

// ---------------------------------------------------------------- primary users
await panel(0);
await page.waitForTimeout(200);
ok('primary users are discrete chips', (await count('#railR .chip:not(.add)')) >= 2);
ok('the power user is marked', (await count('#railR .chip.pri')) >= 1);
await page.evaluate(() => [...document.querySelectorAll('#railR .ctx-add')]
  .find((b) => b.textContent.includes('user')).click());
await page.waitForSelector('.chip input');
ok('adding one offers the types already in the file',
  await page.$eval('.chip input', (n) => n.getAttribute('list') === 'usertypes'));
ok('and those types are listed', (await count('#usertypes option')) >= 3);
await page.click('.chip input');
await page.type('.chip input', 'visitor host', { delay: 12 });
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
await save();
const userLines = (await current()).split('\n').filter((l) => l.startsWith('**Primary users:**'));
ok('a case-different match reuses the existing type instead of making a second one',
  userLines.some((l) => l.includes('Visitor host')) && !userLines.some((l) => l.includes('visitor host')),
  JSON.stringify(userLines));

// ---------------------------------------------------------------- present
await page.mouse.click(700, 300);
await page.waitForTimeout(150);
await page.keyboard.press('p');
await page.waitForTimeout(250);
eq('the present button becomes the way out', await text('#present'), 'Exit');
ok('present mode hides both rails',
  await page.evaluate(() => getComputedStyle(document.getElementById('railL')).display === 'none'));
ok('and the tabs, which are not for the room',
  await page.evaluate(() => getComputedStyle(document.getElementById('tabs')).display === 'none'));
ok('but the page header stays, so the room knows which screen this is',
  await page.evaluate(() => getComputedStyle(document.getElementById('pagehead')).display !== 'none'));
ok('the stack gets wider for a shared screen',
  await page.evaluate(() => document.querySelector('.cell').getBoundingClientRect().width > 360));
ok('the content is still all there', (await count('.item')) > 5);
await page.click('#present');
await page.waitForTimeout(250);
eq('and it goes back to Present', await text('#present'), 'Present');

// ---------------------------------------------------------------- source view
await page.keyboard.press('s');
await page.waitForSelector('#src');
ok('the source view shows the markdown', (await text('#src')).startsWith('# Priority Guides'));

// ---------------------------------------------------------------- drag
await page.keyboard.press('g');
await page.waitForSelector('.item');
const dragged = await page.evaluate(() => {
  // a divider has no name, so it is not a useful subject for this
  const items = [...document.querySelectorAll('.item')].filter((n) => n.querySelector('.lbl'));
  const from = items[1], to = items[3];
  // Compare on the name alone: a selected row grows its own tools, so its full
  // text is not stable across the move.
  const label = from.querySelector('.lbl').textContent.trim();
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const r = to.getBoundingClientRect();
  const cell = to.closest('.cell');
  cell.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
  cell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  const after = [...document.querySelectorAll('.item')]
    .filter((b) => b.querySelector('.lbl')).map((b) => b.querySelector('.lbl').textContent.trim());
  return { label, index: after.indexOf(label) };
});
eq('dragging a block lands it where it was dropped', dragged.index, 3);

// ---------------------------------------------------------------- no errors
ok('no uncaught errors anywhere in the session', errors.length === 0, errors.slice(0, 4).join('\n       '));

await browser.close();
server.kill();

console.log(`\n  ${pass} passed${fails.length ? `, ${fails.length} FAILED` : ''}\n`);
for (const f of fails) console.log(`  FAIL  ${f}\n`);
process.exit(fails.length ? 1 : 0);
