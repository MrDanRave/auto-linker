// src/features/nlp.ts
// NLP preprocessing pipeline — Phase 1 plumbing.
// Provides tokenization, case analysis, stemming, language detection, and
// a graded word-commonness score backed by a bundled frequency list.
// This module has no Obsidian dependencies and is designed to be pure/testable.
// Not wired into scanning yet — consumed by scoreRegion in Phase 2.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Token {
  text: string;   // original characters from the source text
  lower: string;  // lowercased form
  start: number;  // byte/char offset in source text (inclusive)
  end: number;    // byte/char offset (exclusive)
}

export interface CaseAnalysis {
  type: "allcaps" | "titlecase" | "lower" | "mixed";
  /** True when the token opens a sentence (after .!? or at text start / paragraph break).
   *  Used by caseScore so sentence-initial capitals don't inflate the signal. */
  isSentenceStart: boolean;
}

// ---------------------------------------------------------------------------
// Tokenize — Unicode-aware word extraction with exact offsets
// ---------------------------------------------------------------------------

export function tokenize(text: string): Token[] {
  // Intl.Segmenter is the correct Unicode word-boundary tool; check at runtime
  // because the tsconfig lib targets ES2018 and doesn't declare it.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const IntlAny = Intl as any;
  const segmenterSupported = typeof IntlAny !== "undefined" && typeof IntlAny.Segmenter === "function";

  if (segmenterSupported) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const seg = new IntlAny.Segmenter(undefined, { granularity: "word" });
    const tokens: Token[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const { segment, index, isWordLike } of seg.segment(text)) {
      if (isWordLike) {
        tokens.push({
          text: segment as string,
          lower: (segment as string).toLowerCase(),
          start: index as number,
          end: (index as number) + (segment as string).length,
        });
      }
    }
    return tokens;
  }

  // Fallback: Unicode letter/number regex (works in ES2018+ with `u` flag)
  const re = /\p{L}[\p{L}\p{N}_-]*/gu;
  const tokens: Token[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    tokens.push({
      text: m[0],
      lower: m[0].toLowerCase(),
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Bucket-driven tokenization (Phase 4)
//
// Every non-alphanumeric character belongs to exactly one bucket:
//   - intra  : kept *inside* a token when flanked by content (e.g. "802.1q")
//   - anchor : a strong separator — each side is an independent anchor to the note
//   - phrase : a weak separator — parts are weak, the contiguous run is the match
// Whitespace and any unclassified punctuation default to phrase separators.
// ---------------------------------------------------------------------------

export interface BucketConfig {
  intra: string;   // chars kept inside tokens between content chars
  phrase: string;  // weak separators
  anchor: string;  // strong (doubler) separators
}

export const DEFAULT_BUCKETS: BucketConfig = {
  intra:  ".",
  phrase: "/-",
  anchor: ":=+;",
};

export type GapKind = "none" | "phrase" | "anchor";

export interface Atom {
  text: string;
  lower: string;
  start: number;       // offset in source text (inclusive)
  end: number;         // offset (exclusive)
  gapBefore: GapKind;  // strongest separator between the previous atom and this one
}

function isLetterOrNumber(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/**
 * Split `text` into atoms (maximal runs of content chars, with intra chars kept
 * inside when flanked by content). Each atom records the strongest separator
 * encountered since the previous atom, so callers can avoid crossing anchors.
 */
export function tokenizeAtoms(text: string, b: BucketConfig = DEFAULT_BUCKETS): Atom[] {
  const atoms: Atom[] = [];
  let buf = "";
  let atomStart = 0;
  let pendingGap: GapKind = "none";
  const n = text.length;

  const flush = (end: number) => {
    if (buf !== "") {
      atoms.push({ text: buf, lower: buf.toLowerCase(), start: atomStart, end, gapBefore: pendingGap });
      buf = "";
      pendingGap = "none";
    }
  };

  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (isLetterOrNumber(ch)) {
      if (buf === "") atomStart = i;
      buf += ch;
      i++;
    } else if (
      b.intra.includes(ch) &&
      buf !== "" &&
      i + 1 < n &&
      (isLetterOrNumber(text[i + 1]) || b.intra.includes(text[i + 1]))
    ) {
      // intra char inside a token (e.g. the '.' in "802.1q")
      buf += ch;
      i++;
    } else {
      // separator
      flush(i);
      const cls: GapKind = b.anchor.includes(ch) ? "anchor" : "phrase";
      if (cls === "anchor") pendingGap = "anchor";
      else if (pendingGap !== "anchor") pendingGap = "phrase";
      i++;
    }
  }
  flush(n);
  return atoms;
}

/** Split a flat atom list into units, breaking wherever an anchor separator occurred. */
export function splitUnits(atoms: Atom[]): Atom[][] {
  const units: Atom[][] = [];
  let cur: Atom[] = [];
  for (const a of atoms) {
    if (a.gapBefore === "anchor" && cur.length) { units.push(cur); cur = []; }
    cur.push(a);
  }
  if (cur.length) units.push(cur);
  return units;
}

/**
 * Strip trailing digits/specials to get a base token (the "father" of a digit
 * variant). Returns null when there's nothing to strip or the base is too short.
 * "hub1" → "hub";  "fig12" → "fig";  "802.1q" → null (no trailing digits);
 * "v2" → null (base "v" too short).
 */
export function extractBase(token: string): string | null {
  const base = token.replace(/[0-9._+-]+$/u, "");
  if (base.length >= 2 && base !== token) return base;
  return null;
}

/**
 * Levenshtein distance with an early-exit cap. Returns the true distance if it
 * is ≤ `max`, otherwise `max + 1` (so callers only learn "too far", cheaply).
 */
export function editDistance(a: string, b: string, max: number): number {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > max) return max + 1;
  if (a === b) return 0;
  let prev: number[] = [];
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    const curr: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      curr.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;   // whole row exceeds budget → bail
    prev = curr;
  }
  return prev[lb] <= max ? prev[lb] : max + 1;
}

// ---------------------------------------------------------------------------
// Case analysis
// ---------------------------------------------------------------------------

export function analyzeCase(token: Token, fullText: string): CaseAnalysis {
  const t = token.text;

  // Determine case type
  let type: CaseAnalysis["type"];
  const upper = t.toUpperCase();
  const lower = t.toLowerCase();
  const hasCasedChars = upper !== lower; // false for digits-only, punctuation, etc.

  if (hasCasedChars && t === upper && t.length >= 2) {
    type = "allcaps";
  } else if (hasCasedChars && t[0] === upper[0] && t.slice(1) === lower.slice(1)) {
    type = "titlecase";
  } else if (!hasCasedChars || t === lower) {
    type = "lower";
  } else {
    type = "mixed";
  }

  // Sentence-start detection: scan backwards from token.start,
  // skip whitespace, check what precedes the token.
  let isSentenceStart = false;
  if (token.start === 0) {
    isSentenceStart = true;
  } else {
    let i = token.start - 1;
    while (i >= 0 && /\s/.test(fullText[i])) i--;
    if (i < 0) {
      isSentenceStart = true; // nothing before the token
    } else {
      // Terminal punctuation → new sentence
      if (/[.!?]/.test(fullText[i])) {
        isSentenceStart = true;
      } else {
        // Newline-preceded → paragraph break counts as sentence start
        const gap = fullText.slice(i + 1, token.start);
        if (gap.includes("\n")) isSentenceStart = true;
      }
    }
  }

  return { type, isSentenceStart };
}

// ---------------------------------------------------------------------------
// Language detection — cheap script-range heuristic
// ---------------------------------------------------------------------------

export function detectLang(text: string): string {
  const sample = text.slice(0, 300);
  let hebrew = 0, arabic = 0, cyrillic = 0, latin = 0;

  for (let i = 0; i < sample.length; i++) {
    const cp = sample.codePointAt(i) ?? 0;
    if (cp >= 0x05d0 && cp <= 0x05ea) hebrew++;
    else if (cp >= 0x0600 && cp <= 0x06ff) arabic++;
    else if (cp >= 0x0400 && cp <= 0x04ff) cyrillic++;
    else if (
      (cp >= 0x0041 && cp <= 0x007a) ||
      (cp >= 0x00c0 && cp <= 0x024f)
    )
      latin++;
  }

  const max = Math.max(hebrew, arabic, cyrillic, latin);
  if (max === 0) return "en";
  if (max === hebrew) return "he";
  if (max === arabic) return "ar";
  if (max === cyrillic) return "ru";
  return "en";
}

// ---------------------------------------------------------------------------
// Stemmer — Snowball English (Porter2)
//
// Hebrew and Arabic are NOT supported by Snowball; stem() returns the input
// unchanged for those scripts so the inverted-index still works (no stem
// expansion). Contextual matching for those languages is deferred to the
// embedding tier (Phase 4).
// ---------------------------------------------------------------------------

/** Returns the stem of `word` in the given language. */
export function stem(word: string, lang: string): string {
  if (!word) return word;
  // Hebrew / Arabic: no rule-based stemming; embedding tier handles them.
  if (lang === "he" || lang === "ar") return word.toLowerCase();
  // For all Latin-script / Cyrillic languages we apply the English Porter2
  // algorithm as a reasonable approximation until per-language models are added.
  return porter2(word.toLowerCase());
}

// ── Porter2 (Snowball English) implementation ────────────────────────────────

// isVowel: after the markY pass, uppercase 'Y' is a consonant;
// lowercase 'y' (preceded by consonant) is a vowel.
function iv(w: string, i: number): boolean {
  const c = w[i];
  return c !== undefined && "aeiouy".includes(c);
}

// Mark consonant-y positions as 'Y' so iv() works without lookahead.
function markY(w: string): string {
  if (w.length === 0) return w;
  let out = w[0] === "y" ? "Y" : w[0]; // initial y is always consonant
  for (let i = 1; i < w.length; i++) {
    out += w[i] === "y" && iv(w, i - 1) ? "Y" : w[i];
  }
  return out;
}

// Compute R1 and R2 regions (positions, not lengths).
function r1r2(w: string): [number, number] {
  const n = w.length;
  let r1 = n;
  for (let i = 1; i < n; i++) {
    if (!iv(w, i) && iv(w, i - 1)) { r1 = i + 1; break; }
  }
  if (r1 < 3) r1 = 3;
  let r2 = n;
  for (let i = r1 + 1; i < n; i++) {
    if (!iv(w, i) && iv(w, i - 1)) { r2 = i + 1; break; }
  }
  return [r1, r2];
}

// Short syllable: CVC at the last 3 positions where final C is not w/x/Y,
// or VC at positions 0,1 when end===2.
function shortSyl(w: string, end: number): boolean {
  if (end < 2) return false;
  if (end === 2) return iv(w, 0) && !iv(w, 1);
  const c = w[end - 1];
  return (
    !iv(w, end - 3) &&
    iv(w, end - 2) &&
    !iv(w, end - 1) &&
    c !== "w" &&
    c !== "x" &&
    c !== "Y"
  );
}

// Word-specific exceptions (from Snowball spec)
const P2_EXC: Record<string, string> = {
  skis: "ski", skies: "sky", dying: "die", lying: "lie", tying: "tie",
  idly: "idl", gently: "gentl", ugly: "ugli", early: "earli", only: "onli",
  singly: "singl", sky: "sky", news: "news", howe: "howe", atlas: "atlas",
  cosmos: "cosmos", bias: "bias", andes: "andes",
};
const P2_EXC2 = new Set([
  "inning", "outing", "canning", "herring", "earring",
  "proceed", "exceed", "succeed",
]);

function porter2(word: string): string {
  let w = word.toLowerCase();
  if (w.length <= 2) return w;

  const exc = P2_EXC[w];
  if (exc !== undefined) return exc;

  // Strip leading apostrophe
  if (w[0] === "'") { w = w.slice(1); if (!w) return word.toLowerCase(); }

  w = markY(w);
  let [r1, r2] = r1r2(w);

  // ── Step 1a ───────────────────────────────────────────────────────────────
  if (w.endsWith("sses")) {
    w = w.slice(0, -2);
  } else if (w.endsWith("ied") || w.endsWith("ies")) {
    w = w.length > 4 ? w.slice(0, -2) : w.slice(0, -1);
  } else if (!w.endsWith("ss") && !w.endsWith("us") && w.endsWith("s")) {
    const s = w.slice(0, -1);
    // Delete s if the stem contains a vowel (not just the char preceding s)
    if (s.length >= 2 && s.slice(0, -1).split("").some((_, j) => iv(s, j))) {
      w = s;
    }
  }

  if (P2_EXC2.has(w)) return w;

  [r1, r2] = r1r2(w);

  // ── Step 1b ───────────────────────────────────────────────────────────────
  let applied1b = false;
  if (w.endsWith("eedly")) {
    if (w.length - 5 >= r1) w = w.slice(0, -3);
  } else if (w.endsWith("eed")) {
    if (w.length - 3 >= r1) w = w.slice(0, -1);
  } else {
    for (const suf of ["edly", "ingly", "ed", "ing"] as const) {
      if (w.endsWith(suf)) {
        const s = w.slice(0, -suf.length);
        if (s.split("").some((_, j) => iv(s, j))) {
          w = s; applied1b = true; break;
        }
      }
    }
    if (applied1b) {
      if (w.endsWith("at") || w.endsWith("bl") || w.endsWith("iz")) {
        w += "e";
      } else {
        const L = w.length;
        const last = w[L - 1];
        if (
          L >= 2 &&
          last === w[L - 2] &&
          !iv(w, L - 1) &&
          !"lsz".includes(last)
        ) {
          w = w.slice(0, -1); // remove one of the doubled final consonant
        } else {
          [r1] = r1r2(w);
          if (shortSyl(w, w.length) && r1 === w.length) w += "e";
        }
      }
    }
  }

  [r1, r2] = r1r2(w);

  // ── Step 1c ───────────────────────────────────────────────────────────────
  // y/Y preceded by a consonant (not at start) → i
  if (
    (w.endsWith("y") || w.endsWith("Y")) &&
    w.length > 2 &&
    !iv(w, w.length - 2)
  ) {
    w = w.slice(0, -1) + "i";
  }

  [r1, r2] = r1r2(w);

  // ── Step 2 ────────────────────────────────────────────────────────────────
  const s2: [string, string][] = [
    ["ization", "ize"], ["ational", "ate"], ["fulness", "ful"],
    ["ousness", "ous"], ["iveness", "ive"], ["tional",  "tion"],
    ["biliti",  "ble"], ["lessli",  "less"],["entli",   "ent"],
    ["ation",   "ate"], ["alism",   "al"],  ["aliti",   "al"],
    ["ousli",   "ous"], ["iviti",   "ive"], ["fulli",   "ful"],
    ["enci",    "ence"],["anci",    "ance"],["abli",    "able"],
    ["izer",    "ize"], ["ator",    "ate"], ["alli",    "al"],
    ["bli",     "ble"],
  ];
  for (const [suf, rep] of s2) {
    if (w.endsWith(suf)) {
      const se = w.length - suf.length;
      if (se >= r1) { w = w.slice(0, se) + rep; break; }
    }
  }
  // li: delete if preceded by a valid consonant
  if (w.endsWith("ogi") && w.length - 3 >= r1 && w[w.length - 4] === "l") {
    w = w.slice(0, -1);
  } else if (w.endsWith("li") && w.length - 2 >= r1 && w.length > 3) {
    if ("cdeghkmnrt".includes(w[w.length - 3])) w = w.slice(0, -2);
  }

  [r1, r2] = r1r2(w);

  // ── Step 3 ────────────────────────────────────────────────────────────────
  const s3: [string, string][] = [
    ["ational", "ate"], ["tional", "tion"], ["alize", "al"],
    ["icate",   "ic"],  ["iciti",  "ic"],   ["ical",  "ic"],
    ["ness",    ""],    ["ful",    ""],
  ];
  for (const [suf, rep] of s3) {
    if (w.endsWith(suf)) {
      const se = w.length - suf.length;
      if (se >= r1) { w = w.slice(0, se) + rep; break; }
    }
  }
  if (w.endsWith("ative") && w.length - 5 >= r2) w = w.slice(0, -5);

  [r1, r2] = r1r2(w);

  // ── Step 4 ────────────────────────────────────────────────────────────────
  for (const suf of [
    "ement", "ment", "ance", "ence", "able", "ible", "ism",
    "ate", "iti", "ous", "ive", "ize", "ent", "ant", "al", "er", "ic",
  ]) {
    if (w.endsWith(suf)) {
      const se = w.length - suf.length;
      if (se >= r2) { w = w.slice(0, se); break; }
    }
  }
  // ion: only if preceded by s or t
  if (w.endsWith("ion")) {
    const se = w.length - 3;
    const pre = w[se - 1];
    if (se >= r2 && (pre === "s" || pre === "t")) w = w.slice(0, se);
  }

  [r1, r2] = r1r2(w);

  // ── Step 5 ────────────────────────────────────────────────────────────────
  if (w.endsWith("e")) {
    const se = w.length - 1;
    if (se >= r2 || (se >= r1 && !shortSyl(w, se))) w = w.slice(0, -1);
  } else if (w.endsWith("ll") && w.length - 1 >= r2) {
    w = w.slice(0, -1);
  }

  return w.replace(/Y/g, "y");
}

// ---------------------------------------------------------------------------
// Word commonness — graded soft stop-list backed by a bundled frequency list
// ---------------------------------------------------------------------------

// commonness(lowerWord, lang) → [0,1]  (1 = extremely common, 0 = rare/unknown)
//
// Only English is bundled in Phase 1. Other languages return 0 (distinctive).
// IDF from the vault title corpus (Phase 2) will reinforce this signal.
export function commonness(lowerWord: string, lang: string): number {
  if (lang !== "en") return 0;
  if (HIGH_FREQ_EN.has(lowerWord)) return 0.9;
  if (MED_FREQ_EN.has(lowerWord)) return 0.5;
  return 0;
}

// ── English word frequency tiers ─────────────────────────────────────────────
//
// Tier 1 (commonness 0.9): function words, auxiliaries, top pronouns/adverbs.
// These almost never make good link targets.
//
// Tier 2 (commonness 0.5): frequent content words that can still be titles
// but need extra signal (graph score / semantic) to be suggested.

// prettier-ignore
const HIGH_FREQ_EN = new Set([
  // articles
  "a","an","the",
  // core prepositions
  "in","on","at","to","of","for","with","from","by","as","into","through",
  "during","before","after","above","below","between","among","under","up",
  "down","over","out","off","about","against","along","behind","beside",
  "beyond","despite","except","inside","near","outside","past","per",
  "plus","since","toward","towards","without","within","across","around",
  "until","upon","versus",
  // conjunctions
  "and","but","or","nor","yet","so","for","although","though","because",
  "since","unless","while","when","where","why","how","if","than","that",
  "which","who","whom","whose","whether","whereas","wherever","whenever",
  "neither","either","both","each","every",
  // pronouns
  "i","you","he","she","it","we","they","me","him","her","us","them",
  "my","your","his","its","our","their","mine","yours","hers","ours",
  "theirs","myself","yourself","himself","herself","itself","ourselves",
  "themselves","this","these","those","what","whatever","whoever","whomever",
  "anyone","everyone","someone","nothing","everything","something","anything",
  "all","any","few","more","most","other","some","such","no","none",
  // auxiliaries and very common verbs
  "be","is","are","was","were","been","being",
  "have","has","had","do","does","did",
  "will","would","can","could","should","may","might","shall","must",
  "ought","need","dare","used",
  // common adverbs / particles
  "not","no","also","just","very","well","even","only","here","there",
  "now","then","still","already","yet","always","never","often","again",
  "together","away","back","forward","else","so","too","instead",
  "however","therefore","thus","hence","meanwhile","indeed","rather",
  "quite","almost","nearly","perhaps","maybe","probably","certainly",
  "already","rather","instead","otherwise","somewhere","nowhere","everywhere",
  // "from" and "and" are already above; these catch other short noise words
  "am","an","at","be","by","do","go","he","if","in","is","it","me",
  "my","no","of","on","or","so","to","up","us","we",
]);

// prettier-ignore
const MED_FREQ_EN = new Set([
  // common nouns
  "time","year","people","way","day","man","woman","child","world","life",
  "hand","part","place","case","week","company","system","program","question",
  "government","number","night","point","home","water","room","mother","area",
  "money","story","fact","month","lot","right","study","book","eye","job",
  "word","business","issue","side","kind","head","house","service","friend",
  "father","power","hour","game","line","end","group","name","state","country",
  "problem","lead","order","member","field","body","change","level","result",
  "reason","value","school","family","work","old","new","help","start",
  "city","interest","idea","base","age","person","large","form","force",
  "process","term","war","history","law","set","turn","example","rate",
  "data","type","use","next","call","list","form","step","plan","care",
  "note","role","view","run","act","key","top","cut","air","move","light",
  "letter","hand","test","voice","sense","focus","heart","point","class",
  "center","model","cost","need","event","decision","effort","team","effect",
  "position","action","condition","task","form","experience","end","form",
  "theory","thought","unit","matter","society","goal","factor","project",
  "article","moment","system","network","market","support","figure","example",
  "pattern","range","approach","structure","policy","series","staff","nature",
  "stage","period","report","local","resource","method","quality","control",
  // common verbs
  "make","take","come","give","look","use","find","tell","ask","seem",
  "feel","try","leave","call","keep","help","show","hear","let","put",
  "bring","begin","hold","stand","lose","pay","meet","run","lead","read",
  "move","live","play","believe","hold","cause","provide","serve","return",
  "include","continue","set","learn","allow","add","spend","grow","open",
  "walk","win","offer","remember","love","consider","appear","buy","wait",
  "serve","change","raise","pass","sell","require","report","decide",
  "pull","break","suggest","claim","follow","mean","produce","contain",
  "apply","base","build","develop","relate","write","speak","talk","think",
  "know","see","say","get","go","want","come","take","give","look",
  // common adjectives
  "good","new","old","great","high","large","small","long","big","little",
  "next","early","young","important","public","private","real","best",
  "free","able","different","national","local","main","possible","actual",
  "major","common","similar","right","wrong","strong","social","general",
  "simple","certain","clear","open","various","low","short","hard","single",
  "final","political","natural","true","positive","current","full","ready",
  "sure","third","international","human","special","personal","available",
  "central","physical","traditional","historical","normal","significant",
  "economic","medical","direct","standard","specific","personal","cultural",
  // common transition words
  "also","then","thus","hence","first","second","third","finally",
  "next","last","such","other","many","much","more","most","less",
]);
