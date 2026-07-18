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

// gloss -> { def, ex }: definition before the first `; "` delimiter, plus the
// first quoted usage example (the thing that makes a terse gloss readable).
function parseGloss(gloss) {
  const i = gloss.indexOf('; "');
  const def = (i >= 0 ? gloss.slice(0, i) : gloss).trim();
  let ex = '';
  if (i >= 0) {
    const m = /"([^"]{3,120})"/.exec(gloss.slice(i));
    if (m) ex = m[1];
  }
  return { def, ex };
}

// Closed-class words WordNet deliberately omits (articles, pronouns,
// prepositions, conjunctions, modals). Double-tapping "should" mid-sentence
// must answer. Definitions written for this project. Where WordNet also has
// the word (can: n. a container; must: n. grape juice), the function-word
// sense is PREPENDED — it's what a reader tapping prose almost always means.
// pos codes here extend WordNet's: m modal · u pronoun · d determiner ·
// p preposition · c conjunction.
const FUNCTION_WORDS = {
  // modals + auxiliaries
  should: [['m', 'expresses duty, correctness, or likelihood ("you should rest"); softer than “must”']],
  would: [['m', 'expresses a conditional, habitual, or polite outcome ("I would go if I could")']],
  could: [['m', 'past ability or a polite possibility ("she could read at four"; "could you pass it?")']],
  can: [['m', 'is able to, or is allowed to ("carl can climb")']],
  may: [['m', 'is permitted to, or possibly will ("it may rain")']],
  might: [['m', 'a weaker possibility than “may” ("we might survive this floor")']],
  must: [['m', 'is required to; certainly is ("he must be joking")']],
  shall: [['m', 'formal “will”, often an obligation ("the tenant shall pay")']],
  will: [['m', 'marks the future, or a firm intention ("they will come")']],
  ought: [['m', 'expresses duty or expectation, followed by “to” ("you ought to know")']],
  // articles / determiners
  the: [['d', 'points to a specific, already-known thing ("the dungeon", not just any dungeon)']],
  a: [['d', 'introduces one unspecified thing ("a door appeared")']],
  an: [['d', '“a” before a vowel sound ("an ornate staircase")']],
  this: [['d', 'the one here, near in space or thought']],
  that: [['d', 'the one there, further in space or thought; also links clauses ("she said that…")']],
  these: [['d', 'plural of “this”']],
  those: [['d', 'plural of “that”']],
  each: [['d', 'every one, considered separately']],
  every: [['d', 'all of them, considered together']],
  either: [['d', 'one or the other of two']],
  neither: [['d', 'not one and not the other of two']],
  any: [['d', 'one, some, or all — no matter which']],
  some: [['d', 'an unspecified amount or number of']],
  no: [['d', 'not any ("no exits")']],
  such: [['d', 'of that kind or degree ("such a mess")']],
  // pronouns
  i: [['u', 'the speaker, referring to themself']],
  you: [['u', 'the person or people being spoken to']],
  he: [['u', 'a male person or animal already mentioned']],
  she: [['u', 'a female person or animal already mentioned']],
  it: [['u', 'a thing, animal, or situation already mentioned']],
  we: [['u', 'the speaker together with others']],
  they: [['u', 'people or things already mentioned; also one person, gender unstated']],
  me: [['u', '“I” as the object ("tell me")']],
  him: [['u', '“he” as the object']],
  her: [['u', '“she” as the object; also possessive ("her book")']],
  us: [['u', '“we” as the object']],
  them: [['u', '“they” as the object']],
  my: [['u', 'belonging to the speaker']],
  your: [['u', 'belonging to the person spoken to']],
  his: [['u', 'belonging to him']],
  its: [['u', 'belonging to it']],
  our: [['u', 'belonging to us']],
  their: [['u', 'belonging to them']],
  mine: [['u', 'the one belonging to the speaker']],
  yours: [['u', 'the one belonging to you']],
  who: [['u', 'which person ("who goes there?")']],
  whom: [['u', '“who” as the object, formal ("to whom")']],
  whose: [['u', 'belonging to which person']],
  which: [['u', 'what one, out of a known set']],
  what: [['u', 'asks for information; the thing that ("what happened")']],
  someone: [['u', 'an unspecified person']],
  anyone: [['u', 'any person at all']],
  everyone: [['u', 'every person']],
  nothing: [['u', 'not anything']],
  something: [['u', 'an unspecified thing']],
  everything: [['u', 'all things']],
  anything: [['u', 'any thing at all']],
  anybody: [['u', 'any person at all']],
  everybody: [['u', 'every person']],
  anytime: [['r', 'at any time; whenever']],
  cannot: [['m', 'can not — is unable to, or is not allowed to']],
  when: [['r', 'at what time; at the time that ("when it rains")']],
  where: [['r', 'at or to what place; the place that']],
  how: [['r', 'in what way; to what extent ("how big?")']],
  himself: [['u', 'he, as his own object ("he hurt himself")']],
  herself: [['u', 'she, as her own object']],
  itself: [['u', 'it, as its own object']],
  themselves: [['u', 'they, as their own object']],
  myself: [['u', 'I, as my own object']],
  // prepositions
  of: [['p', 'belonging to, made from, or about ("the door of the vault")']],
  to: [['p', 'toward; also marks the infinitive ("to read")']],
  in: [['p', 'inside; within a place, time, or state']],
  on: [['p', 'touching the surface of; about ("a book on dragons")']],
  at: [['p', 'in the position or moment of ("at the gate", "at dawn")']],
  by: [['p', 'near; done through the agency of ("written by")']],
  for: [['p', 'intended to benefit or serve; in exchange of']],
  with: [['p', 'accompanied by; using ("cut with a knife")']],
  from: [['p', 'starting at a source or origin']],
  into: [['p', 'to the inside of; changing to a state ("turned into stone")']],
  onto: [['p', 'to a position on top of']],
  over: [['p', 'above; across; more than']],
  under: [['p', 'below; less than; subject to']],
  about: [['p', 'concerning; approximately']],
  between: [['p', 'in the space or interval separating two']],
  among: [['p', 'in the middle of several']],
  through: [['p', 'in one side and out the other; by means of']],
  during: [['p', 'throughout the time of']],
  before: [['p', 'earlier than; in front of']],
  after: [['p', 'later than; behind, following']],
  against: [['p', 'in opposition to; touching for support']],
  toward: [['p', 'in the direction of']],
  towards: [['p', 'in the direction of']],
  upon: [['p', 'on, in a formal register ("once upon a time")']],
  within: [['p', 'inside the limits of']],
  without: [['p', 'lacking; not having']],
  beneath: [['p', 'directly under']],
  beyond: [['p', 'on the far side of; past the limits of']],
  despite: [['p', 'without being prevented by ("despite the danger")']],
  until: [['p', 'up to the time of']],
  since: [['p', 'from a past time up to now; also “because”']],
  // conjunctions
  and: [['c', 'joins things that go together']],
  but: [['c', 'introduces a contrast ("small but fierce")']],
  or: [['c', 'offers an alternative']],
  nor: [['c', 'and not ("neither seen nor heard")']],
  so: [['c', 'for that reason; also “to such a degree”']],
  yet: [['c', 'but still, despite that']],
  if: [['c', 'on the condition that']],
  because: [['c', 'for the reason that']],
  although: [['c', 'in spite of the fact that']],
  though: [['c', 'although; however (at the end: "he tried, though")']],
  while: [['c', 'during the time that; whereas']],
  whereas: [['c', 'in contrast with the fact that']],
  unless: [['c', 'except on the condition that']],
  whether: [['c', 'introduces alternatives ("whether he stays or goes")']],
  than: [['c', 'introduces the second part of a comparison']],
  as: [['c', 'in the way that; while; because']],
};

