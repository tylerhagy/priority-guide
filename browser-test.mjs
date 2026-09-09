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
const TRACE = !!process.env.PG_TRACE;
const ok = (n, c, d) => { if (TRACE) console.log('  ·', n); if (c) pass++; else fails.push(`${n}${d ? `\n       ${d}` : ''}`); };
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
/** Scoped to the real guide: the minimap holds a copy of every element. */
const gcount = (sel) => page.$$eval('#stage ' + sel, (n) => n.length);
const written = () => page.evaluate(() => window.__written || null);
const current = () => page.evaluate(() => window.__store['Priority Guides.md']);
const line = async (prefix) => (await current()).split('\n').find((l) => l.startsWith(prefix)) || '';
let saveNo = 0;
const save = async () => {
  saveNo++;
  await page.keyboard.down('Meta'); await page.keyboard.press('s'); await page.keyboard.up('Meta');
  await page.waitForTimeout(400);
  // A save that does not settle means the app refused it or never heard it.
  // Saved is quiet now — the button disappears rather than announcing itself —
  // so "settled" means gone, unless the file is read-only.
  const st = await page.$eval('#save', (n) => ({ text: n.textContent.trim(), hidden: getComputedStyle(n).display === 'none' }));
  ok(`save ${saveNo} settles`, st.hidden || st.text === 'Read-only', `button says "${st.text}", hidden=${st.hidden}`);
};
/** Every delete asks first now, so say yes. */
const okDelete = async () => {
  await page.waitForSelector('.scrim .dialog', { timeout: 4000 });
  await page.evaluate(() => [...document.querySelectorAll('.dialog .dfoot button')]
    .find((b) => b.textContent.trim() === 'Delete').click());
  await page.waitForTimeout(250);
};
/** Back out of the confirm instead. */
const cancelDelete = async () => {
  await page.waitForSelector('.scrim .dialog', { timeout: 4000 });
  await page.evaluate(() => [...document.querySelectorAll('.dialog .dfoot button')]
    .find((b) => b.textContent.trim() === 'Cancel').click());
  await page.waitForTimeout(250);
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
eq('its blocks render as items in the stack', await gcount('.item'), 13);
ok('the open count is shown', (await text('#open')).includes('11 open'));

// ---------------------------------------------------------------- the three lanes
ok('the guide is a three-lane grid',
  await page.$eval('.guide', (n) => getComputedStyle(n).gridTemplateColumns.split(' ').length === 3));
ok('the stack sits in the middle lane',
  await page.$eval('.cell', (n) => getComputedStyle(n).gridColumnStart === '2'));
ok('notes annotate from the left', (await gcount('.lane-l .note')) >= 3);
ok('functionality annotates from the right', (await gcount('.lane-r .fn:not(.empty)')) >= 8);
ok('each annotation is joined to its row by a leader', (await gcount('.lead')) >= 10);
ok('an action item is styled as one', (await gcount('.lane-l .note.act')) >= 1);
ok('a row can carry more than one note',
  await page.evaluate(() => [...document.querySelectorAll('.notes')].some((n) => n.querySelectorAll('.note').length > 1)));
ok('a tall annotation does not tear a hole in the section panel',
  await page.evaluate(() => [...document.querySelectorAll('.band')]
    .filter((b) => !b.parentElement.classList.contains('top') && !b.parentElement.classList.contains('bot'))
    .every((b) => Math.abs(b.getBoundingClientRect().height - b.parentElement.getBoundingClientRect().height) < 2)));

// ---------------------------------------------------------------- the stack itself
ok('a data point with no control is plain text, not a box', (await gcount('.item.plain')) >= 4);
ok('a field with a form type renders as a control',
  (await gcount('.item:not(.plain):not(.linky):not(.visual)')) >= 1);
ok('a link renders as a link', (await gcount('.item.linky')) >= 2);
ok('a visual is marked as one', (await gcount('.item.visual')) >= 1);
ok('a select shows it has more behind it', (await gcount('.item .chev')) >= 1);
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
ok('functionality carries an icon', (await gcount('.fn .l svg')) >= 8);
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
const noteRows = await gcount('.note');
await pick('Status');
await page.waitForTimeout(150);
await page.evaluate(() => document.querySelector('.rowsel .slot, .rowsel .lanemore').click());
await page.waitForTimeout(200);
await typeInto('.rowsel .note:last-of-type .t', 'Half-days were cut in review');
eq('a note can be added to any row', await gcount('.note'), noteRows + 1);
await page.evaluate(() => {
  const n = [...document.querySelectorAll('.note')].find((x) => x.textContent.includes('Half-days were cut in review'));
  n.querySelector('.tools button').click();
});
await page.waitForTimeout(250);
ok('and turned into an action in one click',
  await page.evaluate(() => [...document.querySelectorAll('.note.act')]
    .some((n) => n.textContent.includes('Half-days were cut in review'))));
await save();
ok('which the file records as an action',
  (await current()).includes('ACTION: Half-days were cut in review'));
ok('several notes on one row are kept apart by a line break, not run together',
  (await current()).includes('the rest of the day<br>ACTION: Half-days were cut in review'));
await page.evaluate(() => {
  const n = [...document.querySelectorAll('.note')].find((x) => x.textContent.includes('Half-days were cut in review'));
  n.querySelectorAll('.tools button')[1].click();
});
await okDelete();
eq('and deleted again', await gcount('.note'), noteRows);

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
ok('a section offers no way to add a block — dragging is the only way',
  await page.evaluate(async () => {
    document.querySelector('.cell.sechead .more').click();
    await new Promise((r) => setTimeout(r, 250));
    const txt = document.querySelector('.menu').textContent;
    return !/content|visual|divider|subsection|reference/i.test(txt);
  }));
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
ok('and a block carries no arrows', (await count('.rowstrip .ic')) === 0);

const blocksBefore = await gcount('.item');
await dragOnto('Content', 'Status');
eq('dragging content onto a block adds one', await gcount('.item'), blocksBefore + 1);
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

const secBefore = await gcount('.sec-title');
await dragOnto('Section', 'A new thing');
eq('a section can be dragged in too', await gcount('.sec-title'), secBefore + 1);
await page.evaluate(() => {
  const t = [...document.querySelectorAll('.sec-title')].find((n) => n.textContent === 'New section');
  t.closest('.cell').querySelector('.more').click();
});
await page.waitForSelector('.menu');
await page.evaluate(() => [...document.querySelectorAll('.mitem')].find((n) => n.textContent.includes('Delete section')).click());
await okDelete();
eq('and deleted again', await gcount('.sec-title'), secBefore);

const subBefore = await gcount('.sub-t');
await dragOnto('Subsection', 'Status');
eq('a subsection splits the section where it lands', await gcount('.sub-t'), subBefore + 1);
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
  const r = [...document.querySelectorAll('#stage .ref')].pop();
  if (r && r.querySelector('.refx')) r.querySelector('.refx').click();
});
await okDelete();
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
eq('and nothing on the guide is flagged for missing one', await gcount('.flag'), 0);
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
const dupBefore = await gcount('.item');
await pick('Who it is for');
await page.waitForTimeout(200);
await page.evaluate(() => [...document.querySelectorAll('.rowsel .sbtn')]
  .find((b) => b.textContent.includes('Duplicate')).click());
