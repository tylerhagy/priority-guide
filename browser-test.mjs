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
const save = async () => {
  await page.keyboard.down('Meta'); await page.keyboard.press('s'); await page.keyboard.up('Meta');
  await page.waitForTimeout(400);
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
eq('the first guide is selected', await text('.ghead h1'), 'Bookings — My Week');
eq('its blocks render as items in the stack', await count('.item'), 13);
ok('the open count is shown', (await text('#open')).includes('10 open'));

// ---------------------------------------------------------------- the three lanes
ok('the guide is a three-lane grid',
  await page.$eval('.guide', (n) => getComputedStyle(n).gridTemplateColumns.split(' ').length === 3));
ok('the stack sits in the middle lane',
  await page.$eval('.cell', (n) => getComputedStyle(n).gridColumnStart === '2'));
ok('notes annotate from the left', (await count('.lane-l .ann')) >= 3);
ok('functionality annotates from the right', (await count('.lane-r .ann')) >= 8);
ok('each annotation is joined to its row by a leader', (await count('.lead')) >= 10);
ok('an action item is styled as one', (await count('.lane-l .ann.act')) >= 1);
ok('a tall annotation does not tear a hole in the section panel',
  await page.evaluate(() => [...document.querySelectorAll('.band')]
    .every((b) => Math.abs(b.getBoundingClientRect().height - b.parentElement.getBoundingClientRect().height) < 2)));

// ---------------------------------------------------------------- the stack itself
ok('a data point with no control is plain text, not a box', (await count('.item.plain')) >= 4);
ok('a field with a form type renders as a control',
  (await count('.item:not(.plain):not(.linky):not(.visual)')) >= 1);
ok('a link renders as a link', (await count('.item.linky')) >= 2);
ok('a visual is marked as one', (await count('.item.visual')) >= 1);
ok('a select shows it has more behind it', (await count('.item .chev')) >= 1);

// ---------------------------------------------------------------- icons
ok('functionality is shown as an icon, not only a word', (await count('.lane-r .ann > svg')) >= 8);
ok('capabilities are icons too', (await count('.ann .caps svg')) >= 4);
ok('every functionality icon carries its name for a tooltip and a screen reader',
  await page.$$eval('.lane-r .ann > svg title', (ns) => ns.length > 0 && ns.every((n) => n.textContent.trim())));

// ---------------------------------------------------------------- routes
ok('a route renders as a link to the guide it goes to',
  await page.$('.ann a.tgt[data-goto="Booking detail"]') !== null);
await page.click('.ann a.tgt[data-goto="Booking detail"]');
await page.waitForTimeout(250);
eq('following a route opens that guide', await text('.ghead h1'), 'Booking detail');

// ---------------------------------------------------------------- a source on one block
ok('a source attached to one block shows on that block',
  await page.evaluate(() => [...document.querySelectorAll('.lane-r .ann')]
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
  out.includes('| Status | Booked, Checked in, No-show, Cancelled | filter, sort |  |  | No-show is set by the door reader, never by a person |'));

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
await page.waitForSelector('.ed', { timeout: 4000 });
eq('the editor carries every lane plus a source', await count('.ed label'), 7);
ok('the form types offered are functionality, never a visual solution',
  await page.$$eval('.ed select', (ns) => {
    const opts = [...ns[1].options].map((o) => o.value);
    return opts.includes('single select') && !opts.includes('dropdown');
  }));
const beforeEdit = await current();
await page.$$eval('.ed input[type=text]', (ns) => {
  ns[1].value = 'Riverside, Northgate, Depot, Kilmore';
  ns[1].dispatchEvent(new Event('input', { bubbles: true }));
});
await page.keyboard.press('Escape');
await page.waitForTimeout(180);
await save();
const afterEdit = await current();
eq('editing one cell changes exactly one line',
  afterEdit.split('\n').filter((l, i) => beforeEdit.split('\n')[i] !== l).length, 1);
ok('the edit is in the file', afterEdit.includes('Riverside, Northgate, Depot, Kilmore'));

// ---------------------------------------------------------------- the referee, live
await pick('Building');
await page.waitForSelector('.ed', { timeout: 4000 });
await page.$$eval('.ed input[type=text]', (ns) => {
  ns[0].value = 'Building dropdown';
  ns[0].dispatchEvent(new Event('input', { bubbles: true }));
});
await page.keyboard.press('Escape');
await page.waitForTimeout(200);
const flagText = await page.$$eval('.flag', (ns) => ns.map((n) => n.textContent).join(' | '));
ok('the referee flags a visual answer', flagText.includes('dropdown') && flagText.includes('visual answer'));
ok('and says what to ask instead', flagText.includes('one from a list'));
ok('but does not rewrite it', await hasItem('Building dropdown'));

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

// ---------------------------------------------------------------- users
await page.click('#tabs button:nth-child(3)');
await page.waitForSelector('.usr');
eq('every user type in the file is listed', await count('.usr'), 3);
ok('each names its guides', (await count('.usr .oi')) >= 10);
eq('the group that uses the most screens comes first', await text('.usr .n'), 'Everyone with a desk');
ok('a guide says whether it is their main screen',
  await page.evaluate(() => [...document.querySelectorAll('.usr .oi')].some((n) => n.textContent.includes('their main screen'))));
await page.click('.usr .btn');
await page.waitForTimeout(300);
ok('presenting a group narrows the session to their guides', await page.$('#userbar') !== null);
ok('and says whose session it is', (await text('#userbar')).includes('Everyone with a desk'));
await page.keyboard.press('Escape');
await page.waitForTimeout(180);
await page.click('#userbar .quiet');
await page.waitForTimeout(250);
eq('clearing it brings every guide back', await count('#railL .g-item'), 6);

// ---------------------------------------------------------------- open items
await page.click('#tabs button:nth-child(4)');
await page.waitForSelector('.oi');
const openN = await count('.oi');
ok('every action item and unknown is listed', openN >= 10, `listed ${openN}`);
ok('each says where it came from', await page.$$eval('.oi .w', (ns) => ns.every((n) => n.textContent.trim())));
await page.click('.oi');
await page.waitForTimeout(250);
ok('clicking one goes to the block it came from', (await count('.rowsel')) >= 1);

// ---------------------------------------------------------------- flow
await page.click('#tabs button:nth-child(2)');
await page.waitForSelector('#flow svg');
eq('every guide is a node', await count('#flow .node'), 6);
ok('routes are drawn', (await count('#flow .edge:not(.ref)')) >= 8);
ok('references are drawn differently', (await count('#flow .edge.ref')) >= 2);
ok('the sources rail steps out of the way of a file-wide view',
  await page.evaluate(() => getComputedStyle(document.getElementById('railR')).display === 'none'));

// ---------------------------------------------------------------- sources
await page.click('#tabs button:nth-child(1)');
await page.waitForTimeout(250);
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

// ---------------------------------------------------------------- primary users
ok('primary users are discrete chips', (await count('.ghead .chip:not(.add)')) >= 2);
ok('the power user is marked', (await count('.ghead .chip.pri')) >= 1);
await page.click('.ghead .chip.add');
await page.waitForSelector('.chip input');
ok('adding one offers the types already in the file',
  await page.$eval('.chip input', (n) => n.getAttribute('list') === 'usertypes'));
ok('and those types are listed', (await count('#usertypes option')) >= 3);
await page.fill('.chip input', 'visitor host');
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
await save();
ok('a case-different match reuses the existing type instead of making a second one',
  (await line('**Primary users:**')).includes('Visitor host')
  && !(await line('**Primary users:**')).includes('visitor host'),
  await line('**Primary users:**'));

// ---------------------------------------------------------------- present
await page.keyboard.press('p');
await page.waitForTimeout(250);
eq('the present button becomes the way out', await text('#present'), 'Exit');
ok('present mode hides both rails',
  await page.evaluate(() => getComputedStyle(document.getElementById('railL')).display === 'none'));
ok('and the tabs, which are not for the room',
  await page.evaluate(() => getComputedStyle(document.getElementById('tabs')).display === 'none'));
ok('the stack gets wider for a shared screen',
  await page.evaluate(() => document.querySelector('.cell').getBoundingClientRect().width > 340));
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
  const items = [...document.querySelectorAll('.item')];
  const from = items[1], to = items[3];
  const label = from.textContent.trim();
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const r = to.getBoundingClientRect();
  const cell = to.closest('.cell');
  cell.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
  cell.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  const after = [...document.querySelectorAll('.item')].map((b) => b.textContent.trim());
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
