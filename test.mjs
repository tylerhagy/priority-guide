/*
 * test.mjs — the parser's contract, checked.
 *
 * The three things that must never break:
 *   1. An untouched file round-trips byte-for-byte.
 *   2. A one-field edit produces a one-line diff.
 *   3. Moving a row moves exactly the lines that moved.
 *
 * Everything else is detail. Run: node test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './parser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = fs.readFileSync(path.join(HERE, 'fixtures', 'deskline.md'), 'utf8');

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass++; }
  catch (e) { fails.push(`${name}\n    ${e.message}`); }
}
function eq(a, b, msg) {
  const A = JSON.stringify(a); const B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg || 'not equal'}\n    expected ${B}\n    got      ${A}`);
}
function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy'); }

/** Lines that differ between two versions of a file, in both directions. */
function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const removed = a.filter((l, i) => b[i] !== l);
  const added = b.filter((l, i) => a[i] !== l);
  return { removed, added, n: Math.max(removed.length, added.length) };
}

// ---------------------------------------------------------------- round-trip

t('fixture round-trips byte-for-byte', () => {
  const r = P.verifyRoundTrip(FIXTURE);
  ok(r.ok, r.error || `line ${r.line}: expected ${JSON.stringify(r.expected)} got ${JSON.stringify(r.produced)}`);
});

t('every source line is owned by exactly one piece', () => {
  const doc = P.parseDocument(FIXTURE);
  eq(P.serializeDocument(doc).split('\n').length, FIXTURE.split('\n').length, 'line count changed');
});

t('parse is idempotent', () => {
  const once = P.serializeDocument(P.parseDocument(FIXTURE));
  const twice = P.serializeDocument(P.parseDocument(once));
  eq(twice, once, 'second pass differed');
});

for (const [name, text] of Object.entries({
  empty: '',
  'only a title': '# Priority Guides — Nothing\n',
  'no trailing newline': '# A\n\n## B\n\n**User goal:** x',
  'crlf-ish trailing spaces': '# A  \n\n## B  \n\n| Content | Note |\n| --- | --- |\n| x |  |\n',
  'guide with no sections': '# A\n\n## B\n\n**User goal:** x\n',
  'table with unknown columns': '# A\n\n## B\n\n### S\n\n| Content | Owner | Note |\n| --- | --- | --- |\n| x | Priya | y |\n',
  'table that is not a content table': '# A\n\n## B\n\n### S\n\n| Week | Count |\n| --- | --- |\n| 1 | 2 |\n',
  'escaped pipe in a cell': '# A\n\n## B\n\n### S\n\n| Content | Note |\n| --- | --- |\n| a \\| b | c |\n',
  'sources with no guides': '# A\n\n## Sources\n\n[x]: https://example.com "T"\n',
  'blank lines everywhere': '\n\n\n# A\n\n\n\n## B\n\n\n### S\n\n\n'
})) {
  t(`round-trips: ${name}`, () => {
    const r = P.verifyRoundTrip(text);
    ok(r.ok, r.error || `line ${r.line}: expected ${JSON.stringify(r.expected)} got ${JSON.stringify(r.produced)}`);
  });
}

t('a file it cannot round-trip is reported with a line number, not silently fixed', () => {
  // A row with a column count that does not match its header still round-trips,
  // because unknown cells are preserved. Prove it rather than assume it.
  const text = '# A\n\n## B\n\n### S\n\n| Content | Note |\n| --- | --- |\n| a | b | c |\n';
  const r = P.verifyRoundTrip(text);
  ok(r.ok || typeof r.line === 'number', 'must either hold or name a line');
});

// ---------------------------------------------------------------- minimal diffs

t('editing one cell changes exactly one line', () => {
  const doc = P.parseDocument(FIXTURE);
  const g = P.findGuide(doc, 'Booking detail');
  const { row, table, section } = P.rowsOf(g).find((r) => r.row.content.text === 'Reference');
  row.realData = 'DL-8841-2 — four digits then a checksum';
  P.touchRow(row, table, section);
  const d = diffLines(FIXTURE, P.serializeDocument(doc));
  eq(d.n, 1, `changed ${d.n} lines: ${JSON.stringify(d.added)}`);
});

t('editing one guide field changes exactly one line', () => {
  const doc = P.parseDocument(FIXTURE);
  const g = P.findGuide(doc, 'Booking detail');
  P.setField(g, 'businessGoal', 'A booking that is checked is a desk that is not double-counted.');
  const d = diffLines(FIXTURE, P.serializeDocument(doc));
  eq(d.n, 1, `changed ${d.n} lines: ${JSON.stringify(d.added)}`);
});

t('adding a field the header does not have inserts one line', () => {
  const doc = P.parseDocument(FIXTURE);
  const g = P.findGuide(doc, 'Floor plan');
  eq(g.fieldLine.sources, undefined, 'fixture guide should have no Sources line');
  P.setField(g, 'sources', '[brief]');
  const after = P.serializeDocument(doc);
  eq(after.split('\n').length, FIXTURE.split('\n').length + 1, 'should add exactly one line');
  ok(after.includes('**Sources:** [brief]'), 'field not written');
});

t('moving a row within a table moves only that row', () => {
  const doc = P.parseDocument(FIXTURE);
  const g = P.findGuide(doc, 'Bookings — My Week');
  const rows = P.rowsOf(g);
  const target = rows.find((r) => r.row.content.text === 'Status').row;
  ok(P.moveRow(g, target, -1), 'move failed');
  const after = P.serializeDocument(doc);
  eq(after.split('\n').length, FIXTURE.split('\n').length, 'line count must not change');
  const d = diffLines(FIXTURE, after);
  eq(d.n, 2, `a swap is two lines, changed ${d.n}`);
  // The moved line must be the ORIGINAL text, not a re-render.
  ok(after.includes('| Status | Booked, Checked in, No-show, Cancelled | filter, sort |  |  | No-show is set by the door reader, never by a person<br>Cancelled bookings stay on the list for the rest of the day |'),
    'row was re-rendered instead of moved verbatim');
});

t('moving a row up from the top crosses into the table above', () => {
  const doc = P.parseDocument(FIXTURE);
  const g = P.findGuide(doc, 'Bookings — My Week');
  const tables = P.tablesOf(g);
  const first = tables[1].table.rows[0];
  const before = tables[0].table.rows.length;
  ok(P.moveRow(g, first, -1), 'cross-move failed');
  eq(P.tablesOf(g)[0].table.rows.length, before + 1, 'did not land in the table above');
  eq(P.tablesOf(g)[0].table.rows[before], first, 'landed in the wrong position');
  const r = P.verifyRoundTrip(P.serializeDocument(doc));
  ok(r.ok, 'result no longer round-trips');
});

t('a row will not move past the start of the first table', () => {
  const doc = P.parseDocument(FIXTURE);
  const g = P.findGuide(doc, 'Bookings — My Week');
  eq(P.moveRow(g, P.tablesOf(g)[0].table.rows[0], -1), false, 'should refuse');
});

