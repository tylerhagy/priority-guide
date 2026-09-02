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
const badLoads = [];
page.on('dialog', (d) => d.accept());
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  // The fixture points at a Figma file that does not exist, so its embed 404s.
  // That is the network telling the truth about a made-up URL, not the app
  // failing — anything the app itself serves is checked separately below.
  if (/Failed to load resource/.test(m.text())) return;
  errors.push('console: ' + m.text());
});
page.on('response', (r) => {
  if (!r.url().startsWith(`http://localhost:${PORT}`)) return;
  if (r.status() >= 400) badLoads.push(`${r.status()} ${r.url()}`);
});

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
/** Drag a palette element onto the row with this label. */
const dragOnto = async (what, needle, after = true) => {
  const done = await page.evaluate(({ w, n, a }) => {
    const tool = [...document.querySelectorAll('.ptool')].find((t) => t.textContent.includes(w));
    const item = [...document.querySelectorAll('.item')]
      .find((x) => x.querySelector('.lbl') && x.querySelector('.lbl').textContent.includes(n));
    if (!tool || !item) return false;
    const cell = item.closest('.cell');
    const dt = new DataTransfer();
    tool.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r = cell.getBoundingClientRect();
    const y = a ? r.bottom - 2 : r.top + 2;
    cell.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    cell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    tool.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return true;
  }, { w: what, n: needle, a: after });
  if (!done) throw new Error(`could not drag ${what} onto ${needle}`);
  await page.waitForTimeout(350);
};
/** Drag one existing block onto another. */
const dragBlock = async (fromLabel, toLabel, after = true) => {
  const done = await page.evaluate(({ f, t, a }) => {
    const find = (n) => [...document.querySelectorAll('.item')]
      .find((x) => x.querySelector('.lbl') && x.querySelector('.lbl').textContent.trim() === n);
    const from = find(f), to = find(t);
    if (!from || !to) return false;
    const dt = new DataTransfer();
    from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const cell = to.closest('.cell');
    const r = cell.getBoundingClientRect();
    const y = a ? r.bottom - 2 : r.top + 2;
    cell.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    cell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: y }));
    from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
    return true;
  }, { f: fromLabel, t: toLabel, a: after });
  if (!done) throw new Error(`could not drag ${fromLabel} onto ${toLabel}`);
  await page.waitForTimeout(350);
};
const labels = () => page.$$eval('.item', (ns) => ns.map((n) => {
  const l = n.querySelector('.lbl');
  return l ? l.textContent.trim() : (n.classList.contains('divider') ? '[divider]' : '');
}));

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
const fileBefore = await current();
await dragBlock('Date', 'Space');          // one place down: Date after Space
await save();
const afterDrag = await current();
eq('dragging a block one place changes two lines',
  afterDrag.split('\n').filter((l, i) => fileBefore.split('\n')[i] !== l).length, 2);
eq('the line count does not change', afterDrag.split('\n').length, fileBefore.split('\n').length);
ok('the moved line is the original text, not a re-render',
  afterDrag.includes('| Date | Mon 8 Sep | filter, sort |  |  |  |'));
await dragBlock('Date', 'Space', false);   // and back above it
await save();
ok('dragging it back restores the file exactly', (await current()) === fileBefore,
  'first differing line: ' + (() => {
    const a2 = fileBefore.split('\n'); const b2 = (afterDrag || '').split('\n');
    const i = a2.findIndex((l, j) => l !== b2[j]);
    return i === -1 ? 'none' : `${i + 1}: ${JSON.stringify(a2[i])} vs ${JSON.stringify(b2[i])}`;
  })());

ok('there is no keyboard shortcut that moves a block behind your back',
  await page.evaluate(async () => {
    const first = document.querySelector('.item .lbl').textContent;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    return document.querySelector('.item .lbl').textContent === first;
  }));

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
await page.evaluate(() => document.querySelector('.rowsel .slot, .rowsel .lanemore').click());
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

// ---------------------------------------------------------------- the palette
ok('there is one place everything is added from', await page.$('#palette') !== null);
eq('holding every element a guide can contain', await count('.ptool'), 7);
ok('and each one is something you pick up',
  await page.$$eval('.ptool', (ns) => ns.every((n) => n.draggable)));
ok('a section carries no way to add anything — dragging is the only way',
  await page.evaluate(async () => {
    document.querySelector('.cell.sechead .more').click();
    await new Promise((r) => setTimeout(r, 250));
    const txt = document.querySelector('.menu').textContent;
    return !/add/i.test(txt);
  }));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok('and a block carries no arrows', (await count('.rowstrip .ic')) === 0);