await page.waitForTimeout(300);
eq('a block can be duplicated', await gcount('.item'), dupBefore + 1);
await save();
eq('with everything it carried, notes included',
  (await current()).split('\n')
    .filter((l) => l.startsWith('| Who it is for |') && l.includes('Only office managers')).length, 2);
await page.evaluate(() => [...document.querySelectorAll('.rowsel .sbtn')]
  .find((b) => b.textContent.includes('Delete')).click());
await okDelete();
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
  await page.evaluate(() => [...document.querySelectorAll('#stage .lanelbl')]
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
const itemsBefore = await gcount('.item');
await page.evaluate(() => [...document.querySelectorAll('.rowsel .sbtn')]
  .find((b) => b.textContent.includes('Delete')).click());
// A mis-click is instant and undo is a seven-second net, so the net is the
// second line of defence rather than the first.
ok('deleting a block asks first', await page.$('.scrim .dialog') !== null);
await cancelDelete();
eq('and cancelling changes nothing', await gcount('.item'), itemsBefore);
await page.evaluate(() => [...document.querySelectorAll('.rowsel .sbtn')]
  .find((b) => b.textContent.includes('Delete')).click());
await okDelete();
eq('confirming deletes the block', await gcount('.item'), itemsBefore - 1);
ok('and says so, with a way back', await page.$('.toast button') !== null);
await page.evaluate(() => [...document.querySelectorAll('.toast button')]
  .find((b) => b.textContent === 'Undo').click());
await page.waitForTimeout(300);
eq('which puts it back', await gcount('.item'), itemsBefore);
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
    const h = (sel) => [...document.querySelectorAll('#stage ' + sel)]
      .map((n) => n.getBoundingClientRect().height);
    const vis = h('.item.visual .box');
    const txt = h('.item.plain .box');
    if (!vis.length || !txt.length) return false;
    return Math.min(...vis) >= 70 && Math.min(...vis) > Math.max(...txt);
  }));

// ---------------------------------------------------------------- saving is legible
ok('the clean state is quiet: no save button, no dirty mark on the filename',
  await page.evaluate(() => getComputedStyle(document.getElementById('save')).display === 'none'
    && !document.getElementById('file').textContent.includes('·')));
await pick('Status');
await page.waitForTimeout(200);
await typeInto('.rowsel .lbl', 'Status of it');
ok('and changes to an unmistakable one when there is something to save',
  (await text('#save')).includes('Save') && (await text('#save')).includes('⌘S'));
ok('which is the only primary button on the bar',
  await page.$eval('#save', (n) => n.className.includes('primary')));
ok('the filename itself picks up the dirty mark',
  (await text('#file')).includes('·'));
await save();
ok('and saving takes both the button and the dot away again',
  await page.evaluate(() => getComputedStyle(document.getElementById('save')).display === 'none'
    && !document.getElementById('file').textContent.includes('·')));
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
  ['the stage margin beside the guide', '#stage', 8, 300],
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
await pressAt('#stage', 8, 300);
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
// A fixed offset into the guide is a hostage to layout: it used to land on empty
// lane space and, once the section padding changed, it landed on the held row's
// own notes — which is a press on that row, not beside it.
await page.evaluate(() => document.querySelector('#tabs button').click());
await page.waitForTimeout(220);
await grabRow('Time');
ok('a row is held before pressing the guide beside the stack', (await held()).rows > 0);
const emptyLane = await page.evaluate(() => {
  const lane = [...document.querySelectorAll('.guide .lane-l')]
    .find((n) => !n.children.length && n.getBoundingClientRect().height > 8);
  if (!lane) return null;
  const r = lane.getBoundingClientRect();
  return { x: r.x + Math.min(8, r.width / 2), y: r.y + r.height / 2 };
});
ok('there is empty lane space to press', emptyLane !== null);
if (emptyLane) {
  await page.mouse.click(emptyLane.x, emptyLane.y);
  await page.waitForTimeout(300);
  const now = await held();
  ok('pressing the guide beside the stack lets go', now.rows === 0 && now.strips === 0,
    `rows ${now.rows}, strips ${now.strips}`);
}

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

// ---------------------------------------------------------------- closing lives on the design side
ok('the close control sits in the Figma pane\'s header',
  await page.evaluate(() => {
    const rightHead = document.querySelectorAll('.bside')[1].querySelector('.bhead');
    return rightHead.querySelector('.bclose') !== null
      && rightHead.querySelector('.bclose').textContent.trim() === 'Close';
  }));
ok('not the guide\'s', await page.evaluate(() =>
  document.querySelectorAll('.bside')[0].querySelector('.bhead').querySelector('.bclose') === null));