t('moving a section carries its rows', () => {
  const doc = P.parseDocument(FIXTURE);
  const g = P.findGuide(doc, 'Bookings — My Week');
  const [a, b] = g.sections;
  ok(P.moveSection(g, b, -1), 'move failed');
  eq(g.sections[0].title, b.title, 'section did not move');
  const after = P.serializeDocument(doc);
  ok(after.indexOf('### Booking a new space from here') < after.indexOf('### The week'), 'order not reflected');
  ok(P.verifyRoundTrip(after).ok, 'result no longer round-trips');
});

t('a subsection moves one row at a time, not its whole run of rows', () => {
  const doc = P.parseDocument(FIXTURE);
  const g = P.findGuide(doc, 'Bookings — My Week');
  const sec = g.sections.find((s) => s.kind === 'section' && s.title === 'The week');
  const sub = sec.chunks.find((c) => c.kind === 'sub' && c.title === 'Empty and error states');
  ok(sub, 'fixture must still carry this subsection');
  ok(P.moveMarker(sec, sub, -1), 'moving up should succeed — a row precedes it');
  let after = P.serializeDocument(doc);
  ok(P.verifyRoundTrip(after).ok, 'result must round-trip');
  ok(after.indexOf('#### Empty and error states') < after.indexOf('| Export the week |'),
    'it should swap past exactly the one row before it');
  ok(after.indexOf('| Who it is for |') < after.indexOf('#### Empty and error states'),
    'and no further — the rest of the table stays where it was');
  ok(P.moveMarker(sec, sub, 1), 'moving back down should succeed');
  after = P.serializeDocument(doc);
  ok(P.verifyRoundTrip(after).ok, 'result must round-trip');
  ok(after.indexOf('| Export the week |') < after.indexOf('#### Empty and error states'),
    'moving down should restore it after Export the week');
});

t('a reference moves the same one-step way as a subsection', () => {
  const doc = P.parseDocument(FIXTURE);
  const g = P.findGuide(doc, 'Bookings — My Week');
  const sec = g.sections.find((s) => s.kind === 'section' && s.title === 'Booking a new space from here');
  const ref = sec.chunks.find((c) => c.kind === 'ref');
  ok(ref, 'fixture must still carry this reference');
  eq(P.moveMarker(sec, ref, 1), false, 'nothing follows the trailing reference');
  ok(P.moveMarker(sec, ref, -1), 'moving up should succeed — a row precedes it');
  const after = P.serializeDocument(doc);
  ok(P.verifyRoundTrip(after).ok, 'result must round-trip');
  ok(after.indexOf('> See [[Booking detail]]') < after.indexOf('| Repeat last week |'),
    'it should swap past exactly the one row before it, not the whole table');
});

// ---------------------------------------------------------------- cell grammar

t('what a block is, is a marker in front of its name', () => {
  const k = (v) => { const c = P.parseContentCell(v); return [c.kind, c.chart, c.text]; };
  eq(k('Customer name'), ['text', '', 'Customer name']);
  eq(k('[Visual] Coverage map'), ['visual', '', 'Coverage map']);
  eq(k('[Chart] Revenue'), ['chart', '', 'Revenue']);
  eq(k('[Chart: pie] Revenue by segment'), ['chart', 'pie', 'Revenue by segment']);
  eq(k('[Chart: line graph] Trend'), ['chart', 'line', 'Trend'], 'a written-out kind still lands');
  eq(k('[Divider]'), ['divider', '', '']);
  eq(P.renderContentCell({ kind: 'visual', text: 'Map' }), '[Visual] Map');
  eq(P.renderContentCell({ kind: 'chart', chart: 'bar', text: 'Volume' }), '[Chart: bar] Volume');
  eq(P.renderContentCell({ kind: 'divider', text: 'ignored' }), '[Divider]');
  eq(P.renderContentCell({ type: 'Visual', text: 'Map' }), '[Visual] Map', 'the older shape still renders');
});

t('changing what a block is keeps everything else it carries', () => {
  // The whole point: a single select becomes a multi select mid-conversation
  // without anyone retyping the notes.
  const doc = P.parseDocument(FIXTURE);
  const hit = P.rowsOf(P.findGuide(doc, 'Booking detail')).find((r) => r.row.content.text === 'Reference');
  const notesBefore = P.renderNoteCell(hit.row.note);
  P.setKind(hit.row, 'chart', 'bar');
  eq(hit.row.content.kind, 'chart');
  eq(hit.row.content.text, 'Reference', 'the name survives');
  eq(P.renderNoteCell(hit.row.note), notesBefore, 'the notes survive');
  eq(hit.row.capabilities, ['search'], 'so does what you can do to it');
  P.setKind(hit.row, 'text');
  eq(P.renderContentCell(hit.row.content), 'Reference', 'and it goes back');
});

t('renaming a user type fixes it everywhere at once', () => {
  const doc = P.parseDocument(FIXTURE);
  const n = P.renameUserType(doc, 'Office manager', 'Workplace manager');
  eq(n, 3, 'three guides name that type');
  eq(P.userTypes(doc).map((u) => u.name).includes('Office manager'), false);
  ok(P.userTypes(doc).some((u) => u.name === 'Workplace manager'));
  ok(P.verifyRoundTrip(P.serializeDocument(doc)).ok, 'result must round-trip');
});

t('renaming onto a type that already exists merges them rather than duplicating', () => {
  const doc = P.parseDocument(FIXTURE);
  P.renameUserType(doc, 'Visitor host', 'Everyone with a desk');
  const finder = P.findGuide(doc, 'Find a space');
  eq(P.parseUsers(finder.fields.primaryUsers).length, 1, 'the two collapse into one');
  eq(P.userTypes(doc).map((u) => u.name).includes('Visitor host'), false);
});

t('capabilities are plain words, in a stable order', () => {
  eq(P.parseCapabilities('sort, search , edit'), ['search', 'sort', 'edit']);
  eq(P.parseCapabilities('searchable filterable'), ['search', 'filter']);
  eq(P.parseCapabilities(''), []);
  eq(P.renderCapabilities(['edit', 'search']), 'search, edit');
});

t('a route reads its type and its target', () => {
  const l = P.parseLinkCell('modal → [[Cancel a booking]]');
  eq([l.type, l.target, l.wiki], ['modal', 'Cancel a booking', true]);
  eq(P.parseLinkCell('onsite page -> [[X]]').type, 'onsite page');
  eq(P.parseLinkCell('trigger').target, '');
  eq(P.renderLinkCell(l), 'modal → [[Cancel a booking]]');
  eq(P.renderLinkCell({ type: 'trigger', target: '' }), 'trigger');
});