const blocksBefore = await count('.item');
await dragOnto('Content', 'Status');
eq('dragging content onto a block adds one', await count('.item'), blocksBefore + 1);
eq('right where it was dropped', (await labels())[(await labels()).indexOf('Status') + 1], '');
ok('and starts you naming it', await page.evaluate(() => document.activeElement.className.includes('lbl')));
await typeInto('.rowsel .lbl', 'A new thing');
await save();
ok('which lands in the file in that position',
  (await current()).split('\n').findIndex((l) => l.startsWith('| A new thing |'))
  === (await current()).split('\n').findIndex((l) => l.startsWith('| Status |')) + 1);

await dragOnto('Divider', 'A new thing');
ok('a divider is a rule and nothing else', await page.$('.item.divider .rule') !== null);
await save();
ok('and the file says so plainly', (await current()).includes('| [Divider] |'));

await dragOnto('Visual', 'A new thing', false);
await typeInto('.rowsel .lbl', 'A picture of something');
await save();
ok('a visual is dropped in as one', (await current()).includes('| [Visual] A picture of something |'));

const secBefore = await count('.sec-title');
await dragOnto('Section', 'A new thing');
eq('a section can be dragged in too', await count('.sec-title'), secBefore + 1);
await page.evaluate(() => {
  const t = [...document.querySelectorAll('.sec-title')].find((n) => n.textContent === 'New section');
  t.closest('.cell').querySelector('.more').click();
});
await page.waitForSelector('.menu');
await page.evaluate(() => [...document.querySelectorAll('.mitem')].find((n) => n.textContent.includes('Delete section')).click());
await page.waitForTimeout(300);
eq('and deleted again', await count('.sec-title'), secBefore);

const subBefore = await count('.sub-t');
await dragOnto('Subsection', 'Status');
eq('a subsection splits the section where it lands', await count('.sub-t'), subBefore + 1);
await save();
ok('and the file still round-trips', !(await text('#save')).includes('Read-only'));
ok('with the split written as a heading', (await current()).includes('#### Actions'));

// ---------------------------------------------------------------- moving is dragging
const orderWas = await labels();
const iStatus = orderWas.indexOf('Status');
await dragBlock('Status', 'Date', false);
const orderNow2 = await labels();
eq('a block moves by being dragged', orderNow2.indexOf('Status'), orderWas.indexOf('Date'));
ok('and it really moved', orderNow2.indexOf('Status') !== iStatus);
await save();
await dragBlock('Status', 'Time');
await save();
ok('across the section it is in', (await labels()).indexOf('Status') > (await labels()).indexOf('Time'));

const guideText = await current();
await dragBlock('Status', 'Nothing booked this week');
await save();
ok('and into another section entirely', (await current()) !== guideText
  && (await current()).includes('Nothing booked this week'));

// ---------------------------------------------------------------- what a block is
await pick('A new thing');
await page.waitForTimeout(200);
ok('a selected row says what it is', (await text('.rowsel .rowstrip .kind')).includes('Content'));
await page.evaluate(() => document.querySelector('.rowsel .rowstrip .kind').click());
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
await page.evaluate(() => document.querySelector('.rowsel .slot, .rowsel .lanemore').click());
await page.waitForTimeout(250);
await typeInto('.rowsel .note.fresh .t', 'Ideas: split by building');
await save();
await pick('A new thing');
await page.waitForTimeout(200);
await page.evaluate(() => document.querySelector('.rowsel .rowstrip .kind').click());
await page.waitForSelector('.kindpop');
await page.evaluate(() => [...document.querySelectorAll('.kindopt')]
  .find((b) => b.textContent.includes('Visual')).click());
await page.waitForTimeout(300);
await save();
ok('changing what a block is keeps its notes',
  (await current()).includes('| [Visual] A new thing |')
  && (await current()).includes('Ideas: split by building'),
  (await current()).split('\n').find((l) => l.includes('A new thing')));

// ---------------------------------------------------------------- choosing a reference
await dragOnto('Reference', 'Date');
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

// ---------------------------------------------------------------- adding lands where you drop it
await dragOnto('Content', 'Time');
await typeInto('.rowsel .lbl', 'Room or desk');
const lab = await labels();
eq('a dropped block lands right there, not at the end of the section',
  lab.indexOf('Room or desk'), lab.indexOf('Time') + 1);
