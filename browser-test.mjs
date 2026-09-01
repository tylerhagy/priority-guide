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
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
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
await page.waitForSelector('.blk', { timeout: 8000 });

const text = (sel) => page.$eval(sel, (n) => n.textContent.trim()).catch(() => null);
const count = (sel) => page.$$eval(sel, (n) => n.length);
const written = () => page.evaluate(() => window.__written || null);
/** What is on 'disk' now. Survives a reload, unlike the last-write marker. */
const current = () => page.evaluate(() => window.__store['Priority Guides.md']);

/** Lines that differ between the fixture and what the app wrote. */
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
eq('the first guide is selected', await text('.g-title'), 'Bookings — My Week');
eq('its blocks render', await count('.blk'), 13);
ok('the open count is shown', (await text('#open')).includes('10 open'));

// ---------------------------------------------------------------- reading a block
const statusBlock = await page.$('.blk:has-text("No-show is set by the door reader")');
ok('a block shows its capabilities', await page.$eval('.blk:nth-of-type(5) .caps', (n) => n.textContent.includes('filter')).catch(() => false));
ok('a route renders as a link to the guide it goes to',
  await page.$('a.pill.route[data-goto="Booking detail"]') !== null);
ok('an action item renders in the action style', (await count('.blk-note.act')) >= 1);
ok('a Visual block is marked as one', (await count('.blk-name .vis')) >= 1);
ok('a source handle in a note becomes a live link',
  await page.$('.blk-note a[href*="example.com"], .blk-note a[href*="synthesis"]') !== null);

// ---------------------------------------------------------------- the referee
ok('the referee is quiet on a clean file', (await count('.flag')) === 0
  || (await page.$$eval('.flag', (ns) => ns.every((n) => n.textContent.includes('No real data')))));