// ---------------------------------------------------------------- the split can be resized
const leftWidthBefore = await page.$eval('.bside', (n) => n.getBoundingClientRect().width);
const divider = await page.$eval('.bdrag', (n) => {
  const r = n.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(divider.x, divider.y);
await page.mouse.down();
await page.mouse.move(divider.x + 130, divider.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(200);
const leftWidthAfter = await page.$eval('.bside', (n) => n.getBoundingClientRect().width);
ok('dragging the divider resizes the guide pane',
  leftWidthAfter > leftWidthBefore + 20,
  `before ${leftWidthBefore} after ${leftWidthAfter}`);

await page.click('.bclose');
await page.waitForTimeout(400);
ok('and the close button closes the beside view',
  await page.$('.beside') === null && (await gcount('.item')) > 5);

await page.click('.sidebyside');
await page.waitForTimeout(600);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('escape still comes back to the guide', await page.$('.beside') === null && (await gcount('.item')) > 5);

// ---------------------------------------------------------------- every panel belongs to its guide
const showPanel = async (label) => {
  await page.evaluate((l) => {
    [...document.querySelectorAll('#railR .ptabs button')].find((b) => b.textContent.startsWith(l)).click();
  }, label);
  await page.waitForTimeout(250);
};
const panelText = async (label) => {
  await showPanel(label);
  return page.evaluate(() => document.querySelector('#railR .pbody').textContent.replace(/\s+/g, ' ').trim());
};
const goGuide = async (name) => {
  await page.evaluate((n) => {
    [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes(n)).click();
  }, name);
  await page.waitForTimeout(300);
};

await goGuide('Bookings');
const a = {};
for (const t of ['Context', 'Design', 'Sources', 'Links']) a[t] = await panelText(t);
await goGuide('Cancel a booking');
const b2 = {};
for (const t of ['Context', 'Design', 'Sources', 'Links']) b2[t] = await panelText(t);

for (const t of ['Context', 'Design', 'Sources', 'Links']) {
  ok(`the ${t} panel belongs to the guide you are on`, a[t] !== b2[t],
    `both guides showed: ${String(a[t]).slice(0, 70)}`);
}
ok('context carries that guide\'s own goal',
  a.Context.includes('See what I have booked') && b2.Context.includes('Give up a space'));
ok('a design linked on one guide does not appear on another',
  a.Design.includes('the week view') && b2.Design.includes('Nothing linked yet'));

// ---------------------------------------------------------------- managing the designs
await goGuide('Bookings');
await showPanel('Design');
const dTitles = () => page.$$eval('.dcard .title', (ns) => ns.map((n) => n.textContent.trim()));
eq('every design on the guide is listed', (await dTitles()).length, 3);
const startOrder = await dTitles();

await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.dcard')];
  const from = cards[0], to = cards[2];
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const r = to.getBoundingClientRect();
  to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
  to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
});
await page.waitForTimeout(350);
eq('a design can be dragged into a new position', (await dTitles())[2], startOrder[0]);
await save();
ok('and the file records the order',
  (await line('**Design:**')).indexOf('week-layout') > (await line('**Design:**')).indexOf('week-shots'),
  await line('**Design:**'));

await page.$eval('.dcard .title', (n) => { n.focus(); n.textContent = 'Week view — v3'; n.blur(); });
await page.waitForTimeout(300);
await save();
ok('renaming a design writes the source\'s own name',
  (await current()).includes('"Week view — v3"'));
ok('and the panel shows it', (await dTitles()).includes('Week view — v3'));

// ---------------------------------------------------------------- unlinking asks first
const beforeUnlink = await dTitles();
await page.evaluate(() => document.querySelector('.dcard .x').click());
await page.waitForSelector('.dialog', { timeout: 4000 });
ok('unlinking asks before doing anything', (await dTitles()).length === beforeUnlink.length);
ok('the confirm names the design being unlinked',
  (await text('.dialog h2')).includes(beforeUnlink[0]));

await page.evaluate(() => [...document.querySelectorAll('.dialog .dfoot .btn')]
  .find((b) => b.textContent === 'Cancel').click());
await page.waitForTimeout(250);
eq('cancel leaves the link untouched', (await dTitles()).length, beforeUnlink.length);
ok('and the dialog is gone', await page.$('.dialog') === null);

await page.evaluate(() => document.querySelector('.dcard .x').click());
await page.waitForSelector('.dialog', { timeout: 4000 });
await page.evaluate(() => [...document.querySelectorAll('.dialog .dfoot .btn')]
  .find((b) => b.textContent === 'Unlink').click());
await page.waitForTimeout(300);
eq('confirming unlinks the design', (await dTitles()).length, beforeUnlink.length - 1);
ok('with a way back, as a second net', await page.$('.toast button') !== null);
await page.evaluate(() => [...document.querySelectorAll('.toast button')]
  .find((x) => x.textContent === 'Undo').click());
await page.waitForTimeout(300);
eq('which puts it back', (await dTitles()).length, beforeUnlink.length);
await save();
ok('and the source itself was never deleted from the file',
  (await current()).includes('[week-layout]:'));

// ---------------------------------------------------------------- comments
/**
 * Comments are true of one guide and of nothing else, so they live with the
 * guide: a tab in the panel, a switch for the markers, and a count beside the
 * guide's name. Nothing about them belongs in the app bar, which is also above
 * Flow, Users, Open and Source.
 */
ok('comments are not in the app bar', await page.$('#bar #comments') === null);
const cTab = () => page.$('#railR .ptabs button[data-panel="comments"]');
ok('they are a tab on the guide instead', await cTab() !== null);

await (await cTab()).click();
await page.waitForTimeout(300);
ok('the tab holds the switch for the markers', await page.$('.markers') !== null);
eq('which are off until you ask for them', await gcount('.bubble'), 0);
await page.click('.markers');
await page.waitForTimeout(300);
ok('turning them on puts one on every block', (await gcount('.bubble')) > 5);
ok('and the switch reads as on', await page.$('.markers.on') !== null);

// The bug: a comment was written to the file but did not appear on the guide
// until the markers were switched off and on again.
const bubbleOn = (name) => page.evaluate((n) => {
  const it = [...document.querySelectorAll('#stage .item')].find((x) => x.querySelector('.lbl')
    && x.querySelector('.lbl').textContent.trim() === n);
  const b = it && it.querySelector('.bubble');
  return b ? b.textContent.trim() : null;
}, name);
eq('a block with no comments shows no number', await bubbleOn('Status'), '');
await page.evaluate(() => {
  const it = [...document.querySelectorAll('#stage .item')].find((x) => x.querySelector('.lbl')
    && x.querySelector('.lbl').textContent.trim() === 'Status');
  it.querySelector('.bubble').click();
});
await page.waitForSelector('.thread');
await page.fill('.tnew', 'Is this one from a list?');
await page.click('.thread .btn.primary');
await page.waitForTimeout(300);
eq('a comment can be left on a block', await count('.tc'), 1);
eq('and it shows on the block straight away, with the thread still open',
  await bubbleOn('Status'), '1');
await save();
ok('and the file records it as a plain task list',
  (await current()).split('\n').some((l) => /^- \[ \] `[a-z0-9]+` Is this one from a list\?$/.test(l)));
ok('with the block carrying an id nothing else can see',
  /^\| Status <!--#[a-z0-9]+--> \|/m.test(await current()));

await page.keyboard.press('Escape');
await page.waitForTimeout(300);
eq('closing the thread leaves the marker showing what it says',
  await bubbleOn('Status'), '1');

// the whole point: the comment is pinned to the block, not to a place
const ridOf = async () => (await current()).match(/\| Status <!--#([a-z0-9]+)-->/)[1];
const rid = await ridOf();
await dragBlock('Status', 'Nothing booked this week');
await save();
ok('moving the block to another section keeps its comment',
  (await current()).includes(`\`${rid}\``) && (await current()).includes(`<!--#${rid}-->`));
await dragBlock('Status', 'Space');
await save();

// ---- the list
/**
 * Opening every bubble in turn to find out what a reviewer said is excavating,
 * not reading. The list is the readable form.
 */
await page.evaluate(() => {
  const it = [...document.querySelectorAll('#stage .item')].find((x) => x.querySelector('.lbl')
    && x.querySelector('.lbl').textContent.trim() === 'Time');
  it.querySelector('.bubble').click();
});
await page.waitForSelector('.thread');
await page.fill('.tnew', 'Is All day a separate thing, or a value?');
await page.click('.thread .btn.primary');
await page.waitForTimeout(250);
await page.keyboard.press('Escape');
await page.waitForTimeout(350);

const listText = () => page.$eval('#railR .pbody', (n) => n.textContent);
eq('the list groups by block', await count('#railR .cgroup'), 2);
ok('and says what each one is on',
  (await listText()).includes('Status') && (await listText()).includes('Time'));
ok('with the words readable without opening anything',
  (await listText()).includes('Is this one from a list?')
  && (await listText()).includes('Is All day a separate thing, or a value?'));
ok('and a count of what is still open', (await listText()).includes('2 open of 2'));
eq('the tab carries the same number',
  await page.$eval('#railR .ptabs button[data-panel="comments"] .n', (n) => n.textContent), '2');
ok('and so does the guide in the rail, so you can see it from outside',
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('#railL .g-item')].find((x) => x.classList.contains('on'));
    const c = b && b.querySelector('.cn');
    return !!c && c.textContent.trim() === '2';
  }));