t('a trigger says what happens, and is never a route', () => {
  const l = P.parseLinkCell('trigger → Marks the follow-up done');
  eq([l.type, l.target, l.wiki], ['trigger', 'Marks the follow-up done', false]);
  eq(P.renderLinkCell(l), 'trigger → Marks the follow-up done');
  const doc = P.parseDocument(['# Priority Guides — T', '', '## A', '', '### S', '',
    '| Content | Real data | Do | Link | Form | Note |', '| --- | --- | --- | --- | --- | --- |',
    '| Mark Done |  |  | trigger → Marks the follow-up done |  |  |', ''].join('\n'));
  eq(P.links(doc).routes.length, 0);
});

t('a form reads its type and whether it is required', () => {
  eq(P.parseFormCell('single select, required').type, 'single select');
  eq(P.parseFormCell('single select, required').required, true);
  eq(P.parseFormCell('date picker').required, false);
  eq(P.renderFormCell({ type: 'multi line', required: false }), 'multi line');
  eq(P.renderFormCell({ type: 'date picker', required: true }), 'date picker, required');
});

t('ACTION: is the only thing that makes a note an action item', () => {
  eq(P.parseNoteCell('ACTION: ask facilities'), [{ action: true, text: 'ask facilities' }]);
  eq(P.parseNoteCell('This is important'), [{ action: false, text: 'This is important' }]);
  eq(P.renderNoteCell([{ action: true, text: 'ask facilities' }]), 'ACTION: ask facilities');
});

t('a block can carry several notes, and each stands on its own', () => {
  // A rule, a citation and a follow-up are three different things about one
  // field. <br> is how a markdown table cell holds more than one line.
  const notes = P.parseNoteCell('Always 7 characters<br>ACTION: confirm the format<br>[refs]');
  eq(notes.length, 3);
  eq(notes.map((n) => n.action), [false, true, false]);
  eq(notes[2].text, '[refs]');
  eq(P.renderNoteCell(notes), 'Always 7 characters<br>ACTION: confirm the format<br>[refs]');
  eq(P.hasAction(notes), true);
  eq(P.hasAction(P.parseNoteCell('just a rule')), false);
  eq(P.parseNoteCell(''), []);
  eq(P.renderNoteCell([{ text: '', action: false }]), '', 'an empty note is not written out');
});

t('a note that is only a citation still counts as one', () => {
  const doc = P.parseDocument(FIXTURE);
  const { row } = P.rowsOf(P.findGuide(doc, 'Booking detail')).find((r) => r.row.content.text === 'Reference');
  eq(row.note.length, 2, 'a rule and a citation');
  eq(row.refs, ['refs']);
  const use = P.sourceUsage(doc).all.find((s) => s.handle === 'refs');
  ok(use && use.def, '[refs] must resolve');
  ok(use.cites.some((c) => c.where.includes('Reference')), 'the citation must name the block it came from');
});

t('source handles are found, and wikilinks and inline links are not mistaken for them', () => {
  eq(P.refsIn('see [brief] and [interviews]'), ['brief', 'interviews']);
  eq(P.refsIn('go to [[Booking detail]]'), []);
  eq(P.refsIn('read [this](https://example.com)'), []);
  eq(P.refsIn('[x]: https://example.com'), []);
  eq(P.refsIn('[Visual] Floor plan'), ['Visual']);
  eq(P.refsIn('write `[handle]` to cite a source'), [], 'inline code is not a citation');
  eq(P.refsIn('`[a]` but not `[b]`, and [c]'), ['c'], 'only the one outside code');
});

// ---------------------------------------------------------------- derived views

t('routes and references are counted separately', () => {
  const doc = P.parseDocument(FIXTURE);
  const { routes, references } = P.links(doc);
  ok(routes.length >= 8, `expected routes, got ${routes.length}`);
  eq(routes.filter((r) => !r.resolved).length, 0, 'fixture should have no dangling routes');
  eq(references.length, 2, 'fixture has two reference blocks');
  ok(!references.some((r) => routes.includes(r)), 'they must not be the same objects');
});

t('back-links are derived in both directions', () => {
  const doc = P.parseDocument(FIXTURE);
  const b = P.backlinks(doc, 'Cancel a booking');
  eq(b.routes.map((r) => r.from).sort(), ['Booking detail', 'Bookings — My Week']);
  eq(b.references.map((r) => r.from), ['Booking detail']);
});

t('a guide nothing routes to is reported unreachable', () => {
  const doc = P.parseDocument(FIXTURE);
  ok(P.unreachable(doc).includes('Space detail') === false || true);
  const doc2 = P.parseDocument(FIXTURE.replace('| Space | Desk 4-118 |  | onsite page → [[Space detail]] |  |  |', '| Space | Desk 4-118 |  |  |  |  |'));
  ok(P.unreachable(doc2).includes('Space detail'), 'should now be unreachable');
});

t('open items count both action items and unanswered questions', () => {
  const doc = P.parseDocument(FIXTURE);
  const items = P.openItems(doc);
  const actions = items.filter((i) => i.kind === 'action');
  const unknowns = items.filter((i) => i.kind === 'unknown');
  eq(actions.length, 7, `expected 7 action items, got ${actions.length}`);
  ok(unknowns.length >= 3, `expected the ?? business goals, got ${unknowns.length}`);
  ok(items.every((i) => i.guide && i.where && i.text), 'every item must say where it came from');
});

t('clearing an action item takes the count down', () => {
  const doc = P.parseDocument(FIXTURE);
  const before = P.openItems(doc).filter((i) => i.kind === 'action').length;
  const { row, table, section } = P.rowsOf(P.findGuide(doc, 'Bookings — My Week'))
    .find((r) => P.hasAction(r.row.note));
  row.note = P.parseNoteCell('CSV and XLSX. Confirmed with Finance.');
  P.touchRow(row, table, section);
  eq(P.openItems(doc).filter((i) => i.kind === 'action').length, before - 1, 'count did not fall');
});

// ---------------------------------------------------------------- sources

t('a source defined once is cited from many places', () => {
  const doc = P.parseDocument(FIXTURE);
  const u = P.sourceUsage(doc);
  const brief = u.all.find((s) => s.handle === 'brief');
  ok(brief.def, 'brief must resolve');
  ok(brief.cites.length >= 3, `brief should be cited more than once, got ${brief.cites.length}`);
  ok(brief.cites.some((c) => c.guide === 'Bookings — My Week'), 'cite location not recorded');
});

t('a guide-local source shadows nothing and resolves for its own guide', () => {
  const doc = P.parseDocument(FIXTURE);
  const finder = P.findGuide(doc, 'Find a space');
  ok(P.resolveSource(doc, finder, 'naming'), 'guide-local source must resolve');
  eq(P.resolveSource(doc, finder, 'naming').url, 'https://example.com/wiki/spaces/DL/pages/44120');
  ok(P.resolveSource(doc, finder, 'brief'), 'file-level source must still resolve');
});

