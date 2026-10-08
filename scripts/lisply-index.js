#!/usr/bin/env node
/*
 * Copyright © 2026 Gornskew Enterprises
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.  Distributed WITHOUT
 * ANY WARRANTY; see <https://www.gnu.org/licenses/agpl-3.0.html>.
 */

/**
 * lisply-index.js -- the reference indexer for a Lisply corpus.
 *
 * Reads a project's lisply-corpus.sexp (or flags), walks the source,
 * cuts every file into structure-aligned snippets and writes ONE
 * corpus file in the format CORPUS.md specifies (version 4), which any
 * console serving lisply_search can load.  Needs nothing but Node.
 *
 *   node lisply-index.js --root /path/to/checkout --out out/gendl.sexp
 *
 * The chunking, budgets and term extraction here match the Readymax
 * console's Emacs Lisp indexer form for form; CORPUS.md is the
 * contract both keep.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const VERSION = 4;
const GENERATOR = 'lisply-index 1';
const MAX_FILE_BYTES = 1024 * 1024;
const HEADER_MIN_LINES = 8;

const DEFAULTS = {
  distribution: 'public',
  'ignore-dirs': ['.git', 'node_modules', 'dist', 'build', 'vendor', 'target', '.cache', 'logs', 'tmp', 'docker'],
  'exclude-paths': ['**/*.min.js', '**/*.min.css', '**/3rdpty/**', '**/static/plugins/**'],
  extensions: ['.lisp', '.lsp', '.cl', '.gdl', '.gendl', '.asd', '.sexp', '.isc',
               '.md', '.markdown', '.org', '.txt', '.rst',
               '.el', '.js', '.ts', '.json', '.yml', '.yaml', '.html', '.css'],
  'max-lines': 24,
  'max-chars': 1200,
};

const LANGUAGE_EXTENSIONS = [
  ['lisp', ['.lisp', '.lsp', '.cl', '.asd', '.el']],
  ['gendl', ['.gendl']],
  ['gdl', ['.gdl', '.gendl', '.lisp', '.lsp', '.cl']],
  ['markdown', ['.md', '.markdown', '.org', '.rst']],
];

// ------------------------------------------------------------------
// A small s-expression reader: enough for lisply-corpus.sexp.
// Lists -> arrays, keywords -> {kw}, strings, numbers, nil -> null,
// t -> true, other symbols -> {sym}.
// ------------------------------------------------------------------

class Kw { constructor(name) { this.name = name; } }
class Sym { constructor(name) { this.name = name; } }

function readSexp(text) {
  let i = 0;
  const n = text.length;
  function skip() {
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (i < n && text[i] === ';') { while (i < n && text[i] !== '\n') i++; continue; }
      break;
    }
  }
  function atom() {
    const start = i;
    while (i < n && !/[\s()\[\]"]/.test(text[i])) i++;
    const tok = text.slice(start, i);
    if (tok === 'nil') return null;
    if (tok === 't') return true;
    if (/^[-+]?\d+(\.\d+)?$/.test(tok)) return Number(tok);
    if (tok[0] === ':') return new Kw(tok.slice(1));
    return new Sym(tok);
  }
  function str() {
    i++; // opening quote
    let out = '';
    while (i < n && text[i] !== '"') {
      if (text[i] === '\\') { i++; out += text[i]; } else out += text[i];
      i++;
    }
    i++; // closing quote
    return out;
  }
  function form() {
    skip();
    if (i >= n) throw new Error('unexpected end of input');
    const c = text[i];
    if (c === '(' || c === '[') {
      const close = c === '(' ? ')' : ']';
      i++;
      const items = [];
      for (;;) {
        skip();
        if (i >= n) throw new Error('unterminated list');
        if (text[i] === close) { i++; break; }
        items.push(form());
      }
      return items;
    }
    if (c === '"') return str();
    if (c === "'") { i++; return form(); }
    return atom();
  }
  return form();
}

function pget(plist, key) {
  if (!Array.isArray(plist)) return undefined;
  for (let k = 0; k + 1 < plist.length; k += 2) {
    if (plist[k] instanceof Kw && plist[k].name === key) return plist[k + 1];
  }
  return undefined;
}

function kwName(v) { return v instanceof Kw ? v.name : (typeof v === 'string' ? v : undefined); }

// ------------------------------------------------------------------
// Emitting: prin1-compatible text (strings escaped for " and \ only,
// UTF-8 kept raw, vectors in brackets, nil for empty/absent).
// ------------------------------------------------------------------

function sxString(s) { return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }
function sxKeyword(name) { return ':' + name; }
function sxList(items) { return items.length ? '(' + items.join(' ') + ')' : 'nil'; }
function sxStrings(list) { return sxList(list.map(sxString)); }

// ------------------------------------------------------------------
// Files
// ------------------------------------------------------------------

function chars(s) { return Array.from(s).length; }
function capText(s, max) { return chars(s) > max ? Array.from(s).slice(0, max).join('') : s; }

function globToRegexp(glob) {
  // Emacs wildcard-to-regexp semantics: * matches anything including /,
  // ? one character; anchored; case-insensitive like string-match-p
  // under case-fold-search.
  let out = '^';
  for (const c of glob.replace(/\\/g, '/')) {
    if (c === '*') out += '.*';
    else if (c === '?') out += '.';
    else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(out + '$', 'is');
}

function excludedP(p, excludes) {
  const norm = p.replace(/\\/g, '/');
  return excludes.some((pat) => (/[*?]/.test(pat) ? globToRegexp(pat).test(norm) : norm.startsWith(pat.replace(/\\/g, '/'))));
}

function fileExt(p) { return path.extname(p).toLowerCase(); }

function guessLanguage(p) {
  const ext = fileExt(p);
  for (const [lang, exts] of LANGUAGE_EXTENSIONS) if (exts.includes(ext)) return lang;
  return null;
}

function listFiles(root, extensions, ignoreDirs, excludes) {
  const out = [];
  if (!fs.existsSync(root)) return out;
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => !e.name.startsWith('.')).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    const full = path.join(root, e.name);
    let st;
    try { st = fs.statSync(full); } catch (err) { continue; }
    if (st.isDirectory()) {
      if (!ignoreDirs.includes(e.name)) out.push(...listFiles(full, extensions, ignoreDirs, excludes));
    } else if (st.isFile() && !e.name.endsWith('~') && !/^#.*#$/.test(e.name)
               && extensions.includes(fileExt(full)) && !excludedP(full, excludes)) {
      // editor backups (name~) and autosaves (#name#) are never corpus
      out.push(full);
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Chunking (CORPUS.md section 1)
// ------------------------------------------------------------------

function chunkBoundaries(lines, language, ext) {
  let test = null;
  if (language === 'lisp' || language === 'gendl' || language === 'gdl') test = (l) => l.startsWith('(');
  else if (ext === '.org') test = (l) => /^\*+ /.test(l);
  else if (ext === '.md' || ext === '.markdown') test = (l) => /^#+ /.test(l);
  const out = [];
  if (test) lines.forEach((l, i) => { if (test(l)) out.push(i); });
  return out;
}

function fixedWindows(lines, start, end, maxLines, maxChars) {
  const out = [];
  let pos = start;
  while (pos < end) {
    const limit = Math.min(end, pos + maxLines);
    let len = 0, kept = 0;
    for (let i = pos; i < limit; i++) {
      const next = len + chars(lines[i]) + 1;
      if (next > maxChars && kept > 0) break;
      len = next; kept++;
    }
    out.push({ start: pos, end: pos + kept - 1, lines: lines.slice(pos, pos + kept) });
    pos += kept;
  }
  return out;
}

function extractSnippets(lines, maxLines, maxChars, boundaries) {
  const total = lines.length;
  if (!boundaries.length || total === 0) return fixedWindows(lines, 0, total, maxLines, maxChars);
  const starts = boundaries[0] === 0 ? boundaries : [0, ...boundaries];
  const segments = starts.map((s, i) => [s, i + 1 < starts.length ? starts[i + 1] : total]);
  const firstIsHeader = boundaries[0] !== 0 && boundaries[0] >= HEADER_MIN_LINES;
  const segChars = (s, e) => { let c = 0; for (let i = s; i < e; i++) c += chars(lines[i]) + 1; return c; };
  const out = [];
  let curStart = null, curEnd = null, curChars = 0, first = true;
  const flush = () => {
    if (curStart !== null) {
      out.push({ start: curStart, end: curEnd - 1, lines: lines.slice(curStart, curEnd) });
      curStart = null; curEnd = null; curChars = 0;
    }
  };
  for (const [s, e] of segments) {
    const n = e - s, c = segChars(s, e);
    if (n > maxLines || c > maxChars) { flush(); out.push(...fixedWindows(lines, s, e, maxLines, maxChars)); }
    else if (curStart !== null && (curEnd - curStart) + n <= maxLines && curChars + c <= maxChars) { curEnd = e; curChars += c; }
    else { flush(); curStart = s; curEnd = e; curChars = c; }
    if (first && firstIsHeader) flush();
    first = false;
  }
  flush();
  return out;
}

function sectionHeading(lines, startLine, ext) {
  if (!['.md', '.markdown', '.org', '.rst'].includes(ext)) return null;
  const re = ext === '.org' ? /^\*+\s+(.+)$/ : /^#+\s+(.+)$/;
  for (let i = startLine; i >= Math.max(0, startLine - 50); i--) {
    const m = re.exec(lines[i] || '');
    if (m) return m[1].trim();
  }
  return null;
}

function extractTerms(text) {
  const seen = new Set();
  const out = [];
  for (const t of text.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (t.length >= 2 && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

function fileSnippets(file, maxLines, maxChars) {
  const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const language = guessLanguage(file);
  const ext = fileExt(file);
  const raw = extractSnippets(lines, maxLines, maxChars, chunkBoundaries(lines, language, ext));
  return raw.map((snip) => {
    const capped = capText(snip.lines.join('\n'), maxChars);
    const cappedLines = capped.split('\n');
    const preview = (cappedLines.find((l) => l.trim().length > 0) || '').trim();
    return {
      start: snip.start, end: snip.end, text: capped, preview,
      section: sectionHeading(lines, snip.start, file), language,
      terms: extractTerms(capped),
    };
  });
}

// ------------------------------------------------------------------
// Main
// ------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quiet' || a === '-q') { args.quiet = true; continue; }
    if (a === '--help' || a === '-h') { args.help = true; continue; }
    if (a.startsWith('--')) { args[a.slice(2)] = argv[++i]; }
  }
  return args;
}

function usage() {
  console.error(`usage: lisply-index --root DIR --out FILE [--config FILE] [--name NAME]
       [--distribution public|internal] [--subdirs a,b] [--repo NAME] [--repo-root DIR]
       [--max-lines N] [--max-chars N] [--quiet]
Reads DIR/lisply-corpus.sexp when present; flags override it.  See CORPUS.md.`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.root || !args.out) { usage(); process.exit(args.help ? 0 : 2); }
  const root = path.resolve(args.root);
  const configFile = args.config || path.join(root, 'lisply-corpus.sexp');
  let decl = [];
  if (fs.existsSync(configFile)) {
    const top = readSexp(fs.readFileSync(configFile, 'utf8'));
    decl = pget(top, 'lisply-corpus') || [];
  }
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : undefined);
  const name = args.name || pget(decl, 'name');
  if (!name) { console.error('lisply-index: no corpus name (--name, or :name in lisply-corpus.sexp)'); process.exit(2); }
  const distribution = args.distribution || kwName(pget(decl, 'distribution')) || DEFAULTS.distribution;
  const subdirs = args.subdirs ? args.subdirs.split(',').filter(Boolean) : (strings(pget(decl, 'subdirs')) || []);
  const ignoreDirs = strings(pget(decl, 'ignore-dirs')) || DEFAULTS['ignore-dirs'];
  const excludes = strings(pget(decl, 'exclude-paths')) || DEFAULTS['exclude-paths'];
  const extensions = strings(pget(decl, 'extensions')) || DEFAULTS.extensions;
  const maxLines = Number(args['max-lines'] || pget(decl, 'max-lines') || DEFAULTS['max-lines']);
  const maxChars = Number(args['max-chars'] || pget(decl, 'max-chars') || DEFAULTS['max-chars']);
  const repo = args.repo || name;
  const repoRoot = path.resolve(args['repo-root'] || root);
  const log = (m) => { if (!args.quiet) console.error('[lisply-index] ' + m); };

  const roots = subdirs.length ? subdirs.map((d) => path.join(root, d)) : [root];
  const files = [];
  for (const r of roots) {
    if (!fs.existsSync(r)) { log(`WARNING: ${subdirs.length ? 'subdirectory' : 'root'} missing: ${r}`); continue; }
    files.push(...listFiles(r, extensions, ignoreDirs, excludes));
  }
  if (!files.length) { console.error(`lisply-index: nothing to index under ${root}`); process.exit(1); }

  let totalBytes = 0, snippetCount = 0;
  const entries = files.map((file) => {
    const st = fs.statSync(file);
    totalBytes += st.size;
    const snippets = st.size < MAX_FILE_BYTES ? fileSnippets(file, maxLines, maxChars) : null;
    if (snippets) snippetCount += snippets.length;
    const language = guessLanguage(file);
    const mtime = st.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z');
    const snippetText = snippets
      ? '[' + snippets.map((s) => sxList([
        ':start-line', String(s.start), ':end-line', String(s.end),
        ':snippet', sxString(s.text), ':preview', sxString(s.preview),
        ':section', s.section === null ? 'nil' : sxString(s.section),
        ':language', s.language ? sxKeyword(s.language) : 'nil',
        ':terms', '[' + s.terms.map(sxString).join(' ') + ']'])).join('\n') + ']'
      : 'nil';
    return sxList([
      ':source', sxKeyword(name), ':path', sxString(file.replace(/\\/g, '/')),
      ':repo', sxString(repo), ':repo-root', sxString(repoRoot.replace(/\\/g, '/')),
      ':language', language ? sxKeyword(language) : 'nil', ':mtime', sxString(mtime),
      ':snippets', snippetText]);
  });

  const config = sxList([
    ':sources', sxList([sxList([
      ':name', sxString(name), ':distribution', sxKeyword(distribution),
      ':entries', sxList([sxList([
        ':root', sxString(root.replace(/\\/g, '/')), ':repo', sxString(repo),
        ':repo-root', sxString(repoRoot.replace(/\\/g, '/')),
        ':subdirs', sxStrings(subdirs)])])])]),
    ':ignore-dirs', sxStrings(ignoreDirs),
    ':exclude-paths', sxStrings(excludes),
    ':extensions', sxList([':default', sxStrings(extensions)]),
    ':preextract-snippets', 't', ':preextract-max-lines', String(maxLines), ':preextract-max-chars', String(maxChars)]);

  const out = sxList([
    ':version', String(VERSION),
    ':generated-at', sxString(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')),
    ':corpus', sxString(name),
    ':distribution', sxKeyword(distribution),
    ':generator', sxString(GENERATOR),
    ':checksum', sxString(`${files.length}-${totalBytes}`),
    ':config', config,
    ':files', '[' + entries.join('\n') + ']']) + '\n';

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, out, 'utf8');
  log(`Corpus written: ${args.out} (${name}, ${distribution}; ${files.length} files, ${snippetCount} snippets)`);
}

if (require.main === module) main();

module.exports = { readSexp, pget, extractSnippets, fixedWindows, chunkBoundaries, extractTerms, capText, globToRegexp, listFiles };