await page.evaluate(() => document.querySelectorAll('#railR .cgroup .tick')[0].click());
await page.waitForTimeout(350);
await save();
ok('a comment can be resolved from the list', (await current()).split('\n').some((l) => l.startsWith('- [x] `')));
ok('and the counts come down with it', (await listText()).includes('1 open of 2'));

await page.$eval('#railR .cgroup .tc .t', (n) => {
  n.focus(); n.textContent = 'One from a list, or many?'; n.blur();
});
await page.waitForTimeout(350);
await save();
ok('and edited there', (await current()).includes('One from a list, or many?'));

await page.evaluate(() => document.querySelector('#railR .cgroup .cg-h').click());
await page.waitForTimeout(400);
ok('pressing an entry holds its block on the guide',
  await page.evaluate(() => !!document.querySelector('#stage .rowsel')));

await page.evaluate(() => document.querySelectorAll('#railR .cgroup .tc .x')[0].click());
ok('deleting a comment asks first', await page.$('.scrim .dialog') !== null);
await okDelete();
ok('and deleted, with a way back', await page.$('.toast button') !== null);

await page.click('.markers');
await page.waitForTimeout(300);
eq('the markers can be switched off again', await gcount('.bubble'), 0);
ok('while the comments themselves are untouched',
  (await listText()).includes('One from a list, or many?')
  || (await listText()).includes('All day'));

// ---------------------------------------------------------------- zoom
/**
 * A guide is a wide document and a laptop is not a wide screen.
 */
