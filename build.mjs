#!/usr/bin/env node
/*
 * build.mjs — fold parser.js into index.html to make one self-contained file.
 *
 * WHY THIS EXISTS
 * The app needs the File System Access API, and file:// *is* a secure context
 * in Chrome — showDirectoryPicker is available there. The one thing that does
 * not work over file:// is importing an ES module: Chromium blocks it as a
 * cross-origin request. So the local server exists to work around exactly one
 * CORS rule, and inlining the module removes the need for it.
 *
 * parser.js stays the source of truth — test.mjs and validate.mjs import it —
 * and this generates the double-clickable build from it. Never edit the output.
 *
 *   node build.mjs            writes priority-guide.html
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.join(HERE, 'index.html'), 'utf8');
const parser = readFileSync(path.join(HERE, 'parser.js'), 'utf8');

// Both export forms in parser.js are declarations, so dropping the keyword
// leaves them in the module's own scope, which is where the app reads them.
const names = [...parser.matchAll(/^export (?:const|function|class)\s+([A-Za-z_$][\w$]*)/gm)]
  .map((m) => m[1]);
const inlined = parser.replace(/^export (?=(const|function|class)\b)/gm, '');
const bad = inlined.match(/^export\b.*/gm);
if (bad) { console.error('unhandled export form:\n  ' + bad.join('\n  ')); process.exit(1); }
if (!names.length) { console.error('found no exports in parser.js'); process.exit(1); }

const start = html.indexOf('\nimport {');
const end = html.indexOf("} from './parser.js';", start);
if (start === -1 || end === -1) { console.error('could not find the parser import'); process.exit(1); }
const importStmt = html.slice(start, end + "} from './parser.js';".length);
const wanted = importStmt
  .slice(importStmt.indexOf('{') + 1, importStmt.lastIndexOf('}'))
  .split(',').map((x) => x.trim()).filter(Boolean);
const missing = wanted.filter((w) => !names.includes(w));
if (missing.length) { console.error('index.html imports what parser.js does not export:\n  '
  + missing.join(', ')); process.exit(1); }

// Both files declare private helpers of their own — FIELD_LABELS is in each —
// so the parser keeps its own scope and hands back only what it exported. A
// module import gives exactly that, and so does this.
let out = html.replace(importStmt,
  `\n// ---- parser.js, inlined by build.mjs. Edit parser.js, never this file. ----\n`
  + `const { ${wanted.join(', ')} } = (function () {\n`
  + inlined
  + `\nreturn { ${names.join(', ')} };\n})();\n`
  + '// ---- end of parser.js ----\n');

// Two guards refuse to run over file://, and both exist because an ES module
// cannot be imported from there — which is the one thing this build fixes. The
// advice they give would now be wrong, so both go.
const preBoot = out.indexOf("if (location.protocol === 'file:') {");
if (preBoot !== -1) {
  const close = out.indexOf('})();', preBoot);
  out = out.slice(0, preBoot) + '/* single-file build: file:// is supported */\n' + out.slice(close);
}
const inBoot = `  if (location.protocol === 'file:') {
    banner('err', '<b>Opened as a file, not over http.</b> Run <code>./serve.sh</code> and open <code>http://localhost:8044</code>.');
    return;
  }
`;
if (!out.includes(inBoot)) { console.error("could not find boot()'s file:// guard"); process.exit(1); }
out = out.replace(inBoot, '  // single-file build: nothing is imported, so file:// is fine\n');

if (out.includes("Run <code>./serve.sh</code>")) {
  console.error('a "run the server" message survived the build'); process.exit(1);
}

const target = path.join(HERE, 'priority-guide.html');
writeFileSync(target, out);
console.log(`priority-guide.html  ${(out.length / 1024).toFixed(0)} KB  (one file, no server)`);
