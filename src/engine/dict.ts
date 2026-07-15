// Offline English dictionary lookup (long-press a word → definition).
//
// Data: sharded WordNet 3.1 JSON under public/dict/en/ (built by
// scripts/build-dict.mjs) served from our own origin — no third-party
// network calls. Shards are one file per first letter (a.json … z.json,
// 0.json for everything else); morph.json holds WordNet's irregular-form
// exceptions ("went" → "go").
//
// Framework-free: no React, no DOM beyond fetch. Never throws to the
// caller — any fetch/parse failure resolves to null.

/** n/v/a/r from WordNet; m modal · u pronoun · d determiner · p preposition ·
 *  c conjunction from the curated function-word set (build-dict.mjs). */
export type DictPos = 'n' | 'v' | 'a' | 'r' | 'm' | 'u' | 'd' | 'p' | 'c';

export interface DictSense {
  pos: DictPos;
  def: string;
  /** A usage example from the WordNet gloss, when it has one. */
  ex?: string;
  /** Other words in the same synset — synonyms for this sense. */
  syn?: string[];
}

export interface DictResult {
  /** The lemma the senses belong to (may differ from the input, e.g. "went" → "go"). */
  word: string;
  senses: DictSense[];
}

/** Shard format: lemma → [[pos, def, example?, synonyms?], ...], most common
 *  sense first; trailing fields are omitted when empty. */
type Shard = Record<string, [string, string, string?, string[]?][]>;
type Morph = Record<string, string[]>;

// ---------------------------------------------------------------------------
// shard loading — lazy fetch, small LRU-ish cache (evict oldest-loaded)

const SHARD_CACHE_MAX = 4;
const shardCache = new Map<string, Promise<Shard | null>>();
let morphPromise: Promise<Morph | null> | null = null;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function dictUrl(file: string): string {
  return `${import.meta.env.BASE_URL}dict/en/${file}`;
}

function shardKey(word: string): string {
  const c = word[0];
  return c >= 'a' && c <= 'z' ? c : '0';
}

function getShard(key: string): Promise<Shard | null> {
  const cached = shardCache.get(key);
  if (cached) return cached;
  const loading = fetchJson<Shard>(dictUrl(`${key}.json`)).then((shard) => {
    // Don't cache failures — a later lookup may retry (e.g. back online).
    if (shard === null && shardCache.get(key) === loading) shardCache.delete(key);
    return shard;
  });
  shardCache.set(key, loading);
  while (shardCache.size > SHARD_CACHE_MAX) {
    const oldest = shardCache.keys().next().value;
    if (oldest === undefined) break;
    shardCache.delete(oldest);
  }
  return loading;
}

function getMorph(): Promise<Morph | null> {
  if (!morphPromise) {
    const loading = fetchJson<Morph>(dictUrl('morph.json')).then((morph) => {
      if (morph === null && morphPromise === loading) morphPromise = null; // retry later
      return morph;
    });
    morphPromise = loading;
  }
  return morphPromise;
}

// ---------------------------------------------------------------------------
// normalization + lemmatization