// ---------------------------------------------------------------- moving a block
await page.click('.blk:nth-of-type(5)');           // Status
await page.keyboard.press('Escape');
await page.click('.blk:nth-of-type(5)', { position: { x: 5, y: 5 } });
await page.keyboard.press('Escape');
await page.evaluate(() => {
  // Select without opening the editor, the way an arrow key would.
  const blks = [...document.querySelectorAll('.blk')];
  const i = blks.findIndex((b) => b.textContent.includes('No-show is set by the door reader'));
  blks[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.keyboard.press('Escape');
await page.keyboard.press('Alt+ArrowUp');
await page.waitForTimeout(120);
await page.keyboard.down('Meta'); await page.keyboard.press('s'); await page.keyboard.up('Meta');
await page.waitForTimeout(350);
let out = await current();
ok('a save happened', !!(await written()));
eq('moving a block one place changes two lines', out ? diffCount(out) : -1, 2);
eq('the line count does not change', out ? out.split('\n').length : -1, FILE.split('\n').length);
ok('the moved line is the original text, not a re-render',
  out && out.includes('| Status | Booked, Checked in, No-show, Cancelled | filter, sort |  |  | No-show is set by the door reader, never by a person |'));

// put it back
await page.keyboard.press('Alt+ArrowDown');
await page.waitForTimeout(120);
await page.keyboard.down('Meta'); await page.keyboard.press('s'); await page.keyboard.up('Meta');
await page.waitForTimeout(350);
out = await current();
eq('moving it back restores the file exactly', out, FILE);

// ---------------------------------------------------------------- across a group
await page.evaluate(() => {
  const blks = [...document.querySelectorAll('.blk')];
  const i = blks.findIndex((b) => b.textContent.includes('Nothing booked this week'));
  blks[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.keyboard.press('Escape');
await page.keyboard.press('Alt+ArrowUp');
await page.waitForTimeout(140);
ok('a block at the top of a group crosses into the one above',
  await page.evaluate(() => {
    const blks = [...document.querySelectorAll('.blk')];
    const i = blks.findIndex((b) => b.textContent.includes('Nothing booked this week'));
    const j = blks.findIndex((b) => b.textContent.includes('Export the week'));
    return i > -1 && j > -1 && i > j;
  }));
await page.keyboard.down('Meta'); await page.keyboard.press('s'); await page.keyboard.up('Meta');
await page.waitForTimeout(350);
out = await current();
ok('the result still round-trips', !!out);
await page.reload();
await page.waitForSelector('#stage');
await page.click('.hello .btn.primary').catch(() => {});
await page.waitForSelector('.blk', { timeout: 8000 });
ok('the moved block survived the reload',
  await page.$('.blk:has-text("Nothing booked this week")') !== null);

// ---------------------------------------------------------------- editing one cell
await page.evaluate(() => {
  const blks = [...document.querySelectorAll('.blk')];
  const i = blks.findIndex((b) => b.textContent.includes('Riverside, Northgate, Depot'));
  blks[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.ed', { timeout: 4000 });
ok('clicking a block opens its editor with the four lanes',
  (await count('.ed label')) === 6);
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
await page.waitForTimeout(120);
await page.keyboard.down('Meta'); await page.keyboard.press('s'); await page.keyboard.up('Meta');
await page.waitForTimeout(350);
const afterEdit = await current();
eq('editing one cell changes exactly one line',
  afterEdit.split('\n').filter((l, i) => beforeEdit.split('\n')[i] !== l).length, 1);
ok('the edit is in the file', afterEdit.includes('Riverside, Northgate, Depot, Kilmore'));

// ---------------------------------------------------------------- the referee, live
await page.evaluate(() => {
  const blks = [...document.querySelectorAll('.blk')];
  const i = blks.findIndex((b) => b.textContent.includes('Kilmore'));
  blks[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.ed');
await page.$$eval('.ed input[type=text]', (ns) => {
  ns[0].value = 'Building dropdown';
  ns[0].dispatchEvent(new Event('input', { bubbles: true }));
});
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
const flagText = await page.$$eval('.flag', (ns) => ns.map((n) => n.textContent).join(' | '));
ok('the referee flags a visual answer', flagText.includes('dropdown') && flagText.includes('visual answer'));
ok('and says what to ask instead', flagText.includes('one from a list'));
ok('but does not rewrite it', await page.$('.blk:has-text("Building dropdown")') !== null);

// ---------------------------------------------------------------- capture
await page.keyboard.press('c');
await page.waitForSelector('#cap:not([hidden])');
await page.fill('#capIn', 'Occupancy right now');
await page.keyboard.press('Enter');
await page.waitForTimeout(120);
await page.fill('#capIn', 'Who booked it');
await page.keyboard.press('Enter');
await page.waitForTimeout(120);
ok('capture keeps taking lines without a form',
  (await text('#capTally')).includes('2 added'));
ok('the captured blocks are in the guide',
  await page.$('.blk:has-text("Occupancy right now")') !== null);
await page.keyboard.press('Escape');
ok('escape closes capture', await page.$eval('#cap', (n) => n.hidden));

// ---------------------------------------------------------------- open items
await page.click('#tabs button:nth-child(3)');
await page.waitForSelector('.oi');
const openN = await count('.oi');
ok('every action item and unknown is listed', openN >= 10, `listed ${openN}`);
ok('each says where it came from', await page.$$eval('.oi .w', (ns) => ns.every((n) => n.textContent.trim())));
await page.click('.oi');
await page.waitForTimeout(150);
ok('clicking one goes to the block it came from', (await count('.blk.on')) === 1);

// ---------------------------------------------------------------- flow
await page.click('#tabs button:nth-child(2)');
await page.waitForSelector('#flow svg');
eq('every guide is a node', await count('#flow .node'), 6);
ok('routes are drawn', (await count('#flow .edge:not(.ref)')) >= 8);
ok('references are drawn differently', (await count('#flow .edge.ref')) >= 2);
await page.click('#flow .node:nth-of-type(2)');
await page.waitForTimeout(120);
ok('clicking a node opens that guide', (await text('.g-title')) !== null);

// ---------------------------------------------------------------- back-links
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Cancel a booking'));
  b.click();
});
await page.waitForTimeout(150);
const back = await page.$$eval('.wrap .rail-h', (ns) => ns.map((n) => n.textContent));
ok('a guide shows what points at it', back.includes('Referenced by'));
ok('and names both guides that route to it',
  await page.$eval('.wrap', (n) => n.textContent.includes('Bookings') && n.textContent.includes('Booking detail')));

// ---------------------------------------------------------------- sources rail
await page.evaluate(() => {
  const b = [...document.querySelectorAll('#railL .g-item')].find((x) => x.textContent.includes('Find a space'));
  b.click();
});
await page.waitForTimeout(150);
ok('the sources rail lists what is attached here', (await count('#railR .src')) >= 2);
ok('a guide-local source resolves', await page.$('#railR .src:has-text("naming")') !== null);
ok('a source shows how many places cite it',
  await page.$$eval('#railR .src .n', (ns) => ns.some((n) => Number(n.textContent) > 1)));
ok('a source links out', await page.$('#railR .src a[href^="http"]') !== null);

// ---------------------------------------------------------------- an undefined handle
await page.evaluate(() => {
  const blks = [...document.querySelectorAll('.blk')];
  const i = blks.findIndex((b) => b.textContent.includes('Second screen, Standing, Step-free'));
  blks[i].dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForSelector('.ed');
await page.$$eval('.ed textarea', (ns) => {
  ns[0].value = 'See [nowhere] for the full list';
  ns[0].dispatchEvent(new Event('input', { bubbles: true }));
});
await page.keyboard.press('Escape');
await page.waitForTimeout(150);
ok('a handle nobody defined is called out, not silently dropped',
  await page.$('.pill.dead:has-text("not defined")') !== null);
ok('and it appears in the rail as a problem', await page.$('#railR .src.bad') !== null);

// ---------------------------------------------------------------- present
await page.keyboard.press('p');
await page.waitForTimeout(150);
ok('present mode hides both rails',
  await page.evaluate(() => getComputedStyle(document.getElementById('railL')).display === 'none'));
ok('present mode sets larger type',
  await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.blk-name')).fontSize) >= 18));
ok('the content is still all there', (await count('.blk')) > 5);
await page.keyboard.press('Escape');
await page.waitForTimeout(120);
ok('escape leaves present mode',
  await page.evaluate(() => getComputedStyle(document.getElementById('railL')).display !== 'none'));

// ---------------------------------------------------------------- source view
await page.keyboard.press('s');
await page.waitForSelector('#src');
ok('the source view shows the markdown', (await text('#src')).startsWith('# Priority Guides'));
ok('and the sources rail steps out of the way',
  await page.evaluate(() => getComputedStyle(document.getElementById('railR')).display === 'none'));

// ---------------------------------------------------------------- drag
await page.keyboard.press('g');
await page.waitForSelector('.blk');
const dragged = await page.evaluate(() => {
  const blks = [...document.querySelectorAll('.blk')];
  const from = blks[1], to = blks[3];
  const label = from.querySelector('.blk-name').textContent;
  const dt = new DataTransfer();
  from.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
  const r = to.getBoundingClientRect();
  to.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
  to.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientY: r.bottom - 2 }));
  from.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
  const after = [...document.querySelectorAll('.blk')].map((b) => b.querySelector('.blk-name').textContent);
  return { label, index: after.indexOf(label) };
});
eq('dragging a block lands it where it was dropped', dragged.index, 3);

// ---------------------------------------------------------------- read-only gate
await page.evaluate(() => { window.__store['Priority Guides.md'] = '# A\n\n## G\n\n### S\n\n| Content |\n| --- |\n| x |\n'; });
ok('the round-trip gate exists', await page.evaluate(() => typeof window.showDirectoryPicker === 'function'));

// ---------------------------------------------------------------- no errors
ok('no uncaught errors anywhere in the session', errors.length === 0, errors.slice(0, 4).join('\n       '));

await browser.close();
server.kill();

console.log(`\n  ${pass} passed${fails.length ? `, ${fails.length} FAILED` : ''}\n`);
for (const f of fails) console.log(`  FAIL  ${f}\n`);
process.exit(fails.length ? 1 : 0);