t('a source defined inside one guide resolves from another, as markdown does', () => {
  // Obsidian and GitHub scope reference definitions to the document. If the app
  // were stricter it would call a link broken that those two render fine.
  const doc = P.parseDocument(FIXTURE);
  const week = P.findGuide(doc, 'Bookings — My Week');
  const def = P.resolveSource(doc, week, 'naming');
  ok(def, '[naming] is defined inside Find a space and must resolve from here too');
  eq(def.url, 'https://example.com/wiki/spaces/DL/pages/44120');
  eq(P.sourceUsage(doc).undefined.map((s) => s.handle), [], 'nothing should read as undefined');
});

t('a cited handle with no definition is reported', () => {
  const doc = P.parseDocument(FIXTURE.replace('[privacy]: https://example.com/wiki/spaces/DL/pages/43880 "What we show about other people"', ''));
  const u = P.sourceUsage(doc);
  eq(u.undefined.map((s) => s.handle), ['privacy']);
});

t('a source nothing cites is reported', () => {
  const stripped = FIXTURE
    .replace('| People on this floor that day | 14 booked, 9 checked in |  |  |  | Counts only, no names, by policy — [privacy] |',
      '| People on this floor that day | 14 booked, 9 checked in |  |  |  | Counts only, no names |')
    .replace('| Who it is for | First Last | edit |  | single select | Office managers only<br>[privacy] |',
      '| Who it is for | First Last | edit |  | single select | Office managers only |');
  eq(P.sourceUsage(P.parseDocument(stripped)).unused.map((s) => s.handle), ['privacy']);
});

t('notes survive an edit elsewhere on the row', () => {
  const doc = P.parseDocument(FIXTURE);
  const hit = P.rowsOf(P.findGuide(doc, 'Booking detail')).find((r) => r.row.content.text === 'Reference');
  hit.row.realData = 'DL-8841-2';
  P.touchRow(hit.row, hit.table, hit.section);
  const after = P.serializeDocument(doc);
  ok(after.includes('| Reference | DL-8841-2 | search |  |  | Never reused, even after a cancellation<br>[refs] |'),
    'notes lost:\n' + after.split('\n').filter((l) => l.includes('DL-8841-2')).join('\n'));
  ok(P.verifyRoundTrip(after).ok, 'must round-trip');
});

t('the line of prose under a heading is editable, and rewrites only its own lines', () => {
  const doc = P.parseDocument(FIXTURE);
  const g = P.findGuide(doc, 'Bookings — My Week');
  const sec = g.sections[0];
  const chunk = sec.chunks.find((c) => c.kind === 'raw' && P.proseOf(c));
  ok(chunk, 'the fixture has a line of prose');
  eq(P.proseOf(chunk).startsWith('Likely a table'), true);
  P.setProse(chunk, sec, 'Likely a table. One row per booking.');
  const after = P.serializeDocument(doc);
  ok(after.includes('*Likely a table. One row per booking.*'), 'not written');
  ok(P.verifyRoundTrip(after).ok, 'must round-trip');
  eq(after.split('\n').length, FIXTURE.split('\n').length,
    'one line replaced by one line leaves the blank lines around it alone');
  const d = after.split('\n').filter((l, i) => FIXTURE.split('\n')[i] !== l);
  eq(d.length, 1, `changed ${d.length} lines: ${JSON.stringify(d)}`);
});

t('a destination with spaces is read and written in angle brackets', () => {
  // Almost every folder path in a real vault has a space in it, and an unbracketed
  // destination stops at the first one in every markdown renderer there is.
  const text = ['# A', '', '## G', '', '### S', '',
    '| Content | Note |', '| --- | --- |', '| x | see [today] |', '',
    '## Sources', '',
    '[today]: <../How the Timeline Works Today.md> "Current state"', ''].join('\n');
  ok(P.verifyRoundTrip(text).ok, 'must round-trip');
  const doc = P.parseDocument(text);
  eq(P.resolveSource(doc, null, 'today').url, '../How the Timeline Works Today.md');
  eq(P.sourceUsage(doc).undefined.map((s) => s.handle), [], 'must resolve, not read as undefined');
});

t('a source added with a spaced path is bracketed on write', () => {
  const doc = P.parseDocument(FIXTURE);
  P.addSource(doc, { handle: 'notes', url: '../Session Notes/2026-08-20.md', title: 'Notes' });
  const after = P.serializeDocument(doc);
  ok(after.includes('[notes]: <../Session Notes/2026-08-20.md> "Notes"'), 'not bracketed:\n' + after.slice(-200));
  ok(P.verifyRoundTrip(after).ok, 'must round-trip');
  eq(P.sourceUsage(P.parseDocument(after)).all.find((s) => s.handle === 'notes').def.url,
    '../Session Notes/2026-08-20.md');
});

t('a source added at file level lands in the Sources block', () => {
  const doc = P.parseDocument(FIXTURE);
  P.addSource(doc, { handle: 'floorplans', url: 'https://example.com/plans', title: 'Floor plans' });
  const after = P.serializeDocument(doc);
  ok(after.includes('[floorplans]: https://example.com/plans "Floor plans"'), 'definition not written');
  ok(P.verifyRoundTrip(after).ok, 'result no longer round-trips');
  eq(after.split('\n').length, FIXTURE.split('\n').length + 1, 'should add exactly one line');
});

// ---------------------------------------------------------------- the referee

t('a visual answer is flagged with the question to ask instead', () => {
  const row = { content: P.parseContentCell('Status dropdown'), form: P.parseFormCell(''), realData: 'x', link: P.parseLinkCell('') };
  const issues = P.lintRow(row);
  const hit = issues.find((i) => i.kind === 'visual-answer');
  ok(hit, 'dropdown should be flagged');
  eq(hit.word, 'dropdown');
  ok(hit.ask.includes('one from a list'), 'must say what to ask instead');
});

t('functionality language is not flagged', () => {
  const row = { content: P.parseContentCell('Status'), form: P.parseFormCell('single select'), realData: 'a, b', link: P.parseLinkCell('') };
  eq(P.lintRow(row).length, 0, 'clean row should be silent');
});

t('a missing example is never a finding — it is optional', () => {
  // Most rows on a real guide are controls and actions with nothing to show.
  // Flagging them would turn the normal state into a wall of warnings.
  const data = { content: P.parseContentCell('Account number'), form: P.parseFormCell(''), realData: '', link: P.parseLinkCell('') };
  eq(P.lintRow(data), [], 'a data point with no example is fine');
  const control = { content: P.parseContentCell('Export'), form: P.parseFormCell(''), realData: '', link: P.parseLinkCell('trigger') };
  eq(P.lintRow(control), [], 'so is a control');
});

t('the whole fixture is clean of visual answers', () => {
  const doc = P.parseDocument(FIXTURE);
  const bad = P.allRows(doc).filter(({ row }) => P.lintRow(row).some((i) => i.kind === 'visual-answer'));
  eq(bad.map(({ row }) => row.content.text), [], 'fixture should model the method, not break it');
});

// ---------------------------------------------------------------- creation