await save();
ok('which the file records in that position', (await current()).includes('| Room or desk |'));
ok('and Enter no longer conjures one from nowhere', await page.evaluate(async () => {
  const n = document.querySelectorAll('.item').length;
  document.body.focus();
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 250));
  return document.querySelectorAll('.item').length === n;
}));

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
await page.evaluate(() => [...document.querySelectorAll('.rowsel .sbtn')]
  .find((b) => b.textContent.includes('Example')).click());
await page.waitForTimeout(250);
ok('but there is a quiet way to add one', await page.$('.rowsel .eg') !== null);
await typeInto('.rowsel .eg', 'Desk 4-118');
await save();
ok('and it lands in the file', (await current()).includes('| Room or desk | Desk 4-118 |'));

// ---------------------------------------------------------------- a row can be duplicated and removed
const dupBefore = await count('.item');
await pick('Who it is for');
await page.waitForTimeout(200);
await page.evaluate(() => [...document.querySelectorAll('.rowsel .sbtn')]
  .find((b) => b.textContent.includes('Duplicate')).click());
await page.waitForTimeout(300);
eq('a block can be duplicated', await count('.item'), dupBefore + 1);
await save();
eq('with everything it carried, notes included',
  (await current()).split('\n')
    .filter((l) => l.startsWith('| Who it is for |') && l.includes('Only office managers')).length, 2);
await page.evaluate(() => [...document.querySelectorAll('.rowsel .sbtn')]
  .find((b) => b.textContent.includes('Delete')).click());
await page.waitForTimeout(300);
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

// ---------------------------------------------------------------- nothing hides behind hover
ok('the lanes say what they hold, once, at the top',
  await page.evaluate(() => [...document.querySelectorAll('.lanelbl')]
    .map((n) => n.textContent).join('|') === 'Notes|Functionality'));
ok('and the labels sit above the stack rather than inside it',
  await page.evaluate(() => {
    const head = document.querySelector('.lanehead');
    return head && !head.classList.contains('cell') && !head.classList.contains('top');
  }));
ok('a row with no note still shows where one would go, without being touched',
  await page.evaluate(() => {
    const s2 = document.querySelector('.lane-l .slot');
    return !!s2 && getComputedStyle(s2).opacity > 0.2 && s2.getBoundingClientRect().width > 8;
  }));
ok('and so does a row with no functionality',
  await page.evaluate(() => {
    const f = document.querySelector('.fn.asslot');
    return !!f && getComputedStyle(f).opacity > 0.2;
  }));

// ---------------------------------------------------------------- the controls do not cover the row
await pick('Status');
await page.waitForTimeout(250);
ok('a selected row puts its controls in its own space',
  await page.evaluate(() => {
    const strip = document.querySelector('.rowsel .rowstrip');
    const box = document.querySelector('.rowsel .box');
    if (!strip || !box) return false;
    const a = strip.getBoundingClientRect(), b = box.getBoundingClientRect();
    return a.top >= b.bottom - 1;   // below it, never on top of it
  }));
ok('every control in it is a real target, not a sliver',
  await page.$$eval('.rowsel .rowstrip .sbtn', (ns) => ns.length > 0
    && ns.every((n) => n.getBoundingClientRect().height >= 20 && n.getBoundingClientRect().width >= 44)));

// ---------------------------------------------------------------- delete is one click, and undoable
const beforeDelete = await current();
const itemsBefore = await count('.item');
await page.evaluate(() => [...document.querySelectorAll('.rowsel .sbtn')]
  .find((b) => b.textContent.includes('Delete')).click());
await page.waitForTimeout(300);
eq('one click deletes a block', await count('.item'), itemsBefore - 1);
ok('and says so, with a way back', await page.$('.toast button') !== null);
await page.evaluate(() => [...document.querySelectorAll('.toast button')]
  .find((b) => b.textContent === 'Undo').click());
await page.waitForTimeout(300);
eq('which puts it back', await count('.item'), itemsBefore);
await save();
eq('exactly as it was', await current(), beforeDelete);