// ---------- build shards ----------

function build(maxSenses) {
  const shards = new Map(); // shardKey -> { lemma -> [[pos, def, ex?, syns?], ...] }
  let lemmaPosCount = 0;
  let senseCount = 0;

  for (const [name, pos] of POS_FILES) {
    // data.<pos>: offset lex_filenum ss_type w_cnt word lex_id [word lex_id]... | gloss
    // The synset's own word list is where synonyms come from.
    const defs = new Map();
    for (const line of dataLines(`data.${name}`)) {
      const bar = line.indexOf(' | ');
      if (bar < 0) continue;
      const t = line.slice(0, bar).split(/\s+/);
      const wCnt = parseInt(t[3], 16) || 0;
      const words = [];
      for (let i = 0; i < wCnt; i++) {
        const w = (t[4 + i * 2] || '').toLowerCase().replace(/\(.*\)$/, '');
        if (w && !w.includes('_') && !words.includes(w)) words.push(w);
      }
      defs.set(line.slice(0, 8), { ...parseGloss(line.slice(bar + 3)), words });
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
        const d = defs.get(off);
        if (!d || !d.def) continue;
        const syns = d.words.filter((w) => w !== lemma).slice(0, 4);
        // Trailing fields drop when empty, so common short entries stay small.
        const sense = [pos === 's' ? 'a' : pos, d.def];
        if (d.ex || syns.length) sense.push(d.ex);
        if (syns.length) sense.push(syns);
        senses.push(sense);
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

  // Function words: prepend, so "should" answers as a modal even where
  // WordNet also has a noun ("must": grape juice) hiding under the same key.
  for (const [lemma, senses] of Object.entries(FUNCTION_WORDS)) {
    const key = shardKey(lemma);
    let shard = shards.get(key);
    if (!shard) shards.set(key, (shard = Object.create(null)));
    shard[lemma] = senses.concat(shard[lemma] || []);
    lemmaPosCount += 1;
    senseCount += senses.length;
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