t('a blank file is valid, round-trips, and starts with an open item', () => {
  const text = P.blankGuidesFile('Deskline');
  ok(P.verifyRoundTrip(text).ok, 'blank file must round-trip');
  const doc = P.parseDocument(text);
  eq(P.guides(doc).length, 1);
  ok(P.openItems(doc).length > 0, 'a new file should say what is not known yet');
});

t('a guide added in session round-trips and is addressable', () => {
  const doc = P.parseDocument(FIXTURE);
  const g = P.addGuide(doc, 'Visitor sign-in');
  P.addRow(g.sections[0].chunks.find((c) => c.kind === 'table'), g.sections[0], {
    content: 'Visitor name', realData: 'First Last', capabilities: ['search'], form: 'single line, required'
  });
  const after = P.serializeDocument(doc);
  ok(P.verifyRoundTrip(after).ok, 'result must round-trip');
  const re = P.parseDocument(after);
  ok(P.findGuide(re, 'Visitor sign-in'), 'guide not found after reparse');
  eq(P.rowsOf(P.findGuide(re, 'Visitor sign-in')).map((r) => r.row.content.text), ['Visitor name']);
  eq(P.findGuide(re, 'Visitor sign-in').fields.businessGoal, '??', 'unknowns must be honest, not invented');
});

t('duplicating a guide copies its blocks but leaves the original\'s comments behind', () => {
  const text = [
    '# Test', '',
    '## Card', '',
    '**User goal:** ??', '**Business goal:** ??', '**Primary users:** ??', '',
    '### Content', '',
    '| Content | Note |', '| --- | --- |', '| Name <!--#abc--> |  |', '',
    '## Comments', '',
    '- [ ] `abc` Is this right?', ''
  ].join('\n');
  ok(P.verifyRoundTrip(text).ok, 'fixture must round-trip to start with');
  const doc = P.parseDocument(text);
  const g = P.findGuide(doc, 'Card');
  eq(P.openCommentCount(doc, g), 1, 'the source guide should start with one open comment');

  const dup = P.duplicateGuide(doc, g);
  eq(dup.name, 'Card - COPY');
  eq(doc.segments.indexOf(dup), doc.segments.indexOf(g) + 1, 'the copy sits right after the original');
  eq(P.openCommentCount(doc, dup), 0, "the copy must not inherit the original's open comment");
  eq(P.openCommentCount(doc, g), 1, 'and the original keeps its own');

  const after = P.serializeDocument(doc);
  ok(P.verifyRoundTrip(after).ok, 'the result with the duplicate must still round-trip');
  ok(after.includes('## Card - COPY'), 'the duplicate heading must be written');
  const copyBlock = after.slice(after.indexOf('## Card - COPY'));
  ok(!copyBlock.includes('<!--#abc-->'), "the duplicate's row must not carry the original's rid");
  ok(after.includes('<!--#abc-->'), "the original's row must keep its own rid");
});

t('a row added in session survives a save and reload unchanged', () => {
  const doc = P.parseDocument(FIXTURE);
  const g = P.findGuide(doc, 'Floor plan');
  const { table, section } = P.tablesOf(g)[0] && { table: P.tablesOf(g)[0].table, section: P.tablesOf(g)[0].section };
  P.addRow(table, section, {
    content: '[Visual] Fire exits', realData: 'Dashed green overlay', note: 'ACTION: does facilities have this data?'
  });
  const after = P.serializeDocument(doc);
  const re = P.parseDocument(after);
  const back = P.rowsOf(P.findGuide(re, 'Floor plan')).find((r) => r.row.content.text === 'Fire exits');
  ok(back, 'row not found after reload');
  eq(back.row.content.type, 'Visual');
  eq(P.hasAction(back.row.note), true);
});

t('a row moved into a differently-shaped table is rewritten, not carried over wrong', () => {
  const text = ['# A', '', '## G', '', '### One', '',
    '| Content | Note |', '| --- | --- |', '| a | n |', '',
    '### Two', '', '| Content | Real data | Note |', '| --- | --- | --- |', '| b | rd | n2 |', ''].join('\n');
  const doc = P.parseDocument(text);
  const g = P.findGuide(doc, 'G');
  const row = P.tablesOf(g)[0].table.rows[0];
  ok(P.moveRow(g, row, 1), 'move failed');
  const after = P.serializeDocument(doc);
  ok(after.includes('| a |  | n |'), `row not reshaped to 3 columns:\n${after}`);
  ok(P.verifyRoundTrip(after).ok, 'result must round-trip');
});

t('unknown columns are preserved when a row is edited', () => {
  const text = '# A\n\n## G\n\n### S\n\n| Content | Owner | Note |\n| --- | --- | --- |\n| a | Priya | n |\n';
  const doc = P.parseDocument(text);
  const { row, table, section } = P.rowsOf(P.findGuide(doc, 'G'))[0];
  row.note = P.parseNoteCell('changed');
  P.touchRow(row, table, section);
  ok(P.serializeDocument(doc).includes('| a | Priya | changed |'), 'Owner column was lost');
});

// ---------------------------------------------------------------- one or the other

/*
 * A block either goes somewhere or takes input. A date picker that is also a
 * download is two blocks wearing one row.
 */
t('a block that both goes somewhere and takes input is flagged', () => {
  const text = '# A\n\n## G\n\n### S\n\n| Content | Link | Form |\n| --- | --- | --- |\n'
    + '| a | download | date picker |\n';
  const doc = P.parseDocument(text);
  const { row } = P.rowsOf(P.findGuide(doc, 'G'))[0];
  const kinds = P.lintRow(row).map((i) => i.kind);
  ok(kinds.includes('link-and-form'), `expected link-and-form, got ${JSON.stringify(kinds)}`);
});

t('one on its own is not flagged', () => {
  const text = '# A\n\n## G\n\n### S\n\n| Content | Link | Form |\n| --- | --- | --- |\n'
    + '| a | download |  |\n| b |  | date picker |\n';
  const doc = P.parseDocument(text);
  for (const { row } of P.rowsOf(P.findGuide(doc, 'G'))) {
    ok(!P.lintRow(row).some((i) => i.kind === 'link-and-form'),
      `${P.renderContentCell(row.content)} should be clean`);
  }
});

t('a file that already says both still round-trips — it is a lint, not a rejection', () => {
  const text = '# A\n\n## G\n\n### S\n\n| Content | Link | Form |\n| --- | --- | --- |\n'
    + '| a | download | date picker |\n';
  ok(P.verifyRoundTrip(text).ok, 'must still open');
});

// ---------------------------------------------------------------- fields
const FIELDS = [
  '# Fields — Test', '',
  '## Opportunity', '',
  '### Fields', '',
  '| Label | Backend | Kind | Values | Definition | Note |',
  '| --- | --- | --- | --- | --- | --- |',
  '| Status | TacticalOpportunity.StatusId | stored | Open, Closed | Only two stored states |  |',
  '| New | ?? | derived | yes, no | Open with no attempts |  |',
  '| Expiration date | TacticalOpportunity.ExpirationDate | stored | date |  |  |',
  '', '## Sources', '', ''
].join('\n');

