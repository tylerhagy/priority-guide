/*
 * priority-guide parser — priority guides in markdown, parsed and serialized.
 *
 * WHY THIS EXISTS
 * The markdown file is the source of truth, not this parser. The app must never
 * reformat a byte the user did not edit, because the same file is read and
 * edited in Obsidian and reviewed in a git diff. So the parser does NOT own the
 * file — it owns addressed spans inside it. Every piece keeps the exact source
 * lines it came from plus a `dirty` flag. Clean pieces are emitted verbatim;
 * only a piece someone actually edited is regenerated from its fields.
 *
 * Parsing guarantees that concatenating every piece's `src`, in order, gives
 * back the original file. Round-tripping is therefore true by construction, and
 * `verifyRoundTrip` is the gate the app opens on.
 *
 * CONSEQUENCE THAT MATTERS MOST: one content block is exactly one source line,
 * so reordering rows re-emits each row verbatim. Moving a row up produces a
 * two-line diff, not a rewritten file.
 *
 * No DOM, no I/O. Imported by the browser and by Node (tests, validate).
 */

// The functionality vocabulary. These describe BEHAVIOUR, never a visual
// solution — "single select", never "dropdown". The UI offers only these.
export const LINK_TYPES = ['none', 'download', 'mailto', 'modal', 'offsite page',
  'onsite page', 'trigger', 'upload', 'other'];
export const FORM_TYPES = ['none', 'date picker', 'single line', 'multi line',
  'single select', 'multi select', 'other'];
export const CAPABILITIES = ['search', 'filter', 'sort', 'edit'];

// Header fields on a guide, in the order they are written when a guide is new.
export const GUIDE_FIELDS = ['type', 'userGoal', 'businessGoal', 'primaryUsers', 'notes', 'sources'];

const FIELD_LABELS = {
  type: 'Type',
  userGoal: 'User goal',
  businessGoal: 'Business goal',
  primaryUsers: 'Primary users',
  notes: 'Notes',
  sources: 'Sources'
};

const FIELD_ALIASES = {
  type: ['type'],
  userGoal: ['user goal', 'user goals', 'goal'],
  businessGoal: ['business goal', 'business goals'],
  primaryUsers: ['primary users', 'users', 'primary user'],
  notes: ['notes', 'general notes', 'note'],
  sources: ['sources', 'source', 'docs', 'supporting docs']
};

// Column names are matched by NAME, never position. This is what lets the
// format gain a column later without breaking files written today, and lets
// someone rename "Real data" to "Example" without the app losing the column.
const COLUMN_ALIASES = {
  content: ['content', 'item', 'element', 'data point'],
  realData: ['real data', 'example', 'example content', 'secondary', 'secondary line', 'actual data'],
  capabilities: ['do', 'capabilities', 'search filter sort', 'sfse'],
  link: ['link', 'link type', 'links'],
  form: ['form', 'form type', 'input', 'input type'],
  note: ['note', 'notes', 'context']
};

const CANONICAL_COLUMNS = [
  ['content', 'Content'],
  ['realData', 'Real data'],
  ['capabilities', 'Do'],
  ['link', 'Link'],
  ['form', 'Form'],
  ['note', 'Note']
];

const ACTION_PREFIX = /^ACTION:\s*/i;
// <br> is how a markdown table cell holds more than one line, and Obsidian and
// GitHub both render it. So notes stay in the cell and stay portable.
const NOTE_SPLIT = /\s*<br\s*\/?>\s*/i;
const UNKNOWN = '??';

// ---------------------------------------------------------------- small helpers

function norm(s) { return String(s == null ? '' : s).trim(); }
function lower(s) { return norm(s).toLowerCase(); }

