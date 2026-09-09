#!/usr/bin/env node
/*
 * build.mjs — fold parser.js into index.html to make one self-contained file.
 *
 * WHY THIS EXISTS
 * The app needs the File System Access API, and file:// *is* a secure context
 * in Chrome — showDirectoryPicker is available there. The one thing that does
 * not work over file:// is importing an ES module: Chromium treats it as a
 * cross-origin request and blocks it. index.html imports parser.js, so the app
 * could not boot from a double-click, so it needed an origin, so it needed a
 * server. Inlining the module removes that whole chain.
 *
 * parser.js stays the source of truth — test.mjs and validate.mjs import it —
 * and this generates the double-clickable copy from it. Never edit the output.
 *
 *   node build.mjs            writes <folder-name>.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const die = (m) => { console.error(m); process.exit(1); };

const html = readFileSync(path.join(HERE, 'index.html'), 'utf8');
const parser = readFileSync(path.join(HERE, 'parser.js'), 'utf8');

const names = [...parser.matchAll(/^export (?:const|function|class)\s+([A-Za-z_$][\w$]*)/gm)]
  .map((m) => m[1]);
if (!names.length) die('found no exports in parser.js');
const inlined = parser.replace(/^export (?=(const|function|class)\b)/gm, '');
const leftover = inlined.match(/^export\b.*/gm);
if (leftover) die('unhandled export form:\n  ' + leftover.join('\n  '));

const start = html.indexOf('\nimport {');
const end = html.indexOf("} from './parser.js';", start);
if (start === -1 || end === -1) die('could not find the parser import');
const importStmt = html.slice(start, end + "} from './parser.js';".length);
const wanted = importStmt.slice(importStmt.indexOf('{') + 1, importStmt.lastIndexOf('}'))
  .split(',').map((x) => x.trim()).filter(Boolean);
const missing = wanted.filter((w) => !names.includes(w));
if (missing.length) die('index.html imports what parser.js does not export:\n  ' + missing.join(', '));

// The parser keeps its own scope and hands back only what it exported, which is
// what a module import gives. A flat concatenation would collide: both files
// privately declare helpers of their own.
// A FUNCTION replacer, not a string: String.replace expands $&, $1 and friends
// in a string replacement, and a parser that escapes regexes contains '\\$&' —
// which silently swallowed the whole import statement into the middle of a
// string literal and truncated the file.
const block = '\n// ---- parser.js, inlined by build.mjs. Edit parser.js, never this file. ----\n'
  + `const { ${wanted.join(', ')} } = (function () {\n`
  + inlined
  + `\nreturn { ${names.join(', ')} };\n})();\n`
  + '// ---- end of parser.js ----\n';
let out = html.replace(importStmt, () => block);

/** Cut `if (location.protocol === 'file:') { … }`, however its body is written. */
function dropGuard(src) {
  const at = src.indexOf("if (location.protocol === 'file:') {");
  if (at === -1) return null;
  let i = src.indexOf('{', at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) break;
  }
  if (depth !== 0) die('could not find the end of a file:// guard');
  return src.slice(0, at) + '/* single-file build: nothing is imported, so file:// is fine */'
    + src.slice(i + 1);
}
// Every guard exists because of the module import, which is the one thing this
// build fixes — so the advice they give would now be wrong. There may be one or
// two of them depending on the app.
let dropped = 0;
for (let next; (next = dropGuard(out)) !== null; ) { out = next; dropped++; if (dropped > 4) break; }
if (!dropped) die('found no file:// guard to remove — has index.html changed?');

// Check what a person could actually read, not what the source mentions — a
// comment explaining the port is fine, a banner telling them to start a server
// is not.
if (out.includes("location.protocol === 'file:'")) die('a file:// guard survived the build');
const advice = out.match(/Run <code>[^<]*<\/code>/g);
if (advice) die('a "start the server" message survived the build: ' + [...new Set(advice)].join(', '));

// Parse what was produced rather than trusting the edits. A build that cannot
// be parsed is the one failure mode that looks fine until the page is opened.
const modStart = out.indexOf('<script type="module">');
const modEnd = out.indexOf('</script>', modStart);
if (modStart === -1 || modEnd === -1) die('no module script in the output');
const mod = out.slice(modStart + '<script type="module">'.length, modEnd);
try { new (async function () {}).constructor(mod); }
catch (e) { die('the generated module does not parse: ' + e.message); }

const name = path.basename(HERE) + '.html';
writeFileSync(path.join(HERE, name), out);
console.log(`${name}  ${(out.length / 1024).toFixed(0)} KB  (one file, no server) · ${dropped} guard(s) removed`);
