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
 * lisply-index-embed.js -- regression test for the reference indexer's
 * embeddings companion (CORPUS.md section 7), against a mock embedding
 * server on a loopback port: no model, no GPU, no network.
 *
 *   node regression-tests/lisply-index-embed.js
 *
 * Exits 0 when every check holds.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');
const { readSexp, pget, corpusRows, contentDigest, rowDigests } = require('../scripts/lisply-index');

const INDEXER = path.join(__dirname, '..', 'scripts', 'lisply-index.js');
const DIMS = 8;
let requests = 0;
let sawKey = null;
let sawAgent = null;
let sawInputs = [];

// The mock: each text's vector is a deterministic function of its length,
// so the test can say which row is which.
function vectorFor(text) {
  const v = new Array(DIMS).fill(0);
  // A one-hot vector is larger, normalized, than the others: a corpus
  // gaining one must be rescaled as a whole.
  if (text.includes('SPIKE')) { v[text.length % DIMS] = 1; return v; }
  v[text.length % DIMS] = 3;
  v[(text.length + 1) % DIMS] = -1;
  return v;
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests++;
    sawKey = req.headers.authorization || null;
    sawAgent = req.headers['user-agent'] || null;
    const { input } = JSON.parse(body);
    sawInputs.push(...input);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      model: 'mock-embed',
      data: input.map((t, index) => ({ index, embedding: vectorFor(t) })),
    }));
  });
});

let failures = 0;
function check(what, ok) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
}

// Asynchronous: the mock server answers on this process's event loop.
function run(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [INDEXER, ...args],
             { encoding: 'utf8', env: { ...process.env, LISPLY_EMBED_URL: '', LISPLY_EMBED_KEY_FILE: '' } },
             (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr }));
  });
}