function normalize(raw: string): string {
  let w = raw.trim().toLowerCase();
  // strip surrounding punctuation/quotes; keep inner apostrophes and hyphens
  w = w.replace(/^[^\p{L}\p{N}]+/u, '').replace(/[^\p{L}\p{N}]+$/u, '');
  // strip possessive
  w = w.replace(/['’]s$/u, '');
  return w;
}

/**
 * WordNet's regular "detachment" rules, in spec order (nouns, verbs,
 * adjectives). Returns candidate lemmas to try after exact + exception
 * lookups fail. Irregulars ("went", "better") come from morph.json instead.
 */
function detachmentCandidates(w: string): string[] {
  const out: string[] = [];
  const add = (c: string) => {
    if (c.length >= 2 && c !== w && !out.includes(c)) out.push(c);
  };
  // strip a doubled final consonant: "stopp" → "stop"
  const undouble = (s: string): string | null =>
    s.length >= 3 && s[s.length - 1] === s[s.length - 2] ? s.slice(0, -1) : null;
  // WordNet's rule order tries the "e" restoration before the plain strip,
  // so "hoped" → "hope" wins over "hoped" → "hop". Plain strip before
  // undoubling, so "adding" → "add" wins over "adding" → "ad".
  const stripEdIng = (suffix: string) => {
    if (!w.endsWith(suffix)) return;
    const base = w.slice(0, -suffix.length);
    add(base + 'e'); // "loved" → "love", "hoping" → "hope"
    add(base); // "walked" → "walk"
    const un = undouble(base);
    if (un) add(un); // "stopped" → "stop", "running" → "run"
  };

  // nouns
  if (w.endsWith('s')) add(w.slice(0, -1));
  if (w.endsWith('ses')) add(w.slice(0, -2));
  if (w.endsWith('xes')) add(w.slice(0, -2));
  if (w.endsWith('zes')) add(w.slice(0, -2));
  if (w.endsWith('ches')) add(w.slice(0, -2));
  if (w.endsWith('shes')) add(w.slice(0, -2));
  if (w.endsWith('men')) add(w.slice(0, -3) + 'man');
  if (w.endsWith('ies')) add(w.slice(0, -3) + 'y');
  // verbs
  if (w.endsWith('es')) {
    add(w.slice(0, -1)); // "es" → "e"
    add(w.slice(0, -2)); // "es" → ""
  }
  stripEdIng('ed');
  stripEdIng('ing');
  // adjectives
  if (w.endsWith('er')) {
    add(w.slice(0, -2)); // "faster" → "fast"
    add(w.slice(0, -1)); // "later" → "late"
  }
  if (w.endsWith('est')) {
    add(w.slice(0, -3)); // "fastest" → "fast"
    add(w.slice(0, -2)); // "latest" → "late"
  }
  return out;
}

// ---------------------------------------------------------------------------
// lookup

const POS_CODES = ['n', 'v', 'a', 'r', 'm', 'u', 'd', 'p', 'c'] as const;

function isPos(p: string): p is DictPos {
  return (POS_CODES as readonly string[]).includes(p);
}

async function sensesFor(word: string): Promise<DictSense[] | null> {
  const shard = await getShard(shardKey(word));
  if (!shard) return null;
  // hasOwnProperty guard: never resolve "constructor" & co. from the prototype
  if (!Object.prototype.hasOwnProperty.call(shard, word)) return null;
  const entry = shard[word];
  if (!Array.isArray(entry)) return null;
  const senses: DictSense[] = [];
  for (const [pos, def, ex, syn] of entry) {
    const p = pos === 's' ? 'a' : pos; // adjective satellite → adjective
    if (!isPos(p) || typeof def !== 'string') continue;
    const sense: DictSense = { pos: p, def };
    if (typeof ex === 'string' && ex) sense.ex = ex;
    if (Array.isArray(syn) && syn.length) sense.syn = syn.filter((s) => typeof s === 'string');
    senses.push(sense);
  }
  return senses.length > 0 ? senses : null;
}

/**
 * Look up a word tapped in the reader. Normalizes the input, then tries:
 * exact match → morph.json irregulars → WordNet regular detachment rules.
 * Returns the first lemma that has senses, or null (including on any
 * network/parse failure — this never throws to the UI).
 */
export async function lookupWord(raw: string): Promise<DictResult | null> {
  const word = normalize(raw);
  if (!word) return null;

  const exact = await sensesFor(word);
  if (exact) return { word, senses: exact };

  const candidates: string[] = [];
  const morph = await getMorph();
  if (morph && Object.prototype.hasOwnProperty.call(morph, word)) {
    const lemmas = morph[word];
    if (Array.isArray(lemmas)) {
      for (const lemma of lemmas) {
        if (typeof lemma === 'string' && lemma !== word && !candidates.includes(lemma)) {
          candidates.push(lemma);
        }
      }
    }
  }
  for (const c of detachmentCandidates(word)) {
    if (!candidates.includes(c)) candidates.push(c);
  }

  for (const candidate of candidates) {
    const senses = await sensesFor(candidate);
    if (senses) return { word: candidate, senses };
  }
  return null;
}