const zoomNow = () => page.evaluate(() =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zoom')) || 1);
// Zooming out does not narrow the guide — it keeps filling the page and fits
// MORE of itself on screen. So what has to change is how big a block renders
// and how tall the whole thing is, not the column width.
const blockH = () => page.$eval('#stage .item .box', (n) => n.getBoundingClientRect().height);
const frameH = () => page.$eval('#stage .gzoom', (n) => n.getBoundingClientRect().height);
ok('there is a zoom control on the guide', await page.$('#pagehead .zoom') !== null);
eq('it starts at 100%', await page.$eval('.zpct', (n) => n.textContent), '100%');
const h100 = await blockH();
const tall100 = await frameH();
await page.click('#pagehead .zoom .zb:first-child');
await page.waitForTimeout(300);
ok('zooming out fits more of the guide on screen',
  (await zoomNow()) < 1 && (await blockH()) < h100 - 1 && (await frameH()) < tall100 - 20);
eq('and the control says so', await page.$eval('.zpct', (n) => n.textContent), '90%');
await page.click('#pagehead .zoom .zb:last-child');
await page.click('#pagehead .zoom .zb:last-child');
await page.waitForTimeout(300);
ok('zooming in makes it bigger to read', (await blockH()) > h100 + 1);
await page.click('.zpct');
await page.waitForTimeout(300);
eq('and the readout is the way back to 100%', await zoomNow(), 1);
await page.keyboard.down('Meta'); await page.keyboard.press('0'); await page.keyboard.up('Meta');
await page.waitForTimeout(300);
eq('and the keyboard resets it', await zoomNow(), 1);

// Fit means all three lanes on screen at once — the thing a laptop loses first.
await page.setViewportSize({ width: 1060, height: 800 });
await page.waitForTimeout(500);
await page.click('.zpct');
await page.waitForTimeout(400);
ok('fit puts every lane on screen at once',
  await page.evaluate(() => {
    const st = document.getElementById('stage');
    const g = document.querySelector('#stage .guide');
    return g.getBoundingClientRect().width <= st.clientWidth + 2;
  }), `zoom ${await zoomNow()}`);
ok('and never so small it cannot be read', (await zoomNow()) >= 0.5);
await page.setViewportSize({ width: 1600, height: 1000 });
await page.waitForTimeout(400);
await page.keyboard.down('Meta'); await page.keyboard.press('0'); await page.keyboard.up('Meta');
await page.waitForTimeout(300);

// The bug this fixes: fixed lane minimums could not shrink, so on a laptop the
// guide overflowed its column and ran underneath the minimap.
await page.setViewportSize({ width: 1280, height: 800 });
await page.waitForTimeout(500);
ok('every lane fits inside the stage, at any window width',
  await page.evaluate(() => {
    const st = document.getElementById('stage');
    const cells = [...document.querySelectorAll('#stage .lane-r')];
    const right = Math.max(...cells.map((n) => n.getBoundingClientRect().right));
    return right <= st.getBoundingClientRect().right - 20;
  }));
ok('on a laptop the guide never runs under the minimap',
  await page.evaluate(() => {
    const m = document.getElementById('minimap');
    const g = document.querySelector('#stage .guide');
    if (!g) return false;
    if (getComputedStyle(m).display === 'none') return true;
    return g.getBoundingClientRect().right <= m.getBoundingClientRect().left + 1;
  }));
ok('and nothing is clipped away — it scrolls instead',
  await page.$eval('#stage', (n) => getComputedStyle(n).overflowX !== 'hidden'));
await page.setViewportSize({ width: 1600, height: 1000 });
await page.waitForTimeout(400);

// ---------------------------------------------------------------- the panel tabs
/**
 * Four tabs, one row, one baseline — whether or not a tab has a count. A count
 * that pushes its own label up makes the row look like two rows.
 */
ok('every tab label sits on the same baseline',
  await page.evaluate(() => {
    const tops = [...document.querySelectorAll('#railR .ptabs button .l')]
      .map((n) => Math.round(n.getBoundingClientRect().top));
    return tops.length === 5 && Math.max(...tops) - Math.min(...tops) <= 1;
  }));
ok('and no tab wraps onto a second line',
  await page.evaluate(() => {
    const bs = [...document.querySelectorAll('#railR .ptabs button')];
    const h = bs.map((b) => b.getBoundingClientRect().height);
    return bs.length === 5 && Math.max(...h) - Math.min(...h) <= 1 && Math.max(...h) < 34;
  }));
ok('the tabs are one row inside the panel',
  await page.evaluate(() => {
    const bs = [...document.querySelectorAll('#railR .ptabs button')];
    const rail = document.getElementById('railR').getBoundingClientRect();
    return bs.every((b) => b.getBoundingClientRect().right <= rail.right + 1);
  }));

// ---------------------------------------------------------------- the minimap
/**
 * It is a picture of the guide, not a diagram of it — so the thing that has to
 * be true is that it matches, and that it is a column rather than a sticker.
 */
await page.evaluate(() => {
  [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Bookings')).click();
});
await page.waitForTimeout(400);

const mapOn = () => page.$eval('#minimap', (n) => getComputedStyle(n).display !== 'none');
ok('a guide taller than the window gets a map', await mapOn(),
  await page.evaluate(() => { const s = document.getElementById('stage');
    return `scrollHeight ${s.scrollHeight} clientHeight ${s.clientHeight}`; }));
if (await mapOn()) {
  eq('the map holds the guide itself, block for block',
    await count('#minimap .mshot .item'), await count('#stage .item'));
  ok('and nothing in it can be clicked into by mistake',
    (await count('#minimap [contenteditable]')) === 0);
  ok('the controls are left out — they are noise at that size',
    (await count('#minimap .rowstrip, #minimap .slot, #minimap .more')) === 0);

  ok('it is a column, so it covers nothing',
    await page.evaluate(() => {
      const m = document.getElementById('minimap').getBoundingClientRect();
      return ['pagehead', 'palette', 'stage', 'railR'].every((id) => {
        const n = document.getElementById(id);
        if (!n) return true;
        const r = n.getBoundingClientRect();
        return r.right <= m.left + 1 || r.left >= m.right - 1
          || r.bottom <= m.top + 1 || r.top >= m.bottom - 1;
      });
    }));
  ok('it is quiet until you look at it',
    await page.$eval('.mshotwrap', (n) => parseFloat(getComputedStyle(n).opacity) < 0.6));

  // The complaint the rebuild answered: a diagram gives every block the same
  // weight, so the map disagrees with the page. A picture cannot.
  ok('the picture is the guide to scale, not a diagram of it',
    await page.evaluate(() => {
      const m = document.getElementById('minimap').getBoundingClientRect();
      const shot = document.querySelector('.mshot').getBoundingClientRect();
      if (shot.width > m.width || shot.width < m.width * 0.7) return false;
      const ratio = (root) => {
        const vis = document.querySelector(root + ' .item.visual .box');
        const txt = document.querySelector(root + ' .item.plain .box');
        return vis && txt ? vis.getBoundingClientRect().height / txt.getBoundingClientRect().height : null;
      };
      const page_ = ratio('#stage'), map = ratio('#minimap');
      return page_ && map && Math.abs(page_ - map) / page_ < 0.06;
    }));

  const stageTop = () => page.evaluate(() => document.getElementById('stage').scrollTop);
  const viewTop = () => page.evaluate(() => parseFloat(document.querySelector('.mview').style.top));
  // Put the guide at the top rather than inheriting wherever the last test left
  // it: the claim is about where the box sits when you are at the top, so being
  // at the top has to be established, not hoped for.
  await page.evaluate(() => { document.getElementById('stage').scrollTop = 0; });
  await page.waitForTimeout(120);
  ok('the box sits at the top when you are at the top', (await stageTop()) === 0 && (await viewTop()) < 3,
    `stage.scrollTop ${await stageTop()}, view top ${await viewTop()}`);
  await page.evaluate(() => {
    const m = document.getElementById('minimap');
    const r = m.getBoundingClientRect();
    m.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientY: r.top + r.height * 0.5 }));
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(350);
  ok('pressing it takes you there', (await stageTop()) > 100);
  ok('and the box follows', (await viewTop()) > 10);
  await page.evaluate(() => { document.getElementById('stage').scrollTop = 0; });
  await page.waitForTimeout(250);
}

// Presenting and checking against a design are both reading, and a map is a
// writing tool. It is out of the way for both.
await page.keyboard.press('p');
await page.waitForTimeout(350);
eq('there is no map while presenting',
  await page.$eval('#minimap', (n) => getComputedStyle(n).display), 'none');
await page.keyboard.press('Escape');
await page.waitForTimeout(350);

await page.evaluate(() => {
  [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Cancel a booking')).click();
});
await page.waitForTimeout(400);
eq('a guide that fits on screen draws no map',
  await page.$eval('#minimap', (n) => getComputedStyle(n).visibility), 'hidden');
ok('but keeps its column, so the guide does not jump sideways between guides',
  await page.$eval('#minimap', (n) =>
    getComputedStyle(n).display !== 'none' && n.getBoundingClientRect().width > 100));
await page.evaluate(() => {
  [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Bookings')).click();
});
await page.waitForTimeout(300);

// ---------------------------------------------------------------- the copy is only a picture
/**
 * The map holds a real copy of the guide, which means every class in the guide
 * exists twice in the document. Nothing that acts on the guide may reach it.
 */
await page.evaluate(() => {
  [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Bookings')).click();
});
await page.waitForTimeout(400);
ok('the long guide still has its map, so what follows is actually checked',
  await page.$eval('#minimap', (n) => getComputedStyle(n).display !== 'none'));
if (await page.$eval('#minimap', (n) => getComputedStyle(n).display !== 'none')) {
  await page.evaluate(() => {
    const it = [...document.querySelectorAll('#stage .item')].find((x) => x.querySelector('.lbl'));
    it.querySelector('.lbl').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  eq('holding a block marks the guide and not its picture',
    await count('#minimap .rowsel'), 0);
  eq('and the strip is only on the real one', await count('#minimap .rowstrip'), 0);
  ok('a block in the picture cannot be dragged',
    await page.$$eval('#minimap [draggable]', (ns) => ns.length === 0));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(250);
  eq('and letting go clears the real one', await gcount('.rowsel'), 0);
}

// ---------------------------------------------------------------- the map at laptop sizes
/**
 * The map is for a laptop more than for a desktop — a big screen shows most of
 * a guide anyway. A width rule that quietly removed it on every MacBook would
 * have taken it away from exactly the machine that needs it.
 */
await page.evaluate(() => {
  [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Bookings')).click();
});
for (const w of [1512, 1440, 1280]) {
  await page.setViewportSize({ width: w, height: 860 });
  await page.waitForTimeout(500);
  // A resize has to remeasure, not inherit whatever was true at the last size.
  ok(`the map is still there at ${w}px`,
    await page.$eval('#minimap', (n) => getComputedStyle(n).display !== 'none'),
    await page.$eval('#stage', (n) => `stage ${Math.round(n.clientWidth)}px`));
  ok(`and the guide still fits beside it at ${w}px`,
    await page.evaluate(() => {
      const st = document.getElementById('stage').getBoundingClientRect();
      const lanes = [...document.querySelectorAll('#stage .lane-r')];
      return Math.max(...lanes.map((n) => n.getBoundingClientRect().right)) <= st.right - 20;
    }));
}
// And it does go, when the guide really has no room for it.
await page.setViewportSize({ width: 900, height: 860 });
await page.waitForTimeout(500);
ok('but it does give way when the stage is genuinely too narrow',
  await page.evaluate(() => {
    const st = document.getElementById('stage');
    const shown = getComputedStyle(document.getElementById('minimap')).display !== 'none';
    return st.clientWidth >= 600 ? shown : !shown;
  }));
await page.setViewportSize({ width: 1600, height: 1000 });
await page.waitForTimeout(450);
ok('and it comes back when the window does',
  await page.$eval('#minimap', (n) => getComputedStyle(n).display !== 'none'));

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
await okDelete();
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
await okDelete();
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
ok('clicking an action item goes to the block it came from', (await gcount('.rowsel')) >= 1);

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
eq("the panel has five tabs, all at the guide's own altitude", await count('#railR .ptabs button'), 5);
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

// ---------------------------------------------------------------- reading mode
const titleSize = await page.evaluate(() =>
  getComputedStyle(document.querySelector('#pagehead h1')).fontSize);
// Out of any field first: a bare coordinate can land in a name now that the
// guide is fluid, and then 'p' is a letter rather than a command.
await pressAt('#stage', 8, 300);
await page.keyboard.press('p');
await page.waitForTimeout(250);
eq('the read button label flips to Exit', await text('#present'), 'Exit');
eq('the guide title is the same size wherever you are',
  await page.evaluate(() => getComputedStyle(document.querySelector('#pagehead h1')).fontSize),
  titleSize);
ok('reading mode hides both rails',
  await page.evaluate(() => getComputedStyle(document.getElementById('railL')).display === 'none'));
ok('and the tabs, which are not for the room',
  await page.evaluate(() => getComputedStyle(document.getElementById('tabs')).display === 'none'));
ok('but the page header stays, so the room knows which screen this is',
  await page.evaluate(() => getComputedStyle(document.getElementById('pagehead')).display !== 'none'));
ok('the stack gets wider for a shared screen',
  await page.evaluate(() => document.querySelector('.cell').getBoundingClientRect().width > 360));
ok('the content is still all there', (await gcount('.item')) > 5);
ok('and the whole header, not just the rails and tabs, is out of the room',
  await page.evaluate(() => getComputedStyle(document.getElementById('bar')).display === 'none'));
// The button in #bar goes with the header, so the mode has to carry its own way
// out. Reloading the page was the only reliable exit before this.
ok('reading mode carries a visible way out of itself',
  await page.evaluate(() => {
    const b = document.querySelector('#pagehead .rexit');
    if (!b) return false;
    const r = b.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(b).display !== 'none';
  }));
// The rails held the goals, the users, the sources and the design links, so
// reading a guide used to mean reading it without any of them.
ok('and the context the rails were holding comes inline',
  await page.evaluate(() => {
    const c = document.querySelector('#stage .rctx');
    return !!c && /user goal/i.test(c.textContent);
  }));
await page.click('#pagehead .rexit');
await page.waitForTimeout(250);
eq('and that button leaves the mode', await text('#present'), 'Read');

// Escape queued behind the selection and the caret before, so leaving took
// several presses from wherever you actually were.
await pick('Status');
await page.waitForTimeout(200);
await page.keyboard.press('p');
await page.waitForTimeout(250);
eq('reading mode can be entered with a block selected', await text('#present'), 'Exit');
await page.keyboard.press('Escape');
await page.waitForTimeout(250);
eq('and one Escape is enough to leave it', await text('#present'), 'Read');

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

// ---------------------------------------------------------------- the right panel resizes, collapses, and remembers its shape
// Last, because a reload throws away the in-memory document — every other
// test that depends on edits made along the way has to run before this one.
// A widened rail would also crowd the layout checks upstream, so this stays
// self-contained at the end rather than leaving the rail resized mid-suite.
const railWidthBefore = await page.$eval('#railR', (n) => n.getBoundingClientRect().width);
const rdrag = await page.$eval('.rdrag', (n) => {
  const r = n.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
await page.mouse.move(rdrag.x, rdrag.y);
await page.mouse.down();
await page.mouse.move(rdrag.x - 80, rdrag.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(250);
const railWidthAfter = await page.$eval('#railR', (n) => n.getBoundingClientRect().width);
ok('the right panel can be resized by dragging its left edge',
  railWidthAfter > railWidthBefore + 50,
  `before ${railWidthBefore} after ${railWidthAfter}`);

await page.click('.rcollapse');
await page.waitForTimeout(250);
const collapsedWidth = await page.$eval('#railR', (n) => n.getBoundingClientRect().width);
ok('collapsing the panel reclaims most of its width', collapsedWidth < 80, `width ${collapsedWidth}`);
ok('and leaves an obvious way back open', await page.$('.rexpand') !== null);

await page.click('.rexpand');
await page.waitForTimeout(250);
ok('expanding brings the panel straight back to the width it had',
  Math.abs((await page.$eval('#railR', (n) => n.getBoundingClientRect().width)) - railWidthAfter) < 3);

await page.reload();
await page.waitForSelector('#stage');
await page.click('.hello .btn.primary');
await page.waitForSelector('.item', { timeout: 8000 });
await page.waitForTimeout(300);
ok('the panel\'s resized width survives a reload',
  Math.abs((await page.$eval('#railR', (n) => n.getBoundingClientRect().width)) - railWidthAfter) < 3,
  `expected ~${railWidthAfter}, got ${await page.$eval('#railR', (n) => n.getBoundingClientRect().width)}`);

await page.click('.rcollapse');
await page.waitForTimeout(250);
await page.reload();
await page.waitForSelector('#stage');
await page.click('.hello .btn.primary');
await page.waitForSelector('.item', { timeout: 8000 });
await page.waitForTimeout(300);
ok('and the collapsed state survives one too', await page.$('.rexpand') !== null);

// ---------------------------------------------------------------- the panel, closed
/*
 * A single chevron said that something was hidden without saying what. The
 * collapsed rail is the only view of the panel you get while it is shut.
 */
await page.evaluate(() => { const b = document.querySelector('.rexpand'); if (b) b.click(); });
await page.waitForTimeout(300);
await page.click('#railR .rcollapse');
await page.waitForTimeout(350);
eq('the closed rail shows one icon per tab', await count('#railR .rmini'), 5);
ok('each one says which tab it is', await page.$$eval('#railR .rmini',
  (ns) => ns.every((n) => (n.getAttribute('aria-label') || '').length > 2)));
ok('and every one of them draws an icon', await page.$$eval('#railR .rmini svg', (ns) => ns.length === 5));
ok('a tab holding something carries a badge saying how much',
  await page.$$eval('#railR .rmini .b', (ns) => ns.length >= 1 && ns.every((n) => /^\d+$/.test(n.textContent))));
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#railR .rmini')].find((n) => /sources/i.test(n.getAttribute('aria-label') || ''));
  if (b) b.click();
});
await page.waitForTimeout(350);
ok('pressing one opens the panel on that tab',
  await page.evaluate(() => !document.getElementById('railR').classList.contains('collapsed')
    && !!document.querySelector('#railR .ptabs button.on[data-panel="sources"]')));

// ---------------------------------------------------------------- what is still open
await page.evaluate(() => { const t = [...document.querySelectorAll('#tabs button')]
  .find((x) => /open/i.test(x.textContent)); if (t) t.click(); });
await page.waitForTimeout(400);
// linkify returns a fragment; it used to be assigned to innerHTML, which
// stringifies to [object DocumentFragment] and told you nothing.
ok('every open item reads as itself, not as an object',
  !(await text('#stage')).includes('[object'));
ok('and the line you read first is the note, not the location',
  await page.$$eval('#stage .oi', (ns) => ns.length > 0 && ns.every((n) => {
    const t = n.querySelector('.t');
    return t && t.textContent.trim().length > 0;
  })));
ok('with the kind and the place underneath',
  await page.$$eval('#stage .oi .w', (ns) => ns.some((n) => /^(Action|Unanswered)\s+·/.test(n.textContent.trim()))));

// ---------------------------------------------------------------- who it is for
await page.evaluate(() => { const t = [...document.querySelectorAll('#tabs button')]
  .find((x) => /users/i.test(x.textContent)); if (t) t.click(); });
await page.waitForTimeout(400);
// A bare ?? on the end of a line tells you nothing about which field is unknown.
ok('a guide with no user goal says nothing rather than ??',
  await page.$$eval('#stage .usr .oi .w', (ns) => ns.every((n) => !/·\s*\?\?\s*$/.test(n.textContent))));

// ---------------------------------------------------------------- the four capabilities
await page.evaluate(() => { const t = [...document.querySelectorAll('#tabs button')]
  .find((x) => /guide/i.test(x.textContent)); if (t) t.click(); });
await page.waitForTimeout(300);
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Bookings'));
  if (b) b.click();
});
await page.waitForTimeout(400);
// The glyphs and the map existed all along; a single hardcoded search icon
// stood in for the lane, so all four looked the same.
ok('each capability draws its own glyph',
  await page.evaluate(() => {
    const cell = [...document.querySelectorAll('#stage .fn')]
      .find((n) => n.querySelectorAll('.caps .cap').length > 1);
    if (!cell) return false;
    const chips = [...cell.querySelectorAll('.caps .cap')];
    const paths = chips.map((c) => { const p = c.querySelector('path'); return p && p.getAttribute('d'); });
    return paths.every(Boolean) && new Set(paths).size === paths.length;
  }));
ok('and keeps its word beside it',
  await page.evaluate(() => {
    const chip = document.querySelector('#stage .fn .caps .cap');
    return !!chip && /[a-z]{3,}/.test(chip.textContent);
  }));

// ---------------------------------------------------------------- the annotation line
/*
 * A note and a functionality card belong to a block, so the line saying so is
 * permanent — not something you have to hover to discover. It is drawn only
 * where there is something on that side to tie, and it crosses the card's edge
 * so the two read as attached rather than adjacent.
 */
ok('a block with a note is tied to it without hovering',
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#stage .lane-l')]
      .filter((n) => n.querySelector('.note'));
    if (!rows.length) return false;
    return rows.every((n) => {
      const lead = n.querySelector('.lead');
      if (!lead) return false;
      const c = getComputedStyle(lead).borderTopColor;
      return c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
    });
  }));
ok('and a block with nothing beside it is tied to nothing',
  await page.evaluate(() => {
    const bare = [...document.querySelectorAll('#stage .lane-l')]
      .filter((n) => !n.querySelector('.note'));
    return bare.every((n) => {
      const lead = n.querySelector('.lead');
      if (!lead) return true;
      const c = getComputedStyle(lead).borderTopColor;
      return c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
    });
  }));
ok('the line crosses the card edge rather than stopping short of it',
  await page.evaluate(() => {
    const lane = [...document.querySelectorAll('#stage .lane-l')]
      .find((n) => n.querySelector('.note'));
    const lead = lane && lane.querySelector('.lead');
    const paper = document.querySelector('#stage .paper');
    if (!lead || !paper) return false;
    return lead.getBoundingClientRect().right > paper.getBoundingClientRect().left + 1;
  }));
ok('and it draws over the card, not under it',
  await page.evaluate(() => {
    const lead = document.querySelector('#stage .lane-l .lead');
    const paper = document.querySelector('#stage .paper');
    return !!lead && !!paper
      && parseInt(getComputedStyle(lead).zIndex, 10) > parseInt(getComputedStyle(paper).zIndex, 10);
  }));

// ---------------------------------------------------------------- a note keeps its own room
await pick('Status');
await page.waitForTimeout(250);
ok('the note text never runs under the tools that sit over it',
  await page.evaluate(() => {
    const note = document.querySelector('#stage .note.hastools');
    if (!note) return false;
    const tools = note.querySelector('.tools');
    const body = note.querySelector('.nbody');
    if (!tools || !body) return false;
    // The tools are positioned over the card, so the text is kept clear of them
    // by a reserved gutter rather than by flow.
    const gutter = parseFloat(getComputedStyle(body).paddingRight);
    const toolsW = tools.getBoundingClientRect().width;
    return gutter >= toolsW;
  }));
ok('and the gutter is there before you hover, so nothing rewraps under the cursor',
  await page.evaluate(() => {
    const body = document.querySelector('#stage .note.hastools .nbody');
    return !!body && parseFloat(getComputedStyle(body).paddingRight) > 20;
  }));

// ---------------------------------------------------------------- a design you can see
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Bookings'));
  if (b) b.click();
});
await page.waitForTimeout(300);
await panel(1);
await page.waitForTimeout(400);
eq('a linked picture gets a thumbnail, not just a URL', await count('#railR .dthumb'), 1);
ok('a picture that is not in the folder says so rather than showing a broken frame',
  (await text('#railR')).includes('Not found in this folder'));
ok('and a picture can be opened beside the guide, the way a Figma file can',
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('#railR .dcard')].find((n) => n.querySelector('.dthumb'));
    return !!card && !!card.querySelector('.sidebyside');
  }));