/** Split a markdown table row into cells, honouring escaped pipes. */
export function splitRow(line) {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '\\' && line[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  // A well-formed row starts and ends with a pipe, producing empty edge cells.
  if (out.length && norm(out[0]) === '') out.shift();
  if (out.length && norm(out[out.length - 1]) === '') out.pop();
  return out.map(norm);
}

/** A cell is one line of a table row, so a newline or bare pipe would corrupt it. */
export function cellSafe(v) {
  return String(v == null ? '' : v).replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim();
}

function isTableRow(line) { return /^\s*\|/.test(line); }
function isDivider(line) {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-') && line.includes('|');
}

/**
 * Map a table header row to our column keys. Returns null if this is not a
 * content-block table — a Content column is what makes it one.
 */
function readColumnHeader(line) {
  const cells = splitRow(line);
  const keyAt = [];
  const byKey = {};
  cells.forEach((cell, i) => {
    const c = lower(cell).replace(/[\/,]/g, ' ').replace(/\s+/g, ' ');
    keyAt[i] = null;
    for (const key of Object.keys(COLUMN_ALIASES)) {
      if (byKey[key] !== undefined) continue;
      if (COLUMN_ALIASES[key].includes(c)) { keyAt[i] = key; byKey[key] = i; return; }
    }
  });
  if (byKey.content === undefined) return null;
  return { keyAt, byKey, names: cells };
}

// ---------------------------------------------------------------- cell grammar

/**
 * What a block IS, written as a marker in front of its name.
 *
 * `[Visual] Coverage map` is not an invention — it is how these guides already
 * read. The others follow the same shape, so the file stays legible and the
 * marker is the one place a block's kind is recorded.
 *
 *   Customer name              a data point or a control
 *   [Visual] Coverage map      an image, a map, a photo
 *   [Chart] Revenue            a data visual, kind not decided
 *   [Chart: pie] Revenue       a data visual of a known kind
 *   [Divider]                  a rule, to break a section up
 */
export const CHART_KINDS = ['pie', 'bar', 'line', 'table', 'number', 'map', 'other'];
export const BLOCK_KINDS = ['text', 'visual', 'chart', 'divider'];

export function parseContentCell(v) {
  const raw = norm(v);
  const m = /^\[\s*([a-z ]+?)\s*(?::\s*([a-z ]+?)\s*)?\]\s*(.*)$/i.exec(raw);
  if (m) {
    const tag = lower(m[1]);
    const rest = norm(m[3]);
    if (tag === 'visual') return { kind: 'visual', chart: '', text: rest, type: 'Visual' };
    if (tag === 'divider') return { kind: 'divider', chart: '', text: rest, type: 'Text' };
    if (tag === 'chart' || tag === 'data' || tag === 'data visual') {
      const k = lower(m[2] || '').replace(/\s*(chart|graph)$/, '').trim();
      return { kind: 'chart', chart: CHART_KINDS.includes(k) ? k : '', text: rest, type: 'Visual' };
    }
  }
  return { kind: 'text', chart: '', text: raw, type: 'Text' };
}

export function renderContentCell(c) {
  const text = norm(c && c.text);
  const kind = (c && c.kind) || (c && c.type === 'Visual' ? 'visual' : 'text');
  if (kind === 'visual') return text ? `[Visual] ${text}` : '[Visual]';
  if (kind === 'divider') return '[Divider]';
  if (kind === 'chart') {
    const k = c.chart && CHART_KINDS.includes(c.chart) ? `: ${c.chart}` : '';
    return text ? `[Chart${k}] ${text}` : `[Chart${k}]`;
  }
  return text;
}

/** Change what a block is without touching anything else it carries. */
export function setKind(row, kind, chart) {
  row.content = {
    kind,
    chart: kind === 'chart' ? (chart || row.content.chart || '') : '',
    text: kind === 'divider' ? '' : row.content.text,
    type: kind === 'visual' || kind === 'chart' ? 'Visual' : 'Text'
  };
  return row;
}

/** `search, sort, edit` — plain words, never abbreviated. */
export function parseCapabilities(v) {
  const found = new Set();
  for (const tok of lower(v).split(/[,;/]+|\s+/)) {
    const t = tok.replace(/able$/, '');
    if (CAPABILITIES.includes(t)) found.add(t);
    else if (t === 'editable' || t === 'edit') found.add('edit');
  }
  return CAPABILITIES.filter((c) => found.has(c));
}

export function renderCapabilities(list) {
  return CAPABILITIES.filter((c) => (list || []).includes(c)).join(', ');
}

/**
 * `modal -> [[Log an attempt]]`. The arrow may be written `->`, `→` or `:`.
 * A target wrapped in [[ ]] is a route to another guide in this file; a bare
 * target is a name we do not resolve, which is still worth recording.
 */
export function parseLinkCell(v) {
  const raw = norm(v);
  if (!raw) return { type: '', target: '', wiki: false, raw };
  const m = /^(.*?)\s*(?:->|→|:)\s*(.+)$/.exec(raw);
  let typePart = raw;
  let target = '';
  let wiki = false;
  if (m) { typePart = norm(m[1]); target = norm(m[2]); }
  const w = /^\[\[([^\]]+)\]\]$/.exec(target);
  if (w) { target = norm(w[1]); wiki = true; }
  const t = lower(typePart).replace(/\s+page$/, ' page');
  const type = LINK_TYPES.find((x) => x === t)
    || LINK_TYPES.find((x) => x.split(' ')[0] === t.split(' ')[0] && t)
    || (t ? t : '');
  return { type, target, wiki, raw };
}

export function renderLinkCell(l) {
  if (!l || !l.type) return '';
  if (!l.target) return l.type;
  return `${l.type} → ${l.wiki ? `[[${l.target}]]` : l.target}`;
}

/** `single line, required` or `single line (required)`. */
export function parseFormCell(v) {
  const raw = norm(v);
  if (!raw) return { type: '', required: false, raw };
  const required = /\brequired\*?\b/i.test(raw);
  const cleaned = lower(raw).replace(/\(?\s*required\*?\s*\)?/gi, '').replace(/[,;]\s*$/, '').trim();
  const type = FORM_TYPES.find((x) => x === cleaned) || cleaned;
  return { type, required, raw };
}

export function renderFormCell(f) {
  if (!f || !f.type) return '';
  return f.required ? `${f.type}, required` : f.type;
}

/**
 * The notes on one block. A note beginning `ACTION:` is an Action Item — a
 * follow-up or open question to circle back on, and nothing else. It is never an
 * emphasis flag. The goal is to clear every Action Item to zero, which only
 * works if the marker means one thing.
 */
export function parseNoteCell(v) {
  return norm(v).split(NOTE_SPLIT).map(norm).filter(Boolean).map((t) => {
    const action = ACTION_PREFIX.test(t);
    return { action, text: action ? norm(t.replace(ACTION_PREFIX, '')) : t };
  });
}

export function renderNoteCell(list) {
  return (list || [])
    .filter((n) => n && norm(n.text))
    .map((n) => (n.action ? `ACTION: ${norm(n.text)}` : norm(n.text)))
    .join('<br>');
}

export function hasAction(list) { return (list || []).some((n) => n.action && norm(n.text)); }