// ---------------------------------------------------------------- the app asks its own questions
ok('nothing calls a browser dialog',
  await page.evaluate(() => {
    const src = document.documentElement.innerHTML;
    return !/[^.\w]confirm\(/.test(src) && !/[^.\w]prompt\(/.test(src);
  }));
await page.click('#railL .rail-add');
await page.waitForSelector('.dialog', { timeout: 4000 });
ok('naming a new guide is asked inside the app', await page.$('.scrim .dialog input') !== null);
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok('and escape backs out of it', await page.$('.scrim') === null);

// ---------------------------------------------------------------- a visual takes up room
ok('a visual block is bigger than a line of text, because it stands for something that is',
  await page.evaluate(() => {
    const h = (sel) => [...document.querySelectorAll(sel)]
      .map((n) => n.getBoundingClientRect().height);
    const vis = h('.item.visual .box');
    const txt = h('.item.plain .box');
    if (!vis.length || !txt.length) return false;
    return Math.min(...vis) >= 70 && Math.min(...vis) > Math.max(...txt);
  }));

// ---------------------------------------------------------------- saving is legible
ok('the save button says what state it is in', (await text('#save')).includes('Saved'));
await pick('Status');
await page.waitForTimeout(200);
await typeInto('.rowsel .lbl', 'Status of it');
ok('and changes to an unmistakable one when there is something to save',
  (await text('#save')).includes('Save') && (await text('#save')).includes('⌘S'));
ok('which is the only primary button on the bar',
  await page.$eval('#save', (n) => n.className.includes('primary')));
await save();
await pick('Status of it');
await page.waitForTimeout(200);
await typeInto('.rowsel .lbl', 'Status');
await save();

// ---------------------------------------------------------------- clicking away lets go
/**
 * With a real mouse, at real coordinates — the way a person does it. Synthetic
 * events on a container miss the case that actually bit: a press that lands on
 * some other live element entirely.
 */
const held = () => page.evaluate(() => ({
  rows: document.querySelectorAll('.rowsel').length,
  strips: document.querySelectorAll('.rowstrip').length
}));
const grabRow = async (name) => {
  // A real click needs the row on screen, so put it there first.
  await page.evaluate((n) => {
    const it = [...document.querySelectorAll('.item')].find((x) => x.querySelector('.lbl')
      && x.querySelector('.lbl').textContent.trim() === n);
    if (it) it.scrollIntoView({ block: 'center' });
  }, name);
  await page.waitForTimeout(150);
  const at = await page.evaluate((n) => {
    const it = [...document.querySelectorAll('.item')].find((x) => x.querySelector('.lbl')
      && x.querySelector('.lbl').textContent.trim() === n);
    if (!it) return null;
    const r = it.querySelector('.lbl').getBoundingClientRect();
    return { x: r.x + 12, y: r.y + r.height / 2 };
  }, name);
  if (!at) throw new Error('no row ' + name);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(300);
};
const pressAt = async (sel, dx, dy) => {
  const box = await page.evaluate((q) => {
    const n = document.querySelector(q);
    if (!n) return null;
    const r = n.getBoundingClientRect();
    return { x: r.x, y: r.y };
  }, sel);
  if (!box) throw new Error('no target ' + sel);
  await page.mouse.click(box.x + dx, box.y + dy);
  await page.waitForTimeout(300);
};

for (const [what, sel, dx, dy] of [
  ['the section band', '.band', 8, 6],
  ['the guide beside the stack', '.guide', 4, 300],
  ['the stage below everything', '#stage', 700, 700],
  ['the page header', '#pagehead', 600, 10],
  ['the side panel', '#railR .pbody', 20, 300],
  ['a field in the side panel', '#railR .ctx dd', 10, 8],
  ['a tab in the side panel', '#railR .ptabs button', 12, 10],
  ['the guides rail', '#railL', 100, 700],
  ['another guide in the rail', '#railL .g-item:nth-child(3)', 40, 12],
  ['the palette', '#palette .ptool', 20, 12]
]) {
  await page.evaluate(() => document.querySelector('#tabs button').click());
  await page.waitForTimeout(220);
  await grabRow('Time');
  ok(`a row is held before pressing ${what}`, (await held()).rows > 0);
  await pressAt(sel, dx, dy);
  const now = await held();
  ok(`pressing ${what} lets go`, now.rows === 0 && now.strips === 0,
    `rows ${now.rows}, strips ${now.strips}`);
}

await page.evaluate(() => document.querySelector('#tabs button').click());
await page.waitForTimeout(220);
await grabRow('Time');
ok('holding a row puts the caret in its name',
  await page.evaluate(() => document.activeElement.className.includes('lbl')));
await pressAt('#stage', 700, 700);
ok('and pressing dead space takes the caret out of it',
  await page.evaluate(() => !document.activeElement.isContentEditable));

await grabRow('Time');
await grabRow('Status');
ok('pressing another row moves the hold rather than dropping it',
  await page.evaluate(() => {
    const s2 = document.querySelector('.rowsel .lbl');
    return !!s2 && s2.textContent.trim() === 'Status';
  }));
eq('and only ever one row is held', (await held()).rows, 3);
eq('with only one strip on screen', (await held()).strips, 1);

await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok('the first escape leaves the field but keeps the row',
  (await held()).rows > 0 && await page.evaluate(() => !document.activeElement.isContentEditable));
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
eq('and the second lets go of the row', (await held()).rows, 0);

// ---------------------------------------------------------------- what the guide became
await page.evaluate(() => document.querySelector('#tabs button').click());
await page.waitForTimeout(220);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#railL .g-item')].find((n) => n.textContent.includes('Bookings'));
  if (b) b.click();
});
await page.waitForTimeout(250);
await page.evaluate(() => [...document.querySelectorAll('#railR .ptabs button')]
  .find((b) => b.textContent.startsWith('Design')).click());
