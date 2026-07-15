#!/usr/bin/env node
// Build the offline dictionary shards for the reader's long-press lookup.
//
// Parses the Princeton WordNet 3.1 database files and emits:
//   public/dict/en/a.json … z.json, 0.json   lemma -> [[pos, definition], ...]
//   public/dict/en/morph.json                inflected -> [lemma, ...]
//   public/dict/en/LICENSE.txt               WordNet license + provenance
//
// Usage:
//   node scripts/build-dict.mjs <wordnet-dict-dir | wn3.1.dict.tar.gz>
//
// Uses only node builtins (shells out to `tar` if given a tarball).
// Single-word lemmas only (multi-word entries contain "_" and are skipped).
// Senses per (lemma, pos) are capped, preserving WordNet's index order
// (most frequent sense first). Adjective satellites ("s") normalize to "a".

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const SOURCE_URL = 'https://wordnetcode.princeton.edu/wn3.1.dict.tar.gz';
const MAX_SENSES = 4;       // per (lemma, pos)
const FALLBACK_SENSES = 3;  // if total output blows past the budget
const SIZE_BUDGET = 15 * 1024 * 1024; // ~15MB raw across all shards

const POS_FILES = [
  ['noun', 'n'],
  ['verb', 'v'],
  ['adj', 'a'],
  ['adv', 'r'],
];

// ---------- locate the WordNet dict directory ----------

const input = process.argv[2];
if (!input) {
  console.error('usage: node scripts/build-dict.mjs <wordnet-dict-dir | wn3.1.dict.tar.gz>');
  process.exit(1);
}

let dictDir = resolve(input);
if (/\.(tar\.gz|tgz)$/.test(dictDir)) {
  const tmp = mkdtempSync(join(tmpdir(), 'wordnet-'));
  execFileSync('tar', ['-xzf', dictDir, '-C', tmp]);
  dictDir = existsSync(join(tmp, 'dict')) ? join(tmp, 'dict') : tmp;
}
if (!existsSync(join(dictDir, 'index.noun'))) {
  console.error(`no WordNet database found at ${dictDir} (expected index.noun etc.)`);
  process.exit(1);
}

const outDir = resolve(new URL('..', import.meta.url).pathname, 'public/dict/en');
mkdirSync(outDir, { recursive: true });

// ---------- helpers ----------

// WordNet db files carry the license as a header of lines starting with spaces.
function dataLines(file) {
  return readFileSync(join(dictDir, file), 'latin1')
    .split('\n')
    .filter((l) => l.length > 0 && l[0] !== ' ');
}

function shardKey(lemma) {
  const c = lemma[0];
  return c >= 'a' && c <= 'z' ? c : '0';
}

// gloss -> definition only: text before the first `; "` example delimiter
function defOf(gloss) {
  const i = gloss.indexOf('; "');
  return (i >= 0 ? gloss.slice(0, i) : gloss).trim();
}

// ---------- build shards ----------

function build(maxSenses) {
  const shards = new Map(); // shardKey -> { lemma -> [[pos, def], ...] }
  let lemmaPosCount = 0;
  let senseCount = 0;

  for (const [name, pos] of POS_FILES) {
    // data.<pos>: synset_offset ... | gloss
    const defs = new Map();
    for (const line of dataLines(`data.${name}`)) {
      const bar = line.indexOf(' | ');
      if (bar < 0) continue;
      defs.set(line.slice(0, 8), defOf(line.slice(bar + 3)));
    }

    // index.<pos>: lemma pos synset_cnt p_cnt [ptrs...] sense_cnt tagsense_cnt offsets...
    // offsets are the final synset_cnt fields, listed most-frequent-first.
    for (const line of dataLines(`index.${name}`)) {
      const t = line.trimEnd().split(/\s+/);
      const lemma = t[0].toLowerCase();
      if (lemma.includes('_')) continue; // single-word lookup only
      const synsetCnt = parseInt(t[2], 10);
      if (!synsetCnt) continue;
      const offsets = t.slice(t.length - synsetCnt);

      const senses = [];
      for (const off of offsets) {
        if (senses.length >= maxSenses) break;
        const def = defs.get(off);
        if (def) senses.push([pos === 's' ? 'a' : pos, def]);
      }
      if (senses.length === 0) continue;

      const key = shardKey(lemma);
      let shard = shards.get(key);
      // null prototype: lemmas like "constructor" must not hit Object.prototype
      if (!shard) shards.set(key, (shard = Object.create(null)));
      shard[lemma] = (shard[lemma] || []).concat(senses);
      lemmaPosCount += 1;
      senseCount += senses.length;
    }
  }

  return { shards, lemmaPosCount, senseCount };
}