/** Every `[handle]` reference in a piece of text, excluding inline links and wikilinks. */
export function refsIn(text) {
  const out = [];
  // Inline code is not a citation. `[handle]` in a note is someone explaining the
  // syntax, and a markdown renderer would not link it either.
  const s = String(text || '').replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
  const re = /\[([^\[\]]+)\]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const before = s[m.index - 1];
    const after = s[m.index + m[0].length];
    if (before === '[' || after === ']') continue;   // a [[wikilink]]
    if (after === '(' || after === ':') continue;    // an inline link or a definition
    const h = norm(m[1]);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

// ---------------------------------------------------------------- parse

/**
 * Parse a guides document into pieces whose `src` arrays concatenate back to the
 * original file exactly. That invariant is what makes round-tripping possible,
 * and it is checked by a test that walks every piece.
 */
export function parseDocument(text) {
  const lines = text.split('\n');
  const doc = { title: '', segments: [], sources: {} };

  const t = lines.findIndex((l) => /^#\s+(?!#)/.test(l));
  if (t !== -1) doc.title = norm(lines[t].replace(/^#\s+/, ''));

  const bounds = [];
  lines.forEach((l, i) => { if (/^##\s+(?!#)/.test(l)) bounds.push(i); });

  const pushRaw = (from, to) => {
    if (to > from) doc.segments.push({ kind: 'raw', src: lines.slice(from, to), dirty: false });
  };

  if (!bounds.length) { pushRaw(0, lines.length); return finish(doc); }
  pushRaw(0, bounds[0]);

  for (let b = 0; b < bounds.length; b++) {
    const start = bounds[b];
    const end = b + 1 < bounds.length ? bounds[b + 1] : lines.length;
    const body = lines.slice(start, end);
    const name = norm(body[0].replace(/^##\s+/, ''));

    // A file-level `## Sources` block holds definitions shared by every guide.
    if (/^sources$/i.test(name)) { doc.segments.push(parseSources(body, 2)); continue; }
    doc.segments.push(parseGuide(body, name));
  }

  return finish(doc);
}

/** A block of markdown reference-link definitions: `[handle]: url "title"`. */
function parseSources(body, level) {
  const seg = {
    kind: 'sources', level,
    headingSrc: [body[0]],
    entries: [],
    src: null,
    dirty: false
  };
  const rest = body.slice(1);
  rest.forEach((line, i) => {
    const m = /^\s*\[([^\]]+)\]:\s*(?:<([^>]*)>|(\S+))(?:\s+["'(](.*)["')])?\s*$/.exec(line);
    if (!m) { seg.entries.push({ kind: 'raw', src: line }); return; }
    const bracketed = m[2] !== undefined;
    seg.entries.push({
      kind: 'def', src: line, handle: norm(m[1]),
      url: bracketed ? m[2] : norm(m[3]),
      bracketed, title: norm(m[4] || ''), dirty: false
    });
  });
  return seg;
}

function parseGuide(body, name) {
  const guide = {
    kind: 'guide',
    name,
    headingSrc: [body[0]],
    headerSrc: [],
    fields: { type: '', userGoal: '', businessGoal: '', primaryUsers: '', notes: '', sources: '' },
    fieldLine: {},
    sections: [],
    dirty: false,
    dirtyHeading: false,
    dirtyHeader: false
  };

  const secStarts = [];
  body.forEach((l, i) => { if (i > 0 && /^###\s+(?!#)/.test(l)) secStarts.push(i); });

  const headerEnd = secStarts.length ? secStarts[0] : body.length;
  guide.headerSrc = body.slice(1, headerEnd);

  guide.headerSrc.forEach((line, i) => {
    const m = /^\s*\*\*([^:*]+):?\*\*:?\s*(.*)$/.exec(line);
    if (!m) return;
    const label = lower(m[1]).replace(/[:*]/g, '').trim();
    for (const key of Object.keys(FIELD_ALIASES)) {
      if (guide.fieldLine[key] !== undefined) continue;
      if (FIELD_ALIASES[key].includes(label)) {
        guide.fields[key] = norm(m[2]);
        guide.fieldLine[key] = i;
        return;
      }
    }
  });

  for (let s = 0; s < secStarts.length; s++) {
    const a = secStarts[s];
    const b = s + 1 < secStarts.length ? secStarts[s + 1] : body.length;
    const chunk = body.slice(a, b);
    const title = norm(chunk[0].replace(/^###\s+/, ''));
    if (/^sources$/i.test(title)) { guide.sections.push(parseSources(chunk, 3)); continue; }
    guide.sections.push(parseSection(chunk, title));
  }
  return guide;
}

function parseSection(body, title) {
  const sec = {
    kind: 'section',
    title,
    headingSrc: [body[0]],
    chunks: [],
    dirty: false,
    dirtyHeading: false
  };
  const rest = body.slice(1);
  let i = 0;
  let raw = [];
  const flush = () => { if (raw.length) { sec.chunks.push({ kind: 'raw', src: raw, dirty: false }); raw = []; } };

  while (i < rest.length) {
    const line = rest[i];

    if (/^####\s+/.test(line)) {
      flush();
      sec.chunks.push({ kind: 'sub', src: [line], title: norm(line.replace(/^####\s+/, '')), dirty: false });
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flush();
      const from = i;
      while (i < rest.length && /^\s*>/.test(rest[i])) i++;
      sec.chunks.push(parseRef(rest.slice(from, i)));
      continue;
    }

    if (isTableRow(line) && i + 1 < rest.length && isDivider(rest[i + 1])) {
      const cols = readColumnHeader(line);
      if (cols) {
        flush();
        const table = {
          kind: 'table',
          headerSrc: [line],
          dividerSrc: [rest[i + 1]],
          cols,
          rows: [],
          dirty: false
        };
        i += 2;
        while (i < rest.length && isTableRow(rest[i]) && !isDivider(rest[i])) {
          table.rows.push(parseBlockRow(rest[i], cols));
          i++;
        }
        sec.chunks.push(table);
        continue;
      }
    }

    raw.push(line);
    i++;
  }
  flush();
  return sec;
}

/** `> See [[Opportunity Detail]] — the customer fields are specified there.` */
function parseRef(src) {
  const text = src.map((l) => l.replace(/^\s*>\s?/, '')).join(' ');
  const m = /\[\[([^\]]+)\]\]/.exec(text);
  return {
    kind: 'ref', src, dirty: false,
    target: m ? norm(m[1]) : '',
    text: norm(text),
    refs: refsIn(text)
  };
}

function parseBlockRow(line, cols) {
  const raw = splitRow(line);
  const row = { kind: 'row', src: line, raw, dirty: false };
  const at = (key) => (cols.byKey[key] === undefined ? '' : (raw[cols.byKey[key]] || ''));
  row.content = parseContentCell(at('content'));
  row.realData = norm(at('realData'));
  row.capabilities = parseCapabilities(at('capabilities'));
  row.link = parseLinkCell(at('link'));
  row.form = parseFormCell(at('form'));
  row.note = parseNoteCell(at('note'));
  row.refs = rowRefs(row);
  return row;
}

/**
 * Which sources a block cites. Read from the rendered text, never from the raw
 * source line: an edit clears the raw line, and a citation must survive that.
 */
function rowRefs(row) {
  return refsIn(`${renderNoteCell(row.note)} ${row.realData}`);
}

/** Collect every source definition in the file, guide-local shadowing file-wide. */
function finish(doc) {
  const wide = {};
  for (const seg of doc.segments) {
    if (seg.kind !== 'sources') continue;
    for (const e of seg.entries) if (e.kind === 'def') wide[e.handle] = e;
  }
  for (const seg of doc.segments) {
    if (seg.kind !== 'guide') continue;
    const local = {};
    for (const s of seg.sections) {
      if (s.kind !== 'sources') continue;
      for (const e of s.entries) if (e.kind === 'def') local[e.handle] = e;
    }
    seg.localSources = local;
  }
  doc.sources = wide;
  return doc;
}

// ---------------------------------------------------------------- serialize

function renderRow(row, cols) {
  const n = Math.max(cols.names.length, row.raw.length);
  const out = [];
  for (let i = 0; i < n; i++) {
    const key = cols.keyAt[i];
    if (key === 'content') out.push(cellSafe(renderContentCell(row.content)));
    else if (key === 'realData') out.push(cellSafe(row.realData));
    else if (key === 'capabilities') out.push(cellSafe(renderCapabilities(row.capabilities)));
    else if (key === 'link') out.push(cellSafe(renderLinkCell(row.link)));
    else if (key === 'form') out.push(cellSafe(renderFormCell(row.form)));
    else if (key === 'note') out.push(cellSafe(renderNoteCell(row.note)));
    else out.push(cellSafe(row.raw[i] || ''));   // a column we do not know: preserved
  }
  return `| ${out.join(' | ')} |`;
}

function emitRow(row, cols) { return row.dirty || row.src == null ? renderRow(row, cols) : row.src; }

function emitTable(table) {
  const out = [];
  out.push(...(table.headerSrc || [renderHeader(table.cols)]));
  out.push(...(table.dividerSrc || [dividerFor(table.cols)]));
  for (const row of table.rows) out.push(emitRow(row, table.cols));
  return out;
}

function renderHeader(cols) { return `| ${cols.names.join(' | ')} |`; }
function dividerFor(cols) { return `| ${cols.names.map(() => '---').join(' | ')} |`; }

function emitRef(ref) {
  if (!ref.dirty) return ref.src;
  return [`> ${ref.text}`];
}

function emitSub(sub) { return sub.dirty ? [`#### ${sub.title}`] : sub.src; }

function emitSection(sec) {
  const out = [];
  out.push(...(sec.dirtyHeading ? [`### ${sec.title}`] : sec.headingSrc));
  for (const c of sec.chunks) {
    if (c.kind === 'raw') out.push(...c.src);
    else if (c.kind === 'sub') out.push(...emitSub(c));
    else if (c.kind === 'ref') out.push(...emitRef(c));
    else if (c.kind === 'table') out.push(...emitTable(c));
  }
  return out;
}

function emitSources(seg) {
  const out = [];
  out.push(...seg.headingSrc);
  for (const e of seg.entries) {
    if (e.kind !== 'def') { out.push(e.src); continue; }
    out.push(e.dirty ? renderDef(e) : e.src);
  }
  return out;
}

function renderDef(e) {
  const title = e.title ? ` "${e.title.replace(/"/g, "'")}"` : '';
  // A destination containing whitespace MUST be bracketed or no renderer will
  // read past the first space.
  const url = e.bracketed || /\s/.test(e.url) ? `<${e.url}>` : e.url;
  return `[${e.handle}]: ${url}${title}`;
}

function emitGuideHeader(guide) {
  if (!guide.dirtyHeader) return guide.headerSrc;
  const out = guide.headerSrc.slice();
  // Rewrite in place, so an untouched field keeps whatever the user typed.
  let lastField = -1;
  for (const key of GUIDE_FIELDS) {
    const idx = guide.fieldLine[key];
    if (idx === undefined) continue;
    out[idx] = `**${FIELD_LABELS[key]}:** ${cellSafe(guide.fields[key])}`.replace(/\s+$/, '');
    lastField = Math.max(lastField, idx);
  }
  // A field that has no line yet is inserted after the last one that does, so
  // the header keeps its written order rather than jumping to the top.
  const missing = GUIDE_FIELDS.filter((k) => guide.fieldLine[k] === undefined && norm(guide.fields[k]));
  if (missing.length) {
    const at = lastField === -1 ? (out.findIndex((l) => norm(l) !== '') === -1 ? out.length : 1) : lastField + 1;
    const add = missing.map((k) => `**${FIELD_LABELS[k]}:** ${cellSafe(guide.fields[k])}`);
    out.splice(at, 0, ...add);
    missing.forEach((k, i) => { guide.fieldLine[k] = at + i; });
  }
  return out;
}

function emitGuide(guide) {
  const out = [];
  out.push(...(guide.dirtyHeading ? [`## ${guide.name}`] : guide.headingSrc));
  out.push(...emitGuideHeader(guide));
  for (const s of guide.sections) {
    out.push(...(s.kind === 'sources' ? emitSources(s) : emitSection(s)));
  }
  return out;
}

export function serializeDocument(doc) {
  const out = [];
  for (const seg of doc.segments) {
    if (seg.kind === 'raw') out.push(...seg.src);
    else if (seg.kind === 'sources') out.push(...emitSources(seg));
    else out.push(...emitGuide(seg));
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- verification

/** Parse then serialize with zero edits and byte-compare. The app's open gate. */
export function verifyRoundTrip(text) {
  let produced;
  try { produced = serializeDocument(parseDocument(text)); }
  catch (e) { return { ok: false, line: 0, expected: '', produced: '', error: e.message }; }
  if (produced === text) return { ok: true };
  const a = text.split('\n');
  const b = produced.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return {
        ok: false, line: i + 1,
        expected: a[i] === undefined ? '(end of file)' : a[i],
        produced: b[i] === undefined ? '(end of file)' : b[i]
      };
    }
  }
  return { ok: false, line: 0, expected: '', produced: '' };
}

// ---------------------------------------------------------------- queries

export function guides(doc) { return doc.segments.filter((s) => s.kind === 'guide'); }

export function findGuide(doc, name) {
  const n = lower(name);
  return guides(doc).find((g) => lower(g.name) === n) || null;
}

/** Every content-block table in a guide, in reading order. */
export function tablesOf(guide) {
  const out = [];
  for (const sec of guide.sections) {
    if (sec.kind !== 'section') continue;
    for (const c of sec.chunks) if (c.kind === 'table') out.push({ table: c, section: sec });
  }
  return out;
}

export function rowsOf(guide) {
  const out = [];
  for (const { table, section } of tablesOf(guide)) {
    for (const row of table.rows) out.push({ row, table, section, guide });
  }
  return out;
}

export function allRows(doc) {
  const out = [];
  for (const g of guides(doc)) out.push(...rowsOf(g));
  return out;
}

export function countRows(doc) { return allRows(doc).length; }

/**
 * Everything still open: Action Items, and any `??` left where an answer belongs.
 * This is the number that is supposed to reach zero, so it counts honestly —
 * a `??` nobody has turned into a question still counts.
 */
export function openItems(doc) {
  const out = [];
  for (const g of guides(doc)) {
    for (const key of GUIDE_FIELDS) {
      if (norm(g.fields[key]) === UNKNOWN) {
        out.push({ kind: 'unknown', guide: g.name, where: FIELD_LABELS[key], text: `${FIELD_LABELS[key]} is not known`, field: key, target: g });
      }
    }
    for (const { row, section } of rowsOf(g)) {
      const label = renderContentCell(row.content) || '(unnamed)';
      for (const n of row.note) {
        if (!n.action) continue;
        out.push({ kind: 'action', guide: g.name, where: `${section.title} · ${label}`, text: n.text, target: row });
      }
      const un = [];
      if (norm(row.realData) === UNKNOWN) un.push('real data');
      if (norm(row.content.text) === UNKNOWN) un.push('content');
      if (un.length) {
        out.push({ kind: 'unknown', guide: g.name, where: `${section.title} · ${label}`, text: `${un.join(' and ')} not known`, target: row });
      }
    }
  }
  return out;
}

/**
 * Routes are UI navigation; references are supporting material. They are
 * different things and are kept apart, because "can the user get there" and
 * "is it specified over there" are different questions.
 */
export function links(doc) {
  const routes = [];
  const references = [];
  const names = new Map(guides(doc).map((g) => [lower(g.name), g.name]));
  for (const g of guides(doc)) {
    for (const { row, section } of rowsOf(g)) {
      if (!row.link.target) continue;
      const to = names.get(lower(row.link.target));
      routes.push({
        from: g.name, to: to || row.link.target, resolved: !!to,
        via: renderContentCell(row.content), type: row.link.type, section: section.title, row
      });
    }
    for (const sec of g.sections) {
      if (sec.kind !== 'section') continue;
      for (const c of sec.chunks) {
        if (c.kind !== 'ref' || !c.target) continue;
        const to = names.get(lower(c.target));
        references.push({ from: g.name, to: to || c.target, resolved: !!to, text: c.text, section: sec.title, chunk: c });
      }
    }
  }
  return { routes, references };
}

/**
 * The inverse Figma cannot give you: who points here. Derived on every read, so
 * it can never be out of date with the file.
 */
export function backlinks(doc, guideName) {
  const { routes, references } = links(doc);
  const n = lower(guideName);
  return {
    routes: routes.filter((r) => lower(r.to) === n && lower(r.from) !== n),
    references: references.filter((r) => lower(r.to) === n && lower(r.from) !== n)
  };
}

export function unreachable(doc) {
  const { routes } = links(doc);
  const targeted = new Set(routes.filter((r) => r.resolved).map((r) => lower(r.to)));
  return guides(doc).filter((g, i) => i > 0 && !targeted.has(lower(g.name))).map((g) => g.name);
}

/**
 * Resolve a handle: the guide's own Sources block first, then the file's, then
 * any other guide's.
 *
 * The last step matters. Markdown reference definitions are document-scoped, so
 * Obsidian and GitHub will happily render a link to a handle defined three
 * guides away. If the app called that "not defined" it would be contradicting
 * the file in the two other places it gets read.
 */
export function resolveSource(doc, guide, handle) {
  const local = guide && guide.localSources ? guide.localSources[handle] : null;
  if (local) return local;
  if (doc.sources[handle]) return doc.sources[handle];
  for (const seg of doc.segments) {
    if (seg.kind !== 'guide' || seg === guide) continue;
    if (seg.localSources && seg.localSources[handle]) return seg.localSources[handle];
  }
  return null;
}

/**
 * Every source the file defines or cites, with how many places cite it. This is
 * what makes attaching a doc scale: the URL is written once, and the app can
 * always answer "what is this brief attached to" and "what did I cite that
 * never got written down".
 */
export function sourceUsage(doc) {
  const used = new Map();
  const note = (handle, guide, where) => {
    if (!used.has(handle)) used.set(handle, { handle, def: resolveSource(doc, guide, handle), cites: [] });
    else if (!used.get(handle).def) used.get(handle).def = resolveSource(doc, guide, handle);
    used.get(handle).cites.push({ guide: guide ? guide.name : '', where });
  };

  for (const g of guides(doc)) {
    for (const h of refsIn(g.fields.sources)) note(h, g, 'guide');
    for (const h of refsIn(g.fields.notes)) note(h, g, 'guide notes');
    for (const sec of g.sections) {
      if (sec.kind !== 'section') continue;
      for (const c of sec.chunks) {
        if (c.kind === 'raw') for (const h of refsIn(c.src.join('\n'))) note(h, g, sec.title);
        else if (c.kind === 'ref') for (const h of c.refs) note(h, g, sec.title);
        else if (c.kind === 'table') {
          for (const row of c.rows) {
            for (const h of row.refs) note(h, g, `${sec.title} · ${renderContentCell(row.content)}`);
          }
        }
      }
    }
  }

  const defined = new Set();
  const collect = (seg, scope) => {
    for (const e of seg.entries) {
      if (e.kind !== 'def') continue;
      defined.add(e.handle);
      if (!used.has(e.handle)) used.set(e.handle, { handle: e.handle, def: e, cites: [] });
      used.get(e.handle).scope = scope;
      used.get(e.handle).def = used.get(e.handle).def || e;
    }
  };
  for (const seg of doc.segments) {
    if (seg.kind === 'sources') collect(seg, 'file');
    else if (seg.kind === 'guide') for (const s of seg.sections) if (s.kind === 'sources') collect(s, seg.name);
  }

  const all = [...used.values()].sort((a, b) => a.handle.localeCompare(b.handle));
  return {
    all,
    undefined: all.filter((s) => !s.def),
    unused: all.filter((s) => s.def && !s.cites.length)
  };
}

/**
 * Primary users, as discrete types rather than a sentence.
 *
 * Written `Sales manager (primary) · Sales agent` — one line in the file, so it
 * stays hand-editable, but the app treats each as its own thing. That is what
 * stops "Sales agent" and "Sales Agent" becoming two user types that are really
 * one, which is the whole reason to pick from a list instead of typing.
 */
export function parseUsers(text) {
  return String(text || '')
    .split(/\s*[·|,;]\s*|\s+\u2022\s+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => {
      const m = /^(.*?)\s*\((primary|secondary)\)\s*$/i.exec(x);
      return m
        ? { name: m[1].trim(), primary: m[2].toLowerCase() === 'primary' }
        : { name: x, primary: false };
    })
    .filter((u) => u.name && u.name !== UNKNOWN);
}

export function renderUsers(list) {
  return (list || [])
    .filter((u) => u && u.name)
    .map((u) => (u.primary ? `${u.name} (primary)` : u.name))
    .join(' · ');
}

/**
 * Rename a user type everywhere at once. A role spelled two ways is two groups
 * in the Users view, and fixing that one guide at a time is how it stays broken.
 */
export function renameUserType(doc, from, to) {
  const a = norm(from).toLowerCase();
  const b = norm(to);
  if (!a || !b) return 0;
  let n = 0;
  for (const g of guides(doc)) {
    const list = parseUsers(g.fields.primaryUsers);
    if (!list.some((u) => u.name.toLowerCase() === a)) continue;
    const next = [];
    for (const u of list) {
      const name = u.name.toLowerCase() === a ? b : u.name;
      if (next.some((x) => x.name.toLowerCase() === name.toLowerCase())) continue;   // merged into an existing type
      next.push({ name, primary: u.primary });
    }
    setField(g, 'primaryUsers', renderUsers(next));
    n++;
  }
  return n;
}

/** Every user type in the file, with the guides that name it. */
export function userTypes(doc) {
  const byKey = new Map();
  for (const g of guides(doc)) {
    for (const u of parseUsers(g.fields.primaryUsers)) {
      const k = u.name.toLowerCase();
      if (!byKey.has(k)) byKey.set(k, { name: u.name, guides: [] });
      const e = byKey.get(k);
      if (!e.guides.some((x) => x.guide === g)) e.guides.push({ guide: g, primary: u.primary });
    }
  }
  return [...byKey.values()].sort((a, b) => b.guides.length - a.guides.length || a.name.localeCompare(b.name));
}

/**
 * A handle nobody has to think about. The user gives a source a title; the file
 * needs a short key to cite it by, so derive one and keep it unique.
 */
export function handleFor(title, doc) {
  const base = String(title || 'source')
    .toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '')
    .trim().split(/[\s_-]+/).filter(Boolean).slice(0, 3).join('-') || 'source';
  const taken = new Set(Object.keys(doc && doc.sources ? doc.sources : {}));
  for (const seg of (doc && doc.segments) || []) {
    if (seg.kind !== 'guide' || !seg.localSources) continue;
    for (const h of Object.keys(seg.localSources)) taken.add(h);
  }
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * A destination a browser can actually open. Local paths cannot be followed from
 * a page served over http, so saying so beats handing over a link that 404s.
 */
export function isWebUrl(url) {
  return /^(https?|mailto|obsidian):/i.test(String(url || '').trim());
}

// ---------------------------------------------------------------- the referee

/**
 * A priority guide records what content and functionality a screen needs. A
 * dropdown is an answer to a question the guide is not asking yet. So the app
 * says so — and flags, never blocks and never rewrites. The designer decides.
 */
const VISUAL_ANSWERS = {
  dropdown: 'Is it one from a list, or many?',
  'drop-down': 'Is it one from a list, or many?',
  'radio button': 'Is it one from a list, or many?',
  radio: 'Is it one from a list, or many?',
  checkbox: 'Is it one from a list, or many — or a yes/no?',
  toggle: 'Is it a yes/no, or one from a list?',
  accordion: 'That is a layout. What content is inside it?',
  carousel: 'That is a layout. What content is inside it?',
  tooltip: 'That is a layout. What does it need to say?',
  sidebar: 'That is a layout. What belongs in it?',
  breadcrumb: 'That is navigation. Where does it go?'
};

export function lintRow(row) {
  const issues = [];
  if (row.content.kind === 'divider') return issues;
  const hay = `${row.content.text} ${row.form.type || ''}`.toLowerCase();
  for (const word of Object.keys(VISUAL_ANSWERS)) {
    if (new RegExp(`\\b${word}s?\\b`).test(hay)) {
      issues.push({ kind: 'visual-answer', word, ask: VISUAL_ANSWERS[word] });
    }
  }
  if (row.form.type && !FORM_TYPES.includes(row.form.type)) {
    issues.push({ kind: 'unknown-form', word: row.form.type });
  }
  if (row.link.type && !LINK_TYPES.includes(row.link.type)) {
    issues.push({ kind: 'unknown-link', word: row.link.type });
  }
  return issues;
}

// ---------------------------------------------------------------- mutation

function markSection(sec) { sec.dirty = true; }

/** A new row is written fresh; every later edit is a splice like any other. */
export function addRow(table, section, fields = {}) {
  const row = {
    kind: 'row', src: null, raw: [], dirty: true,
    content: parseContentCell(fields.content || ''),
    realData: norm(fields.realData || ''),
    capabilities: fields.capabilities || [],
    link: parseLinkCell(fields.link || ''),
    form: parseFormCell(fields.form || ''),
    note: parseNoteCell(fields.note || ''),
    refs: []
  };
  row.refs = rowRefs(row);
  const at = fields.at === undefined ? table.rows.length : fields.at;
  table.rows.splice(at, 0, row);
  table.dirty = true;
  if (section) markSection(section);
  return row;
}

/**
 * The line of prose under a section heading — "likely a table", "filters on a
 * left panel". It is a raw chunk in the file, so editing it rewrites exactly the
 * lines it occupies and leaves the blank lines around it alone.
 */
export function proseOf(chunk) {
  return (chunk.src || []).map((l) => norm(l)).filter(Boolean).join(' ').replace(/^\*+|\*+$/g, '').trim();
}

export function setProse(chunk, section, text) {
  const t = norm(text);
  const src = chunk.src;
  let a = src.findIndex((l) => norm(l) !== '');
  let b = src.length - 1;
  while (b >= 0 && norm(src[b]) === '') b--;
  if (a === -1) { a = src.length; b = src.length - 1; }
  const line = t ? [`*${t}*`] : [];
  src.splice(a, b - a + 1, ...line);
  chunk.dirty = true;
  if (section) section.dirty = true;
  return chunk;
}

/** Any edit to a row re-renders that one line and nothing else. */
export function touchRow(row, table, section) {
  row.dirty = true;
  row.refs = rowRefs(row);
  if (table) table.dirty = true;
  if (section) markSection(section);
  return row;
}

/**
 * Move a content block. Within its table this is a pure permutation — both rows
 * emit their own source line verbatim, so the diff is the two lines that moved
 * and nothing else. Crossing into another table re-renders the row only if that
 * table's columns differ.
 */
export function moveRow(guide, row, dir, allowCross = true) {
  const tables = tablesOf(guide);
  let ti = -1; let ri = -1;
  tables.forEach((t, i) => { const j = t.table.rows.indexOf(row); if (j !== -1) { ti = i; ri = j; } });
  if (ti === -1) return false;

  const here = tables[ti];
  const to = ri + dir;
  if (to >= 0 && to < here.table.rows.length) {
    here.table.rows.splice(ri, 1);
    here.table.rows.splice(to, 0, row);
    here.table.dirty = true;
    markSection(here.section);
    return true;
  }
  if (!allowCross) return false;

  const next = tables[ti + dir];
  if (!next) return false;
  here.table.rows.splice(ri, 1);
  here.table.dirty = true;
  markSection(here.section);
  next.table.rows.splice(dir > 0 ? 0 : next.table.rows.length, 0, row);
  next.table.dirty = true;
  markSection(next.section);
  // Columns are matched by name, so a differing layout means this line has to be
  // rewritten to the destination's shape rather than carried over wrong.
  if (JSON.stringify(next.table.cols.names) !== JSON.stringify(here.table.cols.names)) row.dirty = true;
  return true;
}

/** Move a whole section, carrying its rows. */
export function moveSection(guide, section, dir) {
  const list = guide.sections;
  const i = list.indexOf(section);
  if (i === -1) return false;
  const to = i + dir;
  if (to < 0 || to >= list.length) return false;
  if (list[to].kind === 'sources') return false;   // the Sources block stays last
  list.splice(i, 1);
  list.splice(to, 0, section);
  guide.dirty = true;
  return true;
}

export function setField(guide, key, value) {
  guide.fields[key] = norm(value);
  guide.dirtyHeader = true;
  return guide;
}

export function addSection(guide, title) {
  const sec = {
    kind: 'section', title: norm(title),
    headingSrc: [`### ${norm(title)}`],
    chunks: [
      { kind: 'raw', src: [''], dirty: false },
      {
        kind: 'table',
        headerSrc: [`| ${CANONICAL_COLUMNS.map((c) => c[1]).join(' | ')} |`],
        dividerSrc: [`| ${CANONICAL_COLUMNS.map(() => '---').join(' | ')} |`],
        cols: {
          keyAt: CANONICAL_COLUMNS.map((c) => c[0]),
          byKey: Object.fromEntries(CANONICAL_COLUMNS.map((c, i) => [c[0], i])),
          names: CANONICAL_COLUMNS.map((c) => c[1])
        },
        rows: [], dirty: true
      },
      { kind: 'raw', src: [''], dirty: false }
    ],
    dirty: true, dirtyHeading: false
  };
  // Before the guide's own Sources block, which belongs at the end.
  let at = guide.sections.length;
  for (let i = 0; i < guide.sections.length; i++) {
    if (guide.sections[i].kind === 'sources') { at = i; break; }
  }
  guide.sections.splice(at, 0, sec);
  guide.dirty = true;
  return sec;
}

export function addGuide(doc, name) {
  const guide = {
    kind: 'guide', name: norm(name),
    headingSrc: [`## ${norm(name)}`],
    headerSrc: [
      '',
      '**User goal:** ??',
      '**Business goal:** ??',
      '**Primary users:** ??',
      ''
    ],
    fields: { type: '', userGoal: UNKNOWN, businessGoal: UNKNOWN, primaryUsers: UNKNOWN, notes: '', sources: '' },
    fieldLine: { userGoal: 1, businessGoal: 2, primaryUsers: 3 },
    sections: [],
    localSources: {},
    dirty: true, dirtyHeading: false, dirtyHeader: false
  };
  let last = -1;
  doc.segments.forEach((s, i) => { if (s.kind === 'guide') last = i; });
  doc.segments.splice(last === -1 ? doc.segments.length : last + 1, 0, guide);
  addSection(guide, 'Content');
  return guide;
}

/** Reorder the guides in the file. */
export function moveGuide(doc, guide, dir) {
  const idx = doc.segments.map((s, i) => (s === guide ? i : -1)).find((i) => i !== -1);
  if (idx === undefined) return false;
  const others = doc.segments
    .map((s, i) => (s.kind === 'guide' ? i : -1))
    .filter((i) => i !== -1);
  const at = others.indexOf(idx);
  const to = others[at + dir];
  if (to === undefined) return false;
  const a = doc.segments[idx];
  doc.segments[idx] = doc.segments[to];
  doc.segments[to] = a;
  a.dirty = true;
  doc.segments[idx].dirty = true;
  return true;
}

/** Put a guide at an explicit position among the others. */
export function placeGuide(doc, guide, index) {
  const slots = doc.segments.map((s, i) => (s.kind === 'guide' ? i : -1)).filter((i) => i !== -1);
  const from = doc.segments.indexOf(guide);
  if (from === -1) return false;
  const order = slots.map((i) => doc.segments[i]);
  const at = order.indexOf(guide);
  order.splice(at, 1);
  order.splice(Math.max(0, Math.min(index, order.length)), 0, guide);
  slots.forEach((slot, i) => { doc.segments[slot] = order[i]; order[i].dirty = true; });
  return true;
}

/** Remove a guide. Anything routing to it becomes a dangling route, and says so. */
export function removeGuide(doc, guide) {
  const i = doc.segments.indexOf(guide);
  if (i === -1) return false;
  doc.segments.splice(i, 1);
  return true;
}

/**
 * Write a source down once. Defined at file level by default, because the whole
 * point is that one Confluence page can be cited from twenty rows across five
 * guides without the URL being repeated anywhere.
 */
export function addSource(doc, { handle, url, title, guide }) {
  const h = norm(handle).replace(/[\[\]]/g, '');
  const entry = {
    kind: 'def', src: null, handle: h, url: String(url || '').trim(),
    bracketed: /\s/.test(String(url || '').trim()), title: norm(title || ''), dirty: true
  };
  let seg = guide
    ? guide.sections.find((s) => s.kind === 'sources')
    : doc.segments.find((s) => s.kind === 'sources');

  if (!seg) {
    seg = {
      kind: 'sources', level: guide ? 3 : 2,
      headingSrc: [guide ? '### Sources' : '## Sources', ''],
      entries: [], dirty: true
    };
    if (guide) guide.sections.push(seg);
    else doc.segments.push(seg);
  }
  seg.entries.push(entry);
  seg.dirty = true;
  if (guide) { guide.localSources[h] = entry; guide.dirty = true; }
  else doc.sources[h] = entry;
  return entry;
}

// ---------------------------------------------------------------- new file

export function blankGuidesFile(title) {
  const t = norm(title) || 'Untitled';
  return [
    `# Priority Guides — ${t}`,
    '',
    'A priority guide is what a screen needs, in order, before anything is laid out.',
    'Content first: what data, what functionality, and what is still unknown.',
    '',
    '- `??` means nobody has been asked yet. It is not a blank — a blank means the',
    '  question does not apply here.',
    '- A note beginning `ACTION:` is a follow-up to circle back on. The goal is zero.',
    '- `[[Another guide]]` in the Link column is a route the user can take.',
    '- `[handle]` cites a source defined at the bottom of the file.',
    '',
    '---',
    '',
    `## ${t}`,
    '',
    '**User goal:** ??',
    '**Business goal:** ??',
    '**Primary users:** ??',
    '',
    '### Content',
    '',
    `| ${CANONICAL_COLUMNS.map((c) => c[1]).join(' | ')} |`,
    `| ${CANONICAL_COLUMNS.map(() => '---').join(' | ')} |`,
    '| ?? | ?? |  |  |  | ACTION: nothing has been captured for this screen yet |',
    '',
    '## Sources',
    '',
    ''
  ].join('\n');
}