await page.evaluate(() => {
  const card = [...document.querySelectorAll('#railR .dcard')].find((n) => n.querySelector('.dthumb'));
  card.querySelector('.sidebyside').click();
});
await page.waitForTimeout(400);
ok('which opens a picture pane rather than an embed', await page.$('.beside .bimg') !== null);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

// ---------------------------------------------------------------- surfaces and colour
/*
 * The palette is the reason a dark theme is possible at all: every colour in
 * the app is a token, so one attribute on the root swaps all of them. A single
 * hardcoded value at a call site is a hole a dark theme falls through.
 */
ok('no colour is hardcoded at a call site — every one is a token',
  await page.evaluate(async () => {
    const css = await fetch('/index.html').then((r) => r.text());
    const style = css.slice(css.indexOf('<style>'), css.indexOf('</style>'));
    const afterTokens = style.slice(style.indexOf(':root[data-theme="dark"]'));
    const body = afterTokens.slice(afterTokens.indexOf('\n}\n') + 3);
    const lits = body.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g) || [];
    return lits.length === 0;
  }));

// A dialog is opened about something on the page, so the page has to stay
// visible behind it. An opaque scrim takes the context with it.
await pick('Status');
await page.waitForTimeout(200);
await page.evaluate(() => [...document.querySelectorAll('.rowsel .sbtn')]
  .find((b) => b.textContent.includes('Delete')).click());