function writeShards(shards) {
  const keys = ['0', ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(97 + i))];
  let total = 0;
  const sizes = [];
  for (const key of keys) {
    const path = join(outDir, `${key}.json`);
    writeFileSync(path, JSON.stringify(shards.get(key) ?? {}));
    const bytes = statSync(path).size;
    total += bytes;
    sizes.push([key, bytes]);
  }
  return { total, sizes };
}

let senseCap = MAX_SENSES;
let { shards, lemmaPosCount, senseCount } = build(senseCap);
let { total, sizes } = writeShards(shards);
if (total > SIZE_BUDGET) {
  console.log(`shards total ${(total / 1e6).toFixed(1)}MB > budget; retrying with ${FALLBACK_SENSES} senses per (lemma, pos)`);
  senseCap = FALLBACK_SENSES;
  ({ shards, lemmaPosCount, senseCount } = build(senseCap));
  ({ total, sizes } = writeShards(shards));
}

// ---------- morphological exceptions ----------

const morph = Object.create(null);
let morphCount = 0;
for (const [name] of POS_FILES) {
  for (const line of readFileSync(join(dictDir, `${name}.exc`), 'latin1').split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t.length < 2) continue;
    const inflected = t[0].toLowerCase();
    if (inflected.includes('_')) continue;
    const lemmas = t.slice(1).map((w) => w.toLowerCase()).filter((w) => !w.includes('_'));
    if (lemmas.length === 0) continue;
    const prev = morph[inflected] || [];
    for (const l of lemmas) if (!prev.includes(l)) prev.push(l);
    if (!morph[inflected]) morphCount += 1;
    morph[inflected] = prev;
  }
}
const morphPath = join(outDir, 'morph.json');
writeFileSync(morphPath, JSON.stringify(morph));
const morphBytes = statSync(morphPath).size;

// ---------- license + provenance ----------

const header = readFileSync(join(dictDir, 'index.noun'), 'latin1')
  .split('\n')
  .filter((l) => l.startsWith(' '))
  .map((l) => l.replace(/^\s*\d+ ?/, '').trimEnd())
  .join('\n')
  .trim();
writeFileSync(
  join(outDir, 'LICENSE.txt'),
  `${header}\n\nDerived from Princeton WordNet 3.1 (${SOURCE_URL}), downloaded ${new Date().toISOString().slice(0, 10)}.\n`
);

// ---------- report ----------

const uniqueLemmas = Array.from(shards.values()).reduce((n, s) => n + Object.keys(s).length, 0);
console.log(`senses per (lemma, pos): capped at ${senseCap}`);
console.log(`shards: ${uniqueLemmas} lemmas, ${lemmaPosCount} (lemma, pos) entries, ${senseCount} senses`);
for (const [key, bytes] of sizes) console.log(`  ${key}.json  ${(bytes / 1024).toFixed(0)} KB`);
console.log(`shards total: ${(total / 1e6).toFixed(2)} MB`);
console.log(`morph.json: ${morphCount} entries, ${(morphBytes / 1024).toFixed(0)} KB`);
console.log(`output: ${outDir}`);
