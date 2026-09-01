#!/usr/bin/env node
/*
 * validate.mjs — the same gate the app opens on, as a command.
 *
 * WHY IT EXISTS
 * If an agent writes a guides file, the only useful question is "can the app
 * edit this?" — and the only honest way to answer it is to run the app's own
 * check. So this imports the same parser.js the browser imports. The two can
 * never drift, because there is only one of them.
 *
 *   node validate.mjs <file.md>          check one file
 *   node validate.mjs <file.md> --json   machine-readable
 */
import fs from 'node:fs';
import * as P from './parser.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('usage: node validate.mjs <file.md> [--json]');
  process.exit(2);
}

let text;
try { text = fs.readFileSync(file, 'utf8'); }
catch (e) { console.error(`cannot read ${file}: ${e.message}`); process.exit(2); }

const trip = P.verifyRoundTrip(text);
const report = { file, editable: trip.ok };

if (!trip.ok) {
  report.error = trip.error || 'does not round-trip';
  report.line = trip.line;
  report.expected = trip.expected;
  report.produced = trip.produced;
  if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(1); }
  console.log(`NOT EDITABLE  ${file}`);
  console.log('');
  if (trip.error) console.log(`  ${trip.error}`);
  else {
    console.log(`  Line ${trip.line} does not survive a round-trip.`);
    console.log(`    in the file:  ${JSON.stringify(trip.expected)}`);
    console.log(`    parsed back:  ${JSON.stringify(trip.produced)}`);
  }
  console.log('');
  console.log('  The app would open this read-only. Fix that line and run again.');
  process.exit(1);
}

const doc = P.parseDocument(text);
const gs = P.guides(doc);
const { routes, references } = P.links(doc);
const open = P.openItems(doc);
const usage = P.sourceUsage(doc);
const dangling = routes.filter((r) => !r.resolved);
const danglingRefs = references.filter((r) => !r.resolved);
const lint = [];
for (const g of gs) {
  for (const { row, section } of P.rowsOf(g)) {
    for (const issue of P.lintRow(row)) {
      if (issue.kind === 'no-real-data') continue;   // a hint in the app, not a defect
      lint.push({ guide: g.name, where: `${section.title} · ${P.renderContentCell(row.content)}`, ...issue });
    }
  }
}

// Two guides with the same name make every route to that name ambiguous, and
// the app would silently pick the first one.
const seen = new Map();
const duplicates = [];
for (const g of gs) {
  const k = g.name.toLowerCase();
  if (seen.has(k)) duplicates.push(g.name); else seen.set(k, g);
}

Object.assign(report, {
  duplicateNames: duplicates,
  title: doc.title,
  guides: gs.map((g) => ({
    name: g.name,
    sections: g.sections.filter((s) => s.kind === 'section').length,
    blocks: P.rowsOf(g).length
  })),
  blocks: P.countRows(doc),
  routes: routes.length,
  references: references.length,
  sources: usage.all.filter((s) => s.def).length,
  openItems: open.length,
  actionItems: open.filter((i) => i.kind === 'action').length,
  unknowns: open.filter((i) => i.kind === 'unknown').length,
  danglingRoutes: dangling.map((r) => ({ from: r.from, to: r.to })),
  danglingReferences: danglingRefs.map((r) => ({ from: r.from, to: r.to })),
  undefinedSources: usage.undefined.map((s) => s.handle),
  unusedSources: usage.unused.map((s) => s.handle),
  unreachable: P.unreachable(doc),
  lint
});

if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

const pad = (s, n) => String(s).padEnd(n);
console.log(`OK  ${file}`);
console.log('');
console.log(`  ${gs.length} guides · ${report.blocks} content blocks · ${report.routes} routes · ${report.sources} sources`);
console.log('');
for (const g of report.guides) {
  console.log(`    ${pad(g.name, 34)} ${g.sections} sections · ${g.blocks} blocks`);
}
console.log('');
console.log(`  ${report.actionItems} action items, ${report.unknowns} unanswered — ${report.openItems} open in total`);

// Findings, not verdicts. Each line says what is true and where.
const say = (label, list, fmt) => {
  if (!list.length) return;
  console.log('');
  console.log(`  ${label}`);
  for (const x of list) console.log(`    ${fmt(x)}`);
};
say('Routes that point at no guide in this file:', report.danglingRoutes, (r) => `${r.from} → ${r.to}`);
say('References that point at no guide in this file:', report.danglingReferences, (r) => `${r.from} → ${r.to}`);
say('Handles cited but never defined:', report.undefinedSources, (h) => `[${h}]`);
say('Sources defined but never cited:', report.unusedSources, (h) => `[${h}]`);
say('Guides nothing routes to:', report.unreachable, (n) => n);
say('Guide names used more than once (routes to them are ambiguous):', report.duplicateNames, (n) => n);
say('Visual answers where functionality belongs:', report.lint,
  (l) => `${l.guide} · ${l.where}  "${l.word}"${l.ask ? ` — ${l.ask}` : ''}`);
console.log('');