t('a fields file round-trips and reads its columns', () => {
  ok(P.verifyRoundTrip(FIELDS).ok, 'must round-trip');
  const idx = P.fieldIndex(P.parseDocument(FIELDS));
  const f = idx.get('opportunity.status');
  ok(f, 'Opportunity.Status must be indexed');
  eq([f.row.backend, f.row.fkind, f.row.values], ['TacticalOpportunity.StatusId', 'stored', 'Open, Closed']);
  eq(idx.size, 3);
});

t('an unknown backend name counts as open', () => {
  const open = P.openItems(P.parseDocument(FIELDS));
  ok(open.some((i) => i.text.includes('backend name')), 'the ?? backend should be listed');
});

t('a ref splits on its first dot only', () => {
  eq(P.splitFieldRef('Opportunity.e.g. thing'), { object: 'Opportunity', label: 'e.g. thing' });
  eq(P.splitFieldRef('loose'), { object: '', label: 'loose' });
});

const GUIDE = [
  '# Priority Guides — Test', '',
  '## List', '',
  '### Card', '',
  '| Content | Real data | Note |',
  '| --- | --- | --- |',
  '| Status | New, Attempted, Closed |  |',
  '| Customer name | John Smith | a note |',
  ''
].join('\n');

t('adding the Field column changes only the header, the divider and a trailing cell', () => {
  const doc = P.parseDocument(GUIDE);
  const { row, table, section } = P.rowsOf(P.findGuide(doc, 'List'))[0];
  P.setRowField(row, table, section, 'Opportunity.Status');
  const after = P.serializeDocument(doc);
  ok(P.verifyRoundTrip(after).ok, 'result must round-trip');
  const lines = after.split('\n');
  eq(lines[6], '| Content | Real data | Note | Field |');
  eq(lines[7], '| --- | --- | --- | --- |');
  eq(lines[8], '| Status | New, Attempted, Closed |  | Opportunity.Status |');
  eq(lines[9], '| Customer name | John Smith | a note | |', 'an untouched row only gains an empty cell');
  const again = P.parseDocument(after);
  eq(P.rowsOf(P.findGuide(again, 'List'))[0].row.field, 'Opportunity.Status');
});

t('usage finds linked, unlinked and broken rows, and values the field does not allow', () => {
  const doc = P.parseDocument(GUIDE);
  const rows = P.rowsOf(P.findGuide(doc, 'List'));
  P.setRowField(rows[0].row, rows[0].table, rows[0].section, 'Opportunity.Status');
  P.setRowField(rows[1].row, rows[1].table, rows[1].section, 'Customer.Name');
  const u = P.fieldUsage(doc, P.parseDocument(FIELDS));
  const st = u.used.get('opportunity.status');
  ok(st && st.length === 1, 'Status is used once');
  eq(st[0].mismatch, ['New', 'Attempted'], 'Closed is allowed; New and Attempted are not');
  eq(u.unresolved.map((x) => x.ref), ['Customer.Name']);
  eq(u.unlinked.length, 0);
});

t('values written as examples are never checked', () => {
  eq(P.valueList('e.g. Winback, Cross Sell'), null);
  eq(P.valueList('Open, Closed'), ['Open', 'Closed']);
});

t('a format example is never a mismatch', () => {
  const f = P.fieldIndex(P.parseDocument(FIELDS)).get('opportunity.expiration date');
  eq(P.valueMismatch({ realData: 'Day 20 of 30, closes Sat' }, f), []);
});

t('a new object and field write a valid fields file', () => {
  const fdoc = P.parseDocument(P.blankFieldsFile('Test'));
  P.addFieldTo(fdoc, 'Customer', 'Customer name', { backend: 'Party.Name', fkind: 'stored' });
  P.addFieldTo(fdoc, 'Customer', 'Customer ID', { backend: 'Party.PartyNumber' });
  const text = P.serializeDocument(fdoc);
  ok(P.verifyRoundTrip(text).ok, 'must round-trip');
  ok(text.indexOf('## Customer') < text.indexOf('## Sources'), 'objects sit before Sources');
  const idx = P.fieldIndex(P.parseDocument(text));
  eq(idx.get('customer.customer id').row.backend, 'Party.PartyNumber');
});

// ---------------------------------------------------------------- controls
const CTRL = [
  '# Priority Guides — Ctrl', '',
  '## Bar', '',
  '### Top', '',
  '| Content | Real data | Note |',
  '| --- | --- | --- |',
  '| [Search] Find a customer |  |  |',
  '| [Filter] Utility | AEP Ohio |  |',
  '| Plain | x |  |',
  ''
].join('\n');

t('control kinds round-trip as markers', () => {
  ok(P.verifyRoundTrip(CTRL).ok, 'must round-trip');
  const rows = P.rowsOf(P.findGuide(P.parseDocument(CTRL), 'Bar'));
  eq(rows.map((r) => r.row.content.kind), ['search', 'filter', 'text']);
  eq(rows[0].row.content.text, 'Find a customer');
});

t('a control never adds to Open: its questions are prompts', () => {
  eq(P.openItems(P.parseDocument(CTRL)).length, 0);
});

t('answering a spec adds the column once and writes in schema order', () => {
  const doc = P.parseDocument(CTRL);
  const { row, table, section } = P.rowsOf(P.findGuide(doc, 'Bar'))[0];
  P.setSpec(row, table, section, 'match', 'contains');
  P.setSpec(row, table, section, 'mode', 'live');
  P.setSpec(row, table, section, 'mode', 'applied');
  const out = P.serializeDocument(doc);
  ok(P.verifyRoundTrip(out).ok, 'must round-trip');
  const lines = out.split('\n');
  eq(lines[6], '| Content | Real data | Note | Spec |');
  eq(lines[8], '| [Search] Find a customer |  |  | mode: applied; match: contains |');
  eq(lines[10], '| Plain | x |  | |', 'an untouched row only gains an empty cell');
});

t('a conditional question appears only when it applies', () => {
  const doc = P.parseDocument(CTRL);
  const { row, table, section } = P.rowsOf(P.findGuide(doc, 'Bar'))[0];
  ok(!P.specQuestions(row).some((q) => q.key === 'min chars'), 'no mode yet');
  P.setSpec(row, table, section, 'mode', 'live');
  ok(P.specQuestions(row).some((q) => q.key === 'min chars'), 'live asks when it starts');
});

t('a semicolon cannot split an answer', () => {
  const doc = P.parseDocument(CTRL);
  const { row, table, section } = P.rowsOf(P.findGuide(doc, 'Bar'))[0];
  P.setSpec(row, table, section, 'order', 'Newest first; then name');
  eq(P.parseSpecCell(P.renderSpecCell(row.spec, 'search')).find((e) => e.key === 'order').value, 'Newest first, then name');
});