await page.waitForSelector('.scrim .dialog');
ok('the scrim over a dialog is translucent, so the page stays visible behind it',
  await page.evaluate(() => {
    const bg = getComputedStyle(document.querySelector('.scrim')).backgroundColor;
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(',').map((n) => parseFloat(n));
    const alpha = parts.length > 3 ? parts[3] : 1;
    return alpha > 0.05 && alpha < 0.85;
  }));
ok('and the dialog itself is opaque, so its own text is readable',
  await page.evaluate(() => {
    const bg = getComputedStyle(document.querySelector('.dialog')).backgroundColor;
    const m = bg.match(/rgba\(([^)]+)\)/);
    return !m || parseFloat(m[1].split(',')[3]) === 1;
  }));
await cancelDelete();

// ---------------------------------------------------------------- one card per section
/*
 * A section is a card with a gap after it, so it rounds its own corners. Rounding
 * the guide's first and last cell left every interior boundary square, and the
 * guide's last cell is the trailing gap, which draws nothing.
 */
ok('each section is one card, rounded on all four corners',
  await page.evaluate(() => {
    const papers = [...document.querySelectorAll('#stage .paper')];
    return papers.length > 0
      && papers.every((n) => /^10px/.test(getComputedStyle(n).borderRadius));
  }));