server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/v1/embeddings`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lisply-index-embed-'));
  try {
    const src = path.join(dir, 'src');
    fs.mkdirSync(src);
    fs.writeFileSync(path.join(src, 'a.lisp'), '(defun a () 1)\n\n(defun bb () 22)\n');
    fs.writeFileSync(path.join(src, 'notes.md'), '# One\ntext\n');
    const keyFile = path.join(dir, 'key');
    fs.writeFileSync(keyFile, 'sekrit\n');
    const out = path.join(dir, 'corpora', 'fixture.sexp');

    // 1. Build and embed in one run.
    let r = await run(['--root', src, '--name', 'fixture', '--out', out, '--quiet', '--embed',
                 '--embed-url', url, '--embed-key-file', keyFile, '--embed-instruction', 'Find code',
                 '--embed-batch', '2']);
    check('build with --embed exits 0', r.status === 0);
    const header = readSexp(fs.readFileSync(path.join(dir, 'corpora', 'embeddings', 'fixture.emb.sexp'), 'utf8'));
    const corpus = readSexp(fs.readFileSync(out, 'utf8'));
    const rows = pget(header, 'rows');
    const blob = fs.readFileSync(path.join(dir, 'corpora', 'embeddings', 'fixture.i8'));
    check('header names the corpus and its checksum',
          pget(header, 'corpus') === 'fixture' && pget(header, 'corpus-checksum') === pget(corpus, 'checksum')
          && pget(header, 'corpus-generated-at') === pget(corpus, 'generated-at'));
    check('dtype int8, dims and model from the server',
          pget(header, 'dtype').name === 'int8' && pget(header, 'dims') === DIMS && pget(header, 'model') === 'mock-embed');
    check('query prefix from --embed-instruction', pget(header, 'query-prefix') === 'Instruct: Find code\nQuery: ');
    check('one row per snippet, and the blob is rows x dims bytes',
          rows === sawInputs.length && blob.length === rows * DIMS && rows >= 2);
    check('batched (--embed-batch 2)', requests === Math.ceil(rows / 2));
    check('bearer key from the key file, trimmed', sawKey === 'Bearer sekrit');
    check('User-Agent names the indexer', sawAgent === 'lisply-index');
    check('documents are relpath, newline, snippet', sawInputs[0].startsWith('a.lisp\n(defun a'));
    // Row i is the i-th text: its largest component sits where the mock put it.
    const ints = new Int8Array(blob.buffer, blob.byteOffset, blob.length);
    let aligned = true;
    sawInputs.forEach((t, i) => {
      const row = Array.from(ints.slice(i * DIMS, (i + 1) * DIMS));
      if (row.indexOf(Math.max(...row)) !== t.length % DIMS || Math.max(...row) !== 127) aligned = false;
    });
    check('rows in corpus order, normalized and scaled so the largest is 127', aligned);

    // 2. A current companion is not rebuilt.
    const before = requests;
    r = await run(['--embed-corpus', out, '--embed-url', url, '--embed-instruction', 'Find code', '--quiet']);
    check('--embed-corpus on a current companion asks nothing', r.status === 0 && requests === before);
    r = await run(['--embed-corpus', out, '--embed-url', url, '--embed-instruction', 'Find code', '--quiet', '--force']);
    check('--force rebuilds it', r.status === 0 && requests > before);

    // 2b. Identity by content, and incremental rebuilds (CORPUS.md section 7).
    const emb = (ext) => path.join(dir, 'corpora', 'embeddings', `fixture.${ext}`);
    const readHeader = () => readSexp(fs.readFileSync(emb('emb.sexp'), 'utf8'));
    let texts = corpusRows(readSexp(fs.readFileSync(out, 'utf8')));
    check('the header carries the digest of the embedded text, and one 8-byte digest per row',
          pget(readHeader(), 'content-sha256') === contentDigest(texts)
          && fs.statSync(emb('rows')).size === texts.length * 8);
    await new Promise((res) => setTimeout(res, 1100));   // a new :generated-at
    r = await run(['--root', src, '--name', 'fixture', '--out', out, '--quiet']);
    let asked = requests;
    r = await run(['--embed-corpus', out, '--embed-url', url, '--embed-instruction', 'Find code', '--quiet']);
    check('a corpus rebuilt with the same text asks nothing and is re-stamped',
          r.status === 0 && requests === asked
          && pget(readHeader(), 'corpus-generated-at') === pget(readSexp(fs.readFileSync(out, 'utf8')), 'generated-at'));
    fs.appendFileSync(path.join(src, 'notes.md'), '# Two\nmore text here\n');
    r = await run(['--root', src, '--name', 'fixture', '--out', out, '--quiet']);
    const newTexts = corpusRows(readSexp(fs.readFileSync(out, 'utf8')));
    const known = new Set(texts);
    const expected = newTexts.filter((t) => !known.has(t));
    const inputsBefore = sawInputs.length;
    r = await run(['--embed-corpus', out, '--embed-url', url, '--embed-instruction', 'Find code', '--quiet']);
    const sentNow = sawInputs.slice(inputsBefore);
    check('a changed corpus embeds only its new rows',
          r.status === 0 && expected.length > 0 && expected.length < newTexts.length
          && sentNow.length === expected.length && sentNow.every((t) => expected.includes(t)));
    const blob2 = fs.readFileSync(emb('i8'));
    const ints2 = new Int8Array(blob2.buffer, blob2.byteOffset, blob2.length);
    check('kept and new rows both sit at their rows, at full scale',
          blob2.length === newTexts.length * DIMS
          && newTexts.every((t, i) => {
            const row = Array.from(ints2.slice(i * DIMS, (i + 1) * DIMS));
            return row.indexOf(Math.max(...row)) === t.length % DIMS && Math.max(...row) === 127;
          }));
    check('its digests follow the new text', pget(readHeader(), 'content-sha256') === contentDigest(newTexts)
          && fs.readFileSync(emb('rows')).equals(rowDigests(newTexts)));
    // A companion from before digests, still current by checksum and
    // generated-at, gains them with no server at all.
    const oldStyle = fs.readFileSync(emb('emb.sexp'), 'utf8')
      .replace(/ :content-sha256 "[0-9a-f]+"/, '').replace(/ :row-digests :sha256-8/, '');
    fs.writeFileSync(emb('emb.sexp'), oldStyle);
    fs.rmSync(emb('rows'));
    asked = requests;
    r = await run(['--embed-corpus', out, '--embed-instruction', 'Find code', '--quiet']);
    check('an old companion gains its digests without embedding, and without a server',
          r.status === 0 && requests === asked && pget(readHeader(), 'content-sha256') === contentDigest(newTexts)
          && fs.existsSync(emb('rows')));
    texts = newTexts;
    fs.appendFileSync(path.join(src, 'notes.md'), '# SPIKE\nlarge\n');
    r = await run(['--root', src, '--name', 'fixture', '--out', out, '--quiet']);
    r = await run(['--embed-corpus', out, '--embed-url', url, '--embed-instruction', 'Find code', '--quiet']);
    const spiked = corpusRows(readSexp(fs.readFileSync(out, 'utf8')));
    const blob3 = fs.readFileSync(emb('i8'));
    const ints3 = new Int8Array(blob3.buffer, blob3.byteOffset, blob3.length);
    const peak = (i) => Math.max(...Array.from(ints3.slice(i * DIMS, (i + 1) * DIMS)));
    check('a row too large for the old scale rescales the corpus: it peaks at 127, kept rows below',
          r.status === 0 && spiked.every((t, i) => {
            const row = Array.from(ints3.slice(i * DIMS, (i + 1) * DIMS));
            return row.indexOf(peak(i)) === t.length % DIMS && (t.includes('SPIKE') ? peak(i) === 127 : peak(i) === 120);
          }));

    // 3. An :internal corpus is refused, and nothing is sent.
    const internal = path.join(dir, 'internal', 'shop.sexp');
    r = await run(['--root', src, '--name', 'shop', '--distribution', 'internal', '--out', internal, '--quiet']);
    const sent = requests;
    r = await run(['--embed-corpus', internal, '--embed-url', url, '--quiet']);
    check('an :internal corpus is refused with exit 3', r.status === 3 && /:internal/.test(r.stderr));
    check('nothing of it reached the server', requests === sent
          && !fs.existsSync(path.join(dir, 'internal', 'embeddings')));

    // 4. No server: a clear error, not a crash.
    r = await run(['--embed-corpus', out, '--quiet', '--force']);
    check('no server configured is an error', r.status === 1 && /no embedding server/.test(r.stderr));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    server.close();
  }
  console.log(failures ? `${failures} FAILED` : 'all passed');
  process.exitCode = failures ? 1 : 0;
});