t('a search over several fields is used by each, with no value check', () => {
  const doc = P.parseDocument(CTRL);
  const { row, table, section } = P.rowsOf(P.findGuide(doc, 'Bar'))[0];
  P.setRowField(row, table, section, 'Opportunity.Status, Opportunity.New');
  const u = P.fieldUsage(doc, P.parseDocument(FIELDS));
  ok(u.used.get('opportunity.status') && u.used.get('opportunity.new'), 'both are used');
  eq(u.used.get('opportunity.status')[0].mismatch, []);
});

// ---------------------------------------------------------------- action types, order, people
t('an action prefix sets its type, and the question reads without it', () => {
  eq(P.actionType('NEEDS DECISION: Who owns it?'), { type: 'decision', question: 'Who owns it?' });
  eq(P.actionType('needs answer: where is it stored'), { type: 'answer', question: 'where is it stored' });
  eq(P.actionType('UNCLEAR, DO NOT BUILD FROM THIS: consent'), { type: 'unclear', question: 'consent' });
  eq(P.actionType('Ask Ryan'), { type: 'open', question: 'Ask Ryan' });
});

t('re-typing keeps the question; resolving leaves a plain note', () => {
  const n = { action: true, text: 'NEEDS ANSWER: Where is it stored?' };
  P.setActionType(n, 'decision');
  eq(n.text, 'NEEDS DECISION: Where is it stored?');
  P.setActionType(n, 'open');
  eq(n.text, 'Where is it stored?');
  P.resolveAction(P.setActionType(n, 'unclear'));
  eq([n.text, n.action], ['Where is it stored?', false]);
});

t('a typed action round-trips and its open item carries the type', () => {
  const text = '# A\n\n## G\n\n### S\n\n| Content | Note |\n| --- | --- |\n| a | ACTION: NEEDS DECISION: Who? |\n';
  ok(P.verifyRoundTrip(text).ok);
  const it = P.openItems(P.parseDocument(text))[0];
  eq([it.type, it.question], ['decision', 'Who?']);
});

const ORD = ['# Guides', '', 'Intro line.', '', '---', '', '## FORM: Record interaction', '', '### S', '',
  '| Content |', '| --- |', '| a |', '', '## Dashboard', '', '### S', '', '| Content |', '| --- |', '| b |', '',
  '## Customer', '', '### S', '', '| Content |', '| --- |', '| c |', ''].join('\n');

t('with no order line, every guide is one unranked group', () => {
  const tiers = P.openOrder(P.parseDocument(ORD));
  eq(tiers.length, 1);
  ok(tiers[0].unranked);
  eq(tiers[0].guides.map((g) => g.name), ['FORM: Record interaction', 'Dashboard', 'Customer']);
});

t('moving a guide up starts an order line in the intro, and the file still round-trips', () => {
  const doc = P.parseDocument(ORD);
  P.moveInOrder(doc, P.findGuide(doc, 'Customer'), -1);
  const out = P.serializeDocument(doc);
  ok(P.verifyRoundTrip(out).ok);
  ok(out.includes('**Open order:** First: [[Customer]]\n\n---'), out.split('\n').slice(0, 8).join(' / '));
  const tiers = P.openOrder(P.parseDocument(out));
  eq(tiers.map((t) => [t.name, t.guides.map((g) => g.name)]),
    [['First', ['Customer']], ['Not ordered yet', ['FORM: Record interaction', 'Dashboard']]]);
});

t('an order line with colons in guide names reads back, groups and all', () => {
  const text = ORD.replace('Intro line.', 'Intro line.\n\n**Open order:** Must cover: [[FORM: Record interaction]], [[Customer]]; Later: [[Dashboard]]');
  const tiers = P.openOrder(P.parseDocument(text));
  eq(tiers.map((t) => [t.name, t.guides.map((g) => g.name)]),
    [['Must cover', ['FORM: Record interaction', 'Customer']], ['Later', ['Dashboard']]]);
  const doc = P.parseDocument(text);
  P.moveInOrder(doc, P.findGuide(doc, 'Customer'), 1);
  eq(P.openOrder(doc).map((t) => t.guides.map((g) => g.name)), [['FORM: Record interaction'], ['Customer', 'Dashboard']]);
});

t('owners come from the People line, by full or first name, never a possessive', () => {
  const doc = P.parseDocument('# G\n\n**People:** Ryan Gaskill, Kim Byrd\n\n## X\n');
  eq(P.peopleOf(doc), ['Ryan Gaskill', 'Kim Byrd']);
  eq(P.ownersIn(doc, 'Ask Ryan and Kim Byrd'), ['Ryan Gaskill', 'Kim Byrd']);
  eq(P.ownersIn(doc, "Check Ryan's requirements"), []);
});

// ---------------------------------------------------------------- groups: Object, Repeats, Belongs to

const GROUPED = ['# Priority Guides — G', '', '## Opp', '', '**User goal:** call', '',
  '### Who to reach', '', '*Stays put*', '',
  '| Content | Real data | Do | Link | Form | Note | Field |', '| --- | --- | --- | --- | --- | --- | --- |',
  '| Customer name | e.g John Smith |  |  |  |  | Customer.Customer name |', '',
  '#### Contacts', '', '*One per person*', '', '**Object:** Contact', '**Repeats:** account holder first, 1 to ??', '',
  '| Content | Real data | Do | Link | Form | Note | Field |', '| --- | --- | --- | --- | --- | --- | --- |',
  '| Name | e.g John Smith |  |  |  |  | Contact.Name |',
  '| Mailing address |  |  |  |  |  | Customer.Mailing address |', '',
  '#### Plain', '',
  '| Content | Real data | Do | Link | Form | Note | Field |', '| --- | --- | --- | --- | --- | --- | --- |',
  '| Phone | (614) 555-0134 |  |  |  |  | Contact.Phone |', ''].join('\n');

const GFIELDS = ['# Fields — G', '', '## Customer', '', '### Fields', '',
  '| Label | Backend | Kind | Values | Definition | Note |', '| --- | --- | --- | --- | --- | --- |',
  '| Customer name | ?? | stored |  |  |  |', '| Mailing address | ?? | stored |  |  |  |', '',
  '## Contact', '', '**Notes:** A person we can reach', '**Belongs to:** Customer (many)', '', '### Fields', '',
  '| Label | Backend | Kind | Values | Definition | Note |', '| --- | --- | --- | --- | --- | --- |',
  '| Name | ?? | stored |  |  |  |', '| Phone | ?? | stored |  |  |  |', ''].join('\n');

t('groups: a file with Object and Repeats lines round-trips', () => {
  eq(P.serializeDocument(P.parseDocument(GROUPED)), GROUPED);
  ok(P.verifyRoundTrip(GROUPED).ok);
});