ok('and there is exactly one card per section',
  await page.evaluate(() => {
    const secs = document.querySelectorAll('#stage .cell.sechead').length;
    return secs > 0 && document.querySelectorAll('#stage .paper').length === secs;
  }));
// Content-sized cells land on fractional pixels, so a background painted per
// cell antialiased every join into a faint grey seam. One element, one edge.
ok('nothing but the card and the section head paints a surface',
  await page.evaluate(() => [...document.querySelectorAll('#stage .cell')].every((n) => {
    const cs = getComputedStyle(n);
    const blank = cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.boxShadow === 'none';
    return blank || n.classList.contains('sechead');
  })));
ok('and the card cannot swallow a click meant for the page',
  await page.evaluate(() => [...document.querySelectorAll('#stage .paper')]
    .every((n) => getComputedStyle(n).pointerEvents === 'none')));
// The gap between two cards belongs to neither, so it draws nothing — otherwise
// the side lines run on and the two sections read as one card.
ok('the break between two sections draws nothing',
  await page.evaluate(() => [...document.querySelectorAll('#stage .cell.gap')].every((n) => {
    const cs = getComputedStyle(n);
    return cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.boxShadow === 'none';
  })));

// A card's shadow used to be painted by all of its cells at once, each with its
// own blur, so the edge stepped at every cell boundary.
ok('no cell paints a blurred shadow — the card edge cannot go wavy',
  await page.evaluate(() => [...document.querySelectorAll('#stage .cell')].every((n) => {
    const sh = getComputedStyle(n).boxShadow;
    if (sh === 'none') return true;
    // hairlines are box-shadows with no blur; anything with blur would stack
    return !/(\d+)px (\d+)px ([1-9]\d*)px/.test(sh);
  })));

// The section head was one weight step from a block label and nothing else.
ok('a section heading outranks a block label by size, not just weight',
  await page.evaluate(() => {
    const sec = document.querySelector('#stage .sec-title');
    const lbl = document.querySelector('#stage .lbl');
    if (!sec || !lbl) return false;
    return parseFloat(getComputedStyle(sec).fontSize) >= parseFloat(getComputedStyle(lbl).fontSize) + 1.5;
  }));
ok('and it sits on its own ground',
  await page.evaluate(() => {
    const head = document.querySelector('#stage .cell.sechead');
    const body = [...document.querySelectorAll('#stage .cell')]
      .find((n) => !n.classList.contains('sechead') && !n.classList.contains('gap')
        && !n.classList.contains('emptytop'));
    return head && body
      && getComputedStyle(head).backgroundColor !== getComputedStyle(body).backgroundColor;
  }));

// ---------------------------------------------------------------- dark
/*
 * Three states, not two: following the machine, and two overrides that stick.
 */
ok('there is a theme control', await page.$('#theme') !== null);
const rootBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const lightBg = await rootBg();
await page.click('#theme');           // system -> light
await page.waitForTimeout(150);
eq('choosing light stamps the root', await page.evaluate(() =>
  document.documentElement.getAttribute('data-theme')), 'light');
await page.click('#theme');           // light -> dark
await page.waitForTimeout(200);
eq('and choosing dark stamps it too', await page.evaluate(() =>
  document.documentElement.getAttribute('data-theme')), 'dark');
const darkBg = await rootBg();
ok('dark actually repaints the app', darkBg !== lightBg, `${lightBg} vs ${darkBg}`);
ok('text stays legible against it — no light-mode value left behind',
  await page.evaluate(() => {
    const lum = (c) => { const p = c.match(/\d+/g).map(Number);
      return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255; };
    const bg = lum(getComputedStyle(document.body).backgroundColor);
    const ink = lum(getComputedStyle(document.body).color);
    return bg < 0.3 && ink > 0.6;
  }));
ok('and the guide surfaces are dark too, not a white card on a dark page',
  await page.evaluate(() => {
    const lum = (c) => { const p = c.match(/\d+/g).map(Number);
      return (0.299 * p[0] + 0.587 * p[1] + 0.114 * p[2]) / 255; };
    const cell = document.querySelector('#stage .cell');
    return !!cell && lum(getComputedStyle(cell).backgroundColor) < 0.35;
  }));
// The map is a clone of the guide, so a theme it does not follow shows up here.
ok('the minimap survives a theme change', await page.evaluate(() =>
  getComputedStyle(document.getElementById('minimap')).display !== 'none'));
await page.click('#theme');           // dark -> system
await page.waitForTimeout(150);
ok('and a third press hands it back to the system', await page.evaluate(() =>
  !document.documentElement.hasAttribute('data-theme')));

// ---------------------------------------------------------------- no errors
ok('no uncaught errors anywhere in the session', errors.length === 0, errors.slice(0, 4).join('\n       '));
ok('and everything the app itself asked for loaded', badLoads.length === 0, badLoads.slice(0, 4).join('\n       '));

// A picture of the finished thing, on request, so a design change can be looked
// at rather than only asserted about: SHOTS=1 node browser-test.mjs
if (process.env.SHOTS) {
  await page.evaluate(() => {
    [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Bookings')).click();
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(HERE, 'screenshots', 'guide.png') });
  const cb = await page.$('#railR .ptabs button[data-panel="comments"]');
  if (cb) { await cb.click(); await page.waitForTimeout(400); }
  const rail = await page.$('#railR');
  if (rail) await rail.screenshot({ path: path.join(HERE, 'screenshots', 'comments-panel.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(HERE, 'screenshots', 'laptop.png') });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.waitForTimeout(400);
  const map = await page.$('#minimap');
  if (map) {
    const r = await map.boundingBox();
    await page.screenshot({ path: path.join(HERE, 'screenshots', 'minimap.png'),
      clip: { x: r.x - 4, y: r.y, width: r.width + 8, height: Math.min(r.height, 460) },
      scale: 'device' });
  }
  console.log('  screenshots/guide.png, screenshots/panel-tabs.png');
}

await browser.close();
server.kill();

console.log(`\n  ${pass} passed${fails.length ? `, ${fails.length} FAILED` : ''}\n`);
for (const f of fails) console.log(`  FAIL  ${f}\n`);
process.exit(fails.length ? 1 : 0);