await page.waitForTimeout(300);
ok('a guide can say what it turned into', (await count('.dcard')) >= 1);
ok('a Figma link offers to open beside the guide', await page.$('.sidebyside') !== null);

await page.click('.sidebyside');
await page.waitForTimeout(700);
eq('which puts the guide and the design on one screen', await count('.bside'), 2);
ok('the design is embedded rather than linked away to',
  await page.$eval('.bframe', (n) => n.src.startsWith('https://embed.figma.com/')));
ok('the guide beside it is the real one, drawn by the same code',
  (await count('.beside .item')) > 5);
ok('but read-only, because this is the checking pass',
  (await count('.beside [contenteditable]')) === 0 && (await count('.beside .rowstrip')) === 0);

ok('the page does not overflow the window',
  await page.evaluate(() => document.body.getBoundingClientRect().width <= window.innerWidth + 1),
  'body ' + await page.evaluate(() => Math.round(document.body.getBoundingClientRect().width))
    + ' vs window ' + await page.evaluate(() => window.innerWidth));
ok('and the functionality lane is not cut off the edge of its pane',
  await page.evaluate(() => {
    const pane = document.querySelector('.bscroll').getBoundingClientRect();
    const lanes = [...document.querySelectorAll('.bscroll .lane-r')];
    return lanes.length > 0 && lanes.every((l) => l.getBoundingClientRect().right <= pane.right + 1);
  }));
ok('the two panes sit side by side, the same height',
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('.bside')].map((n) => n.getBoundingClientRect());
    return b.length === 2 && b[0].x < b[1].x && Math.abs(b[0].height - b[1].height) < 4;
  }));

await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('escape comes back to the guide', await page.$('.beside') === null && (await count('.item')) > 5);

// ---------------------------------------------------------------- capture
// A shortcut must not fire while the caret is in a field, so let go first.
await pressAt('#stage', 700, 700);
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
eq('the panel has four tabs, all at the guide\'s own altitude', await count('#railR .ptabs button'), 4);
ok('context opens first, because it is what you need to read the guide',
  (await text('#railR .ptabs button.on')).startsWith('Context'));
ok('and it holds the goals, the users and the notes',
  (await text('#railR .pbody')).includes('User goal') && (await text('#railR .pbody')).includes('Primary users'));
await panel(2);
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
await panel(3);
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
ok('every chip reads the same, because none of them is a state you set here',
  await page.$$eval('#railR .chip:not(.add)', (ns) => {
    const c = ns.map((n) => getComputedStyle(n).backgroundColor);
    return c.length > 1 && c.every((x) => x === c[0]);
  }));
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
const titleSize = await page.evaluate(() =>
  getComputedStyle(document.querySelector('#pagehead h1')).fontSize);
await page.mouse.click(700, 300);
await page.waitForTimeout(150);
await page.keyboard.press('p');
await page.waitForTimeout(250);
eq('the present button becomes the way out', await text('#present'), 'Exit');
eq('the guide title is the same size wherever you are',
  await page.evaluate(() => getComputedStyle(document.querySelector('#pagehead h1')).fontSize),
  titleSize);
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
ok('and everything the app itself asked for loaded', badLoads.length === 0, badLoads.slice(0, 4).join('\n       '));

await browser.close();
server.kill();

console.log(`\n  ${pass} passed${fails.length ? `, ${fails.length} FAILED` : ''}\n`);
for (const f of fails) console.log(`  FAIL  ${f}\n`);
process.exit(fails.length ? 1 : 0);