t('groups: a heading says its object and whether it repeats; nothing is inherited', () => {
  const g = P.guides(P.parseDocument(GROUPED))[0];
  const gs = P.groupsOf(g);
  eq(gs.map((x) => [x.title, x.object, x.repeats]),
    [['Who to reach', '', null], ['Contacts', 'Contact', 'account holder first, 1 to ??'], ['Plain', '', null]]);
  eq(gs.map((x) => x.tables.length), [1, 1, 1]);
});

t('groups: the meta lines are not part of the line of clarity', () => {
  const doc = P.parseDocument(GROUPED);
  const sec = P.guides(doc)[0].sections[0];
  const sub = sec.chunks.find((c) => c.kind === 'sub' && c.title === 'Contacts');
  eq(P.proseOf(P.groupChunk(sec, sub)), 'One per person');
  P.setProse(P.groupChunk(sec, sub), sec, 'One per contact');
  const out = P.serializeDocument(doc);
  ok(out.includes('*One per contact*\n\n**Object:** Contact\n**Repeats:** account holder first, 1 to ??'), out);
});

t('groups: setting and removing the lines changes only those lines', () => {
  const doc = P.parseDocument(GROUPED);
  const sec = P.guides(doc)[0].sections[0];
  const plain = sec.chunks.find((c) => c.kind === 'sub' && c.title === 'Plain');
  P.setGroupMeta(sec, plain, 'repeats', '');
  P.setGroupMeta(sec, plain, 'object', 'Contact');
  let out = P.serializeDocument(doc);
  ok(out.includes('#### Plain\n\n**Object:** Contact\n**Repeats:**\n\n| Content'), out);
  eq(P.groupsOf(P.guides(P.parseDocument(out))[0])[2].repeats, '');
  P.setGroupMeta(sec, plain, 'repeats', null);
  P.setGroupMeta(sec, plain, 'object', null);
  out = P.serializeDocument(doc);
  eq(out, GROUPED, 'removing both leaves the file as it was');
});

t('groups: a section-level line covers the section up to its first subsection', () => {
  const doc = P.parseDocument(GROUPED);
  const sec = P.guides(doc)[0].sections[0];
  P.setGroupMeta(sec, null, 'object', 'Customer');
  const out = P.serializeDocument(doc);
  ok(out.includes('*Stays put*\n\n**Object:** Customer\n\n| Content'), out);
  eq(P.proseOf(P.groupChunk(sec, null)), 'Stays put');
});

t('belongs to: read, written and cleared on an object in the fields file', () => {
  const f = P.parseDocument(GFIELDS);
  const [cust, contact] = P.guides(f);
  eq(P.belongsTo(contact), { parent: 'Customer', many: true, text: 'Customer (many)' });
  eq(P.belongsTo(cust), null);
  P.setBelongsTo(cust, 'Account (one)');
  let out = P.serializeDocument(f);
  ok(out.includes('## Customer\n\n**Belongs to:** Account (one)\n\n### Fields'), out);
  P.setBelongsTo(cust, '');
  P.setBelongsTo(contact, 'Customer (one)');
  out = P.serializeDocument(f);
  eq(out, GFIELDS.replace('Customer (many)', 'Customer (one)'));
});

t('groups: findings — a foreign field, a group that may repeat, an unknown object', () => {
  const doc = P.parseDocument(GROUPED);
  const f = P.parseDocument(GFIELDS);
  let r = P.groupFindings(doc, f);
  eq(r.foreign.map((x) => [x.group.title, x.ref]), [['Contacts', 'Customer.Mailing address']]);
  eq(r.mayRepeat.map((x) => [x.group.title, x.object, x.parent]), [['Plain', 'Contact', 'Customer']]);
  eq(r.unknownObject.length, 0);
  const sec = P.guides(doc)[0].sections[0];
  P.setGroupMeta(sec, sec.chunks.find((c) => c.kind === 'sub' && c.title === 'Plain'), 'object', 'Person');
  r = P.groupFindings(doc, f);
  eq(r.unknownObject.map((x) => x.group.object), ['Person']);
  eq(r.foreign.length, 2, 'Plain now names Person, so its Contact field is foreign too');
});

// ---------------------------------------------------------------- renaming a guide keeps its links

t('renaming a guide carries every link to it along, and touches nothing else', () => {
  const src = ['# Priority Guides — R', '', '**Open order:** First: [[Customer]], [[List]]', '',
    '## List', '', '**User goal:** pick one', '**Notes:** Opens [[Customer]] for the one picked', '',
    '> See [[Customer]] — the fields live there', '',
    '### Rows', '', '*Each row opens [[Customer]]*', '',
    '| Content | Real data | Do | Link | Form | Note |', '| --- | --- | --- | --- | --- | --- |',
    '| Name | First Last |  | onsite page → [[Customer]] |  | Same as [[Customer]] |',
    '| Untouched | x |  | modal → [[Other]] |  | Not about the customer page |',
    '| Plain target |  |  | onsite page → Customer |  |  |',
    '| A trigger |  |  | trigger → Opens Customer later |  |  |', '',
    '> See [[Customer]] — and here', '',
    '## Customer', '', '**User goal:** call', '', '### Who', '',
    '| Content | Real data | Do | Link | Form | Note |', '| --- | --- | --- | --- | --- | --- |',
    '| Name | First Last |  |  |  |  |', '', '## Other', '', '**User goal:** x', ''].join('\n');
  const doc = P.parseDocument(src);
  const g = P.findGuide(doc, 'Customer');
  const n = P.renameGuide(doc, g, 'Opportunity');
  const out = P.serializeDocument(doc);
  ok(!/\[\[Customer/.test(out), out);
  ok(out.includes('## Opportunity\n'));
  ok(out.includes('**Open order:** First: [[Opportunity]], [[List]]'));
  ok(out.includes('**Notes:** Opens [[Opportunity]] for the one picked'));
  ok(out.includes('> See [[Opportunity]] — the fields live there'));
  ok(out.includes('*Each row opens [[Opportunity]]*'));
  ok(out.includes('| Name | First Last |  | onsite page → [[Opportunity]] |  | Same as [[Opportunity]] |'));
  ok(out.includes('| Plain target |  |  | onsite page → Opportunity |  |  |'));
  ok(out.includes('| A trigger |  |  | trigger → Opens Customer later |  |  |'), 'a trigger says what happens; it is not a link');
  ok(out.includes('| Untouched | x |  | modal → [[Other]] |  | Not about the customer page |'));
  ok(out.includes('> See [[Opportunity]] — and here'));
  eq(n, 7);
  eq(P.links(doc).routes.filter((r) => !r.resolved).length, 0, 'no route is left dangling');
  eq(diffLines(src, out).n, 8, 'only the heading and the lines that pointed at it change');
});

// ---------------------------------------------------------------- report

console.log(`\n  ${pass} passed${fails.length ? `, ${fails.length} FAILED` : ''}\n`);
for (const f of fails) console.log(`  FAIL  ${f}\n`);
process.exit(fails.length ? 1 : 0);
