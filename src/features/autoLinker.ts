import { App, TFile, Component, MarkdownRenderer, EventRef, CachedMetadata } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
  Token, analyzeCase, detectLang, stem, commonness,
  BucketConfig, DEFAULT_BUCKETS, tokenizeAtoms, splitUnits, extractBase, editDistance,
} from "./nlp";
import { GraphScorer } from "./graph";
import { SemanticIndex, TransformersEmbedder, DEFAULT_MODEL, sentenceAround } from "./embeddings";
import {
  addDecoEffect,
  removeDecoEffect,
  clearDecosEffect,
  removeBySpanTargetEffect,
  DecorationMeta,
  WidgetCallbacks,
  ApproveMods,
  createDecoField,
  createSuggestionTooltip,
  createDebouncedViewPlugin,
  DirtyRegion,
} from "../shared/cm6";
import { StateEffect } from "@codemirror/state";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Suggestion {
  id: string;         // `${targetPath}::${from}::${to}`
  from: number;
  to: number;
  span: string;
  targetPath: string;
  targetName: string;
}

export type MatchType = "literal" | "semantic";

export interface ScoredSuggestion extends Suggestion {
  confidence: number;
  /** "semantic" = this only crossed the threshold because the meaning signal lifted it. */
  matchType: MatchType;
}

export type ScoringWeights = { lex: number; sig: number; case: number; graph: number; sem: number; accept: number };

/** Scoring weights + default Sensitivity value.  Exported so settings can "Restore defaults".
 *  Weights are relative — the scorer renormalizes over available signals — so the slider
 *  scale (0–100 in settings) and this 0–1 scale are interchangeable. */
export const SCORING: { weights: ScoringWeights; threshold: number } = {
  // Semantics is deliberately a low-weight refiner, not a driver.
  weights: { lex: 0.40, sig: 0.25, case: 0.15, graph: 0.10, sem: 0.05, accept: 0.05 },
  /** Default Sensitivity slider position (0–100). */
  threshold: 55,
};

/** Lexical penalty applied to a base (digit-variant father) match vs an exact token. */
const BASE_MATCH_FACTOR = 0.85;
/** Bonus lifting an *exact* single-token match above its raw IDF coverage —
 *  a clean token equality is stronger evidence than coverage alone implies. */
const EXACT_TOKEN_BONUS = 0.25;
/** Confidence bonus when two adjacent anchors corroborate the same target (merge). */
const MERGE_BONUS = 0.1;
/** Fuzzy (typo) matching budget. Tokens must be ≥ FUZZY_MIN_LEN to fuzzy-match at
 *  all; 2 edits are allowed only for long (≥ FUZZY_FAR_LEN) tokens, else 1. Kept
 *  tight so "renorm"≉"record" and "note"≉"not" don't slip through. */
const FUZZY_MIN_LEN = 5;
const FUZZY_FAR_LEN = 8;
/** Accept count at which the acceptance signal saturates toward 1.0. */
const ACCEPT_SATURATE = 3;

function computeThreshold01(sensitivity: number): number {
  // sensitivity 0 → strict (0.75), 100 → loose (0.30), default 55 ≈ 0.50
  return 0.75 + (0.30 - 0.75) * (sensitivity / 100);
}

/**
 * A rejection lives in exactly one of two buckets, and both persist:
 *   - notePath === null → VAULT-bound: suppress (span→target) in every note.
 *   - notePath === "x"  → NOTE-bound:  suppress (span→target) only in that note.
 */
interface RejectEntry {
  span: string;
  targetPath: string;
  notePath: string | null;
  /** How the rejected suggestion was surfaced (for display/grouping only —
   *  NOT part of the reject identity, so a reject suppresses span→target
   *  regardless of provenance and can't quietly resurface via the other type). */
  matchType?: MatchType;
}

interface LearnedAlias {
  surface: string;     // display text the user linked with (e.g. "value")
  targetPath: string;  // note it pointed to (e.g. "Valuable.md")
}

interface PersistedState {
  rejectList: RejectEntry[];
  /** Positive map: surface forms the user has linked → target (the #1 feature). */
  learnedAliases?: LearnedAlias[];
  /** Per (stemmed-span → target) accept counts; seeds the acceptance signal. */
  acceptance?: Record<string, number>;
}

interface StagedReject {
  span: string;
  targetPath: string;
  targetName: string;
  notePath: string;   // origin note (where the X was clicked)
  noteName: string;
  matchType: MatchType;
}

const VAULT = "*"; // key token for vault-bound entries

function rejectKey(span: string, targetPath: string, notePath: string | null): string {
  return `${span}|||${targetPath}|||${notePath ?? VAULT}`;
}

// ---------------------------------------------------------------------------
// Title index
// ---------------------------------------------------------------------------

const MIN_TOKEN_LEN = 2;

/** A title (or alias) decomposes into one or more anchor-delimited units.
 *  Each unit is its own mini-title for matching: matching it fully = lexScore 1.0. */
export interface Unit {
  path: string;
  tokens: string[];   // stemmed tokens of this unit, in order
  phraseKey: string;  // tokens.join(" ")  — key for full-unit (n-gram) lookup
}

/** A weighted edge from a lookup token to a unit. `exact` = the token is a real
 *  unit token; `exact:false` = it's a stripped base (digit-variant father). */
interface TokenEdge {
  unit: Unit;
  token: string;   // the unit's actual token this edge resolves to
  exact: boolean;
}

export class TitleIndex {
  private index = new Map<string, string>();              // lowerTitle|alias → path (kept for getPath compatibility)
  private unitsByPath = new Map<string, Unit[]>();          // path → its units
  private byToken = new Map<string, TokenEdge[]>();         // lookup token (exact or base) → edges
  private byPhrase = new Map<string, Unit[]>();             // full phraseKey → units
  private firstChar = new Map<string, Set<string>>();       // token[0] → set of lookup tokens (fuzzy prefilter)
  private docFreq = new Map<string, number>();             // token → # notes whose title contains it (exact+base)
  private _maxPhraseLen = 1;

  buckets: BucketConfig = DEFAULT_BUCKETS;

  constructor(private app: App) {}

  get totalDocs(): number { return this.unitsByPath.size; }
  get maxPhraseLen(): number { return this._maxPhraseLen; }

  setBuckets(b: BucketConfig) { this.buckets = b; }

  /** Decompose a name into units. Every token is kept so the unit's phrase matches
   *  the typed text verbatim (incl. short tokens like "3" in "Payment method 3 - CAD");
   *  only tokens ≥ MIN_TOKEN_LEN are *indexed* for standalone single-token lookup. */
  private nameToUnits(path: string, name: string): Unit[] {
    const lang  = detectLang(name);
    const atoms = tokenizeAtoms(name, this.buckets);
    const units: Unit[] = [];
    for (const unitAtoms of splitUnits(atoms)) {
      const tokens = unitAtoms.map((a) => stem(a.lower, lang));
      if (tokens.length) units.push({ path, tokens, phraseKey: tokens.join(" ") });
    }
    return units;
  }

  private addUnits(path: string, units: Unit[]) {
    if (!units.length) return;
    this.unitsByPath.set(path, units);

    const noteTokens = new Set<string>();  // distinct lookup tokens for df (per note)
    for (const unit of units) {
      this._maxPhraseLen = Math.max(this._maxPhraseLen, unit.tokens.length);

      let arr = this.byPhrase.get(unit.phraseKey);
      if (!arr) { arr = []; this.byPhrase.set(unit.phraseKey, arr); }
      arr.push(unit);

      for (const token of unit.tokens) {
        noteTokens.add(token);                       // df counts all tokens (sane IDF)
        if (token.length < MIN_TOKEN_LEN) continue;  // but don't index 1-char tokens standalone
        this.pushEdge(token, { unit, token, exact: true });
        const base = extractBase(token);
        if (base) {
          this.pushEdge(base, { unit, token, exact: false });
          noteTokens.add(base);
        }
      }
    }
    for (const t of noteTokens) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
  }

  private pushEdge(key: string, edge: TokenEdge) {
    let arr = this.byToken.get(key);
    if (!arr) { arr = []; this.byToken.set(key, arr); }
    arr.push(edge);
    const c = key[0];
    let set = this.firstChar.get(c);
    if (!set) { set = new Set(); this.firstChar.set(c, set); }
    set.add(key);
  }

  private removeUnits(path: string) {
    const units = this.unitsByPath.get(path);
    if (!units) return;
    this.unitsByPath.delete(path);

    const noteTokens = new Set<string>();
    for (const unit of units) {
      const arr = this.byPhrase.get(unit.phraseKey);
      if (arr) {
        const kept = arr.filter((u) => u !== unit);
        if (kept.length) this.byPhrase.set(unit.phraseKey, kept);
        else this.byPhrase.delete(unit.phraseKey);
      }
      for (const token of unit.tokens) {
        noteTokens.add(token);
        if (token.length < MIN_TOKEN_LEN) continue;
        const base = extractBase(token);
        if (base) noteTokens.add(base);
      }
    }
    for (const key of noteTokens) {
      const arr = this.byToken.get(key);
      if (arr) {
        const kept = arr.filter((e) => e.unit.path !== path);
        if (kept.length) this.byToken.set(key, kept);
        else {
          this.byToken.delete(key);
          this.firstChar.get(key[0])?.delete(key);
        }
      }
      const df = (this.docFreq.get(key) ?? 1) - 1;
      if (df <= 0) this.docFreq.delete(key);
      else this.docFreq.set(key, df);
    }
  }

  // ── Lookup / scoring helpers ───────────────────────────────────────────────

  /** Full-unit matches for a contiguous n-gram (size ≥ 1). */
  getUnitsByPhrase(phraseKey: string): Unit[] | undefined { return this.byPhrase.get(phraseKey); }

  /** Partial / base matches for a single token. */
  getEdges(token: string): TokenEdge[] | undefined { return this.byToken.get(token); }

  /** Index tokens within edit distance `maxDist` of `token` (excludes exact).
   *  Prefiltered by shared first character + length, so it touches one bucket. */
  fuzzyMatch(token: string, maxDist: number): Array<{ key: string; dist: number }> {
    const out: Array<{ key: string; dist: number }> = [];
    const bucket = this.firstChar.get(token[0]);
    if (!bucket) return out;
    for (const key of bucket) {
      if (key === token) continue;
      if (Math.abs(key.length - token.length) > maxDist) continue;
      const d = editDistance(token, key, maxDist);
      if (d >= 1 && d <= maxDist) out.push({ key, dist: d });
    }
    return out;
  }

  /** Raw IDF weight log(1 + N/df); unknown token → max idf. Used for lexScore coverage ratios. */
  idfWeight(token: string): number {
    const N = this.totalDocs;
    if (N === 0) return 1;
    const df = this.docFreq.get(token) ?? 0;
    return Math.log(1 + N / (df || 0.5));
  }

  /** IDF score normalized to [0,1]. Higher = rarer across all note titles. */
  normalizedIdf(token: string): number {
    const N = this.totalDocs;
    if (N === 0) return 0;
    const df = this.docFreq.get(token) ?? 0;
    if (df === 0) return 1.0;
    const raw    = Math.log(1 + N / df);
    const maxIdf = Math.log(1 + N);
    const minIdf = Math.log(2);
    return Math.max(0, Math.min(1, (raw - minIdf) / (maxIdf - minIdf + 1e-6)));
  }

  /** Sum of IDF weights over a unit's tokens (the unit's total "information"). */
  unitIdfSum(unit: Unit): number {
    let s = 0;
    for (const t of unit.tokens) s += this.idfWeight(t);
    return s || 1;
  }

  /** Learned aliases (path → surface forms) injected like frontmatter aliases. */
  private learnedAliases?: Map<string, Set<string>>;
  setLearnedAliases(map: Map<string, Set<string>>) { this.learnedAliases = map; }

  // ── Build / maintenance ─────────────────────────────────────────────────────

  build() {
    this.index.clear();
    this.unitsByPath.clear();
    this.byToken.clear();
    this.byPhrase.clear();
    this.firstChar.clear();
    this.docFreq.clear();
    this._maxPhraseLen = 1;
    for (const file of this.app.vault.getMarkdownFiles()) this.addFile(file);
  }

  addFile(file: TFile) {
    this.index.set(file.basename.toLowerCase(), file.path);
    const cache   = this.app.metadataCache.getFileCache(file);
    const aliases: unknown = cache?.frontmatter?.["aliases"];
    const names   = [file.basename];
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === "string") { this.index.set(alias.toLowerCase(), file.path); names.push(alias); }
      }
    }
    const learned = this.learnedAliases?.get(file.path);
    if (learned) for (const surface of learned) { this.index.set(surface.toLowerCase(), file.path); names.push(surface); }
    const units: Unit[] = [];
    for (const name of names) units.push(...this.nameToUnits(file.path, name));
    this.addUnits(file.path, units);
  }

  removeFile(file: TFile) {
    for (const [key, path] of this.index) if (path === file.path) this.index.delete(key);
    this.removeUnits(file.path);
  }

  renameFile(file: TFile, oldPath: string) {
    for (const [key, path] of this.index) if (path === oldPath) this.index.delete(key);
    this.removeUnits(oldPath);
    this.addFile(file);
  }

  getPath(lowerTitle: string): string | undefined { return this.index.get(lowerTitle); }
}

// ---------------------------------------------------------------------------
// Scored region scanner (Phase 4) — bucket tokenizer + weighted DAG index
// ---------------------------------------------------------------------------

const LINK_PATTERN = /\[\[([^\]]+)\]\]/g;
const TAG_PATTERN  = /#\w+/g;
// Fenced code block: ``` to the next ``` (or end-of-text). Checked before inline.
const FENCE_PATTERN = /```[\s\S]*?(?:```|$)/g;
// Inline code: a backtick to the next backtick, end-of-line, or end-of-text.
const BACKTICK_PATTERN = /`[^`\n]*(`|$)/gm;

function targetNameOf(targetPath: string): string {
  return targetPath.split("/").pop()?.replace(/\.md$/, "") ?? targetPath;
}

export function scoreRegion(
  text: string,
  regionFrom: number,
  activeFilePath: string,
  index: TitleIndex,
  rejectList: RejectEntry[],
  sensitivity: number,
  graphScorer?: GraphScorer,
  buckets: BucketConfig = DEFAULT_BUCKETS,
  /** Re-rank hook: semScore in [0,1] for (span→target), or null when not yet available. */
  semScore?: (from: number, to: number, targetPath: string) => number | null,
  /** Learned-preference hook: acceptance in [0,1] for (stemmed-span→target), or null. */
  acceptScore?: (stemKey: string, targetPath: string) => number | null,
  /** Signal weights (relative; renormalized per candidate). Defaults to SCORING. */
  weights: ScoringWeights = SCORING.weights
): ScoredSuggestion[] {
  const threshold = computeThreshold01(sensitivity);
  const rejectSet = new Set(rejectList.map((r) => rejectKey(r.span, r.targetPath, r.notePath)));

  // Skip ranges: existing [[links]] and #tags (offsets are local to `text`)
  const skipRanges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  FENCE_PATTERN.lastIndex = 0;
  while ((m = FENCE_PATTERN.exec(text)) !== null) {
    skipRanges.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) FENCE_PATTERN.lastIndex++;
  }
  LINK_PATTERN.lastIndex = 0;
  while ((m = LINK_PATTERN.exec(text)) !== null) skipRanges.push([m.index, m.index + m[0].length]);
  TAG_PATTERN.lastIndex = 0;
  while ((m = TAG_PATTERN.exec(text)) !== null) skipRanges.push([m.index, m.index + m[0].length]);
  BACKTICK_PATTERN.lastIndex = 0;
  while ((m = BACKTICK_PATTERN.exec(text)) !== null) {
    skipRanges.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) BACKTICK_PATTERN.lastIndex++; // guard against zero-width loop
  }
  const isSkipped = (from: number, to: number) => skipRanges.some(([s, e]) => from < e && to > s);

  const lang  = detectLang(text);
  const atoms = tokenizeAtoms(text, buckets);
  if (!atoms.length) return [];
  const stems = atoms.map((a) => stem(a.lower, lang));

  const W = weights;

  // significance(span tokens): least-common (most distinctive) token drives the score.
  const significanceOf = (tokIdxs: number[]): number =>
    Math.max(
      ...tokIdxs.map((i) => {
        const common = commonness(atoms[i].lower, lang);
        const idfN   = index.normalizedIdf(stems[i]);
        return (1 - common) * (0.5 + 0.5 * idfN);
      })
    );

  const caseOf = (from: number, to: number, tokIdxs: number[]): number => {
    const spanText = text.slice(from, to);
    const tok: Token = { text: spanText, lower: spanText.toLowerCase(), start: from, end: to };
    const c = analyzeCase(tok, text);
    if (c.type === "allcaps") return 1.0;
    if (c.type === "titlecase") return c.isSentenceStart ? 0.0 : 0.8;
    if (c.type === "lower") {
      const maxCommon = Math.max(...tokIdxs.map((i) => commonness(atoms[i].lower, lang)));
      return maxCommon > 0.5 ? -1.5 : 0.0;  // suppress lowercase function words
    }
    return 0.0;
  };

  interface Cand { from: number; to: number; span: string; targetPath: string; lexScore: number; tokIdxs: number[]; stemKey: string; }
  const cands: Cand[] = [];

  const maxN = Math.min(index.maxPhraseLen, atoms.length);
  for (let size = maxN; size >= 1; size--) {
    for (let i = 0; i + size <= atoms.length; i++) {
      // A window may not cross an anchor gap (anchors delimit independent units).
      let crossesAnchor = false;
      for (let j = i + 1; j < i + size; j++) if (atoms[j].gapBefore === "anchor") { crossesAnchor = true; break; }
      if (crossesAnchor) continue;

      const from = atoms[i].start;
      const to   = atoms[i + size - 1].end;
      if (isSkipped(from, to)) continue;
      const tokIdxs: number[] = [];
      for (let j = i; j < i + size; j++) tokIdxs.push(j);
      const span = text.slice(from, to);

      // Full-unit (phrase) match → lexScore 1.0
      const phraseKey = stems.slice(i, i + size).join(" ");
      const fullUnits = index.getUnitsByPhrase(phraseKey);
      if (fullUnits) {
        for (const unit of fullUnits) {
          if (unit.path === activeFilePath) continue;
          cands.push({ from, to, span, targetPath: unit.path, lexScore: 1.0, tokIdxs, stemKey: phraseKey });
        }
      }

      // Single-token partial / base match → IDF-weighted coverage of the unit
      if (size === 1) {
        const edges = index.getEdges(stems[i]);
        if (edges) {
          for (const e of edges) {
            if (e.unit.path === activeFilePath) continue;
            if (e.unit.tokens.length === 1 && e.exact) continue; // already covered as a full unit above
            const coverage = Math.min(1, index.idfWeight(e.token) / index.unitIdfSum(e.unit));
            // Exact token → lift above raw coverage; base (digit father) → penalize.
            const lex = e.exact
              ? coverage + (1 - coverage) * EXACT_TOKEN_BONUS
              : coverage * BASE_MATCH_FACTOR;
            cands.push({ from, to, span, targetPath: e.unit.path, lexScore: lex, tokIdxs, stemKey: phraseKey });
          }
        }

        // Fuzzy (typo) match → IDF coverage penalized by edit distance.  Always
        // below an exact hit; short tokens stay exact-only to avoid noise.
        const qStem = stems[i];
        if (qStem.length >= FUZZY_MIN_LEN) {
          const maxDist = qStem.length >= FUZZY_FAR_LEN ? 2 : 1;
          for (const { key, dist } of index.fuzzyMatch(qStem, maxDist)) {
            // Never fuzz into a common function word ("not", "and", "or", …):
            // an approximate match to a stop-word is virtually always spurious.
            if (commonness(key, lang) > 0.5) continue;
            const fuzzyEdges = index.getEdges(key);
            if (!fuzzyEdges) continue;
            for (const e of fuzzyEdges) {
              if (!e.exact) continue;                 // fuzzy-match real tokens, not bases
              if (e.unit.path === activeFilePath) continue;
              const coverage = Math.min(1, index.idfWeight(e.token) / index.unitIdfSum(e.unit));
              const fuzzyFactor = 1 - dist / Math.max(qStem.length, e.token.length);
              cands.push({ from, to, span, targetPath: e.unit.path, lexScore: coverage * fuzzyFactor, tokIdxs, stemKey: phraseKey });
            }
          }
        }
      }
    }
  }

  // ── Pass 1: score every candidate — base (non-semantic) and full confidence ──
  interface Pre { c: Cand; baseConf: number; fullConf: number; semApplied: boolean; }
  const pre: Pre[] = [];
  for (const c of cands) {
    const blockedVault = rejectSet.has(rejectKey(c.span, c.targetPath, null));
    const blockedNote  = rejectSet.has(rejectKey(c.span, c.targetPath, activeFilePath));
    if (blockedVault || blockedNote) continue;

    const sig = significanceOf(c.tokIdxs);
    const cse = caseOf(c.from, c.to, c.tokIdxs);

    // Base confidence = weighted sum over the non-semantic signals (lex/sig/case
    // always; graph & accept when present), renormalized.
    let wBase = W.lex + W.sig + W.case;
    let nBase = W.lex * c.lexScore + W.sig * sig + W.case * cse;
    if (graphScorer) { wBase += W.graph; nBase += W.graph * graphScorer.getScore(c.targetPath); }
    if (acceptScore) {
      const av = acceptScore(c.stemKey, c.targetPath);
      if (av != null) { wBase += W.accept; nBase += W.accept * av; }
    }
    const baseConf = nBase / wBase;

    let fullConf = baseConf;
    let semApplied = false;
    if (semScore) {
      const sv = semScore(c.from, c.to, c.targetPath);
      if (sv != null) { fullConf = (nBase + W.sem * sv) / (wBase + W.sem); semApplied = true; }
    }
    pre.push({ c, baseConf, fullConf, semApplied });
  }

  // ── Pass 2: keep suggestible candidates; mark "semantic" ONLY when the meaning
  // signal was actually applied AND it decided the outcome — either it crossed the
  // threshold that text alone couldn't, OR an overlapping different-target candidate
  // was as strong (or stronger) on text alone, so meaning flipped/held the winner.
  // (Without an applied sem signal, a literal tie is NOT semantic — it's just a tie.) ──
  const overlaps = (a: Cand, b: Cand) => a.from < b.to && a.to > b.from;
  const scored: ScoredSuggestion[] = [];
  for (const p of pre) {
    if (p.fullConf < threshold) continue;
    let matchType: MatchType = "literal";
    if (p.semApplied) {
      if (p.baseConf < threshold) {
        matchType = "semantic";   // meaning lifted it over a bar text alone couldn't clear
      } else {
        for (const q of pre) {
          if (q.semApplied && q.c.targetPath !== p.c.targetPath && overlaps(q.c, p.c) && q.baseConf >= p.baseConf) {
            matchType = "semantic"; // a literal co-leader existed; meaning chose this one
            break;
          }
        }
      }
    }
    scored.push({
      id: `${p.c.targetPath}::${regionFrom + p.c.from}::${regionFrom + p.c.to}`,
      from: regionFrom + p.c.from,
      to:   regionFrom + p.c.to,
      span: p.c.span,
      targetPath: p.c.targetPath,
      targetName: targetNameOf(p.c.targetPath),
      confidence: p.fullConf,
      matchType,
    });
  }

  return dedupe(scored, text, regionFrom, graphScorer ? (p) => graphScorer.getScore(p) : undefined);
}

/**
 * Dedup policies (§3e):
 *   (b) MERGE adjacent same-target spans separated only by non-content → one span, +bonus.
 *   (a/c) OVERLAP: keep the highest-confidence span; suppress any overlapping (incl. contained) span.
 */
function dedupe(
  scored: ScoredSuggestion[],
  text: string,
  regionFrom: number,
  tieBreak?: (targetPath: string) => number,
): ScoredSuggestion[] {
  if (scored.length <= 1) return scored;

  // (b) Merge corroborating adjacent anchors of the same target.
  const byPos = [...scored].sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: ScoredSuggestion[] = [];
  for (const s of byPos) {
    const prev = merged[merged.length - 1];
    if (prev && prev.targetPath === s.targetPath && s.from >= prev.to) {
      const gap = text.slice(prev.to - regionFrom, s.from - regionFrom);
      if (/^[^\p{L}\p{N}]*$/u.test(gap)) {
        prev.to   = Math.max(prev.to, s.to);
        prev.span = text.slice(prev.from - regionFrom, prev.to - regionFrom);
        prev.confidence = Math.min(1, Math.max(prev.confidence, s.confidence) + MERGE_BONUS);
        // A merged span backed by ANY literal anchor is literal — text decided it,
        // even if one part on its own was meaning-lifted. Only an all-semantic
        // merge stays semantic (dotted).
        if (s.matchType === "literal" || prev.matchType === "literal") prev.matchType = "literal";
        prev.id = `${prev.targetPath}::${prev.from}::${prev.to}`;
        continue;
      }
    }
    merged.push({ ...s });
  }

  // (a/c) Overlap resolution — highest confidence wins; then the longer span; then
  // (the chosen tie-break) the more important note by backlinks/PageRank; then a
  // stable path order so an otherwise-equal tie is deterministic, not random.
  const imp = (p: string) => (tieBreak ? tieBreak(p) : 0);
  merged.sort((a, b) =>
    b.confidence - a.confidence ||
    (b.to - b.from) - (a.to - a.from) ||
    imp(b.targetPath) - imp(a.targetPath) ||
    a.targetPath.localeCompare(b.targetPath)
  );
  const kept: ScoredSuggestion[] = [];
  const used: Array<[number, number]> = [];
  for (const s of merged) {
    if (!used.some(([f, t]) => s.from < t && s.to > f)) {
      kept.push(s);
      used.push([s.from, s.to]);
    }
  }
  return kept;
}

// ---------------------------------------------------------------------------
// AutoLinker
// ---------------------------------------------------------------------------

export class AutoLinker {
  readonly titleIndex: TitleIndex;
  readonly graphScorer: GraphScorer;
  private rejectList: RejectEntry[] = [];
  private readonly DATA_KEY = "autoLinker";

  // Learning tier (Phase 7)
  private learnedAliases = new Map<string, Set<string>>();  // targetPath → surface forms
  private acceptCounts   = new Map<string, number>();        // `${stemKey}|||${path}` → count
  private persistCb?: () => void;
  private weights: ScoringWeights = SCORING.weights;

  private buckets: BucketConfig;

  // Semantic tier (Phase 6) — off unless configured with a ready embedder.
  private semantic?: SemanticIndex;
  private embedder?: TransformersEmbedder;
  private enableSemantic = false;
  private rescanCb?: () => void;
  private embeddingsPath?: string;
  private embSaveTimer: number | null = null;

  constructor(private app: App, buckets: BucketConfig = DEFAULT_BUCKETS) {
    this.buckets     = buckets;
    this.titleIndex  = new TitleIndex(app);
    this.titleIndex.setBuckets(buckets);
    this.titleIndex.setLearnedAliases(this.learnedAliases);
    this.graphScorer = new GraphScorer(app);
  }

  /** Persistence callback (set from main) — flushes data.json after learning. */
  setPersist(cb: () => void) { this.persistCb = cb; }

  /** Active-editor rescan callback (set from main); used after learning a new alias. */
  setRescan(cb: () => void) { this.rescanCb = cb; }

  /** Update signal weights from settings (relative; renormalized at scan time). */
  setWeights(w: ScoringWeights) { this.weights = w; }

  /** Where note vectors persist (set from main with the plugin dir). */
  setEmbeddingsPath(path: string) { this.embeddingsPath = path; }

  /** Enable/disable the semantic re-rank tier. Loads the model lazily on enable.
   *  Returns the resulting backend status ("ready" | "error" | "off"). */
  async configureSemantic(enable: boolean, modelPath: string, rescanCb: () => void): Promise<string> {
    this.enableSemantic = enable;
    this.rescanCb = rescanCb;
    if (!enable) { this.semantic = undefined; this.embedder = undefined; return "off"; }
    this.embedder = new TransformersEmbedder(DEFAULT_MODEL, modelPath);
    this.semantic = new SemanticIndex(this.embedder);
    const ok = await this.embedder.init();
    if (ok) {
      await this.loadEmbeddings();   // reuse vectors from previous sessions
      rescanCb();                    // re-score now that the model can refine
    }
    return this.embedder.getStatus();
  }

  semanticStatus(): string { return this.embedder?.getStatus() ?? "off"; }
  semanticError(): string { return this.embedder?.getError() ?? ""; }

  private async loadEmbeddings() {
    if (!this.embeddingsPath || !this.semantic) return;
    try {
      const adapter = this.app.vault.adapter;
      if (await adapter.exists(this.embeddingsPath)) {
        const raw = JSON.parse(await adapter.read(this.embeddingsPath)) as Record<string, { mtime: number; vec: number[] }>;
        this.semantic.load(raw);
      }
    } catch { /* corrupt/missing cache → start fresh */ }
  }

  private scheduleSaveEmbeddings() {
    if (!this.embeddingsPath || !this.semantic) return;
    if (this.embSaveTimer) window.clearTimeout(this.embSaveTimer);
    this.embSaveTimer = window.setTimeout(() => {
      this.embSaveTimer = null;
      const si = this.semantic;
      if (!this.embeddingsPath || !si) return;
      void this.app.vault.adapter.write(this.embeddingsPath, JSON.stringify(si.serialize()));
    }, 3000);
  }

  /** Update tokenizer buckets (from settings) and rebuild the index. */
  setBuckets(buckets: BucketConfig) {
    this.buckets = buckets;
    this.titleIndex.setBuckets(buckets);
    this.titleIndex.build();
  }

  async load(loadData: () => Promise<Record<string, unknown> | null>) {
    const data  = await loadData();
    const saved = data?.[this.DATA_KEY] as PersistedState | undefined;
    // Migrate legacy entries: no notePath → vault-bound; no matchType → literal.
    this.rejectList = (saved?.rejectList ?? []).map((r) => ({
      span: r.span,
      targetPath: r.targetPath,
      notePath: r.notePath ?? null,
      matchType: r.matchType ?? "literal",
    }));

    this.learnedAliases.clear();
    for (const a of saved?.learnedAliases ?? []) {
      let set = this.learnedAliases.get(a.targetPath);
      if (!set) { set = new Set(); this.learnedAliases.set(a.targetPath, set); }
      set.add(a.surface);
    }
    this.acceptCounts.clear();
    for (const [k, v] of Object.entries(saved?.acceptance ?? {})) this.acceptCounts.set(k, v);
  }

  buildWhenReady() {
    // "resolved" fires when Obsidian has fully resolved all inter-note links.
    // Rebuild both the title index (fresh aliases) and graph (fresh link graph).
    this.app.metadataCache.on("resolved", () => {
      this.titleIndex.build();
      this.graphScorer.build();
    });
    this.app.workspace.onLayoutReady(() => {
      this.titleIndex.build();
      // Graph build is deferred to the next "resolved" event which fires shortly after.
    });
  }

  async save(
    loadData: () => Promise<Record<string, unknown> | null>,
    saveData: (d: unknown) => Promise<void>
  ) {
    const existing: Record<string, unknown> = (await loadData()) ?? {};
    const learnedAliases: LearnedAlias[] = [];
    for (const [targetPath, surfaces] of this.learnedAliases)
      for (const surface of surfaces) learnedAliases.push({ surface, targetPath });
    existing[this.DATA_KEY] = {
      rejectList: this.rejectList,
      learnedAliases,
      acceptance: Object.fromEntries(this.acceptCounts),
    } satisfies PersistedState;
    await saveData(existing);
  }

  registerMetadataEvents(registerEvent: (e: EventRef) => void) {
    registerEvent(this.app.metadataCache.on("changed", (file, _data, cache) => {
      // remove-then-add so renamed/removed aliases don't linger
      this.titleIndex.removeFile(file);
      this.titleIndex.addFile(file);
      // Links in this file may have changed → debounce a graph rebuild
      this.graphScorer.scheduleRebuild();
      // #1: learn surface→target aliases from the user's own links.
      this.observeLinks(file, cache);
    }));
    registerEvent(this.app.metadataCache.on("deleted", (file) => this.titleIndex.removeFile(file)));
    registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) this.titleIndex.renameFile(file, oldPath);
    }));
  }

  scan(text: string, regionFrom: number, activeFilePath: string, sensitivity = SCORING.threshold): ScoredSuggestion[] {
    const sem = this.semHook(text);
    const result = scoreRegion(
      text, regionFrom, activeFilePath, this.titleIndex, this.rejectList,
      sensitivity, this.graphScorer, this.buckets, sem, this.acceptHook(), this.weights
    );
    // Refine asynchronously: embed the candidates' sentences/targets, then rescan.
    if (sem) void this.warmAndRescan(text, regionFrom, result);
    return result;
  }

  // ── Learning tier (Phase 7) ─────────────────────────────────────────────────

  /** Stemmed key for a span, matching how scoreRegion keys candidates. */
  private spanStemKey(span: string): string {
    const lang = detectLang(span);
    return tokenizeAtoms(span, this.buckets).map((a) => stem(a.lower, lang)).join(" ");
  }

  /** Acceptance hook: positive signal for (stemmed-span → target) pairs with history. */
  private acceptHook(): ((stemKey: string, targetPath: string) => number | null) | undefined {
    if (this.acceptCounts.size === 0) return undefined;
    return (stemKey, targetPath) => {
      const c = this.acceptCounts.get(`${stemKey}|||${targetPath}`);
      return c ? Math.min(1, 0.6 + 0.4 * Math.min(1, c / ACCEPT_SATURATE)) : null;
    };
  }

  /** Record an accepted suggestion (✓) as positive evidence for future ranking. */
  recordAccept(span: string, targetPath: string) {
    const key = `${this.spanStemKey(span)}|||${targetPath}`;
    this.acceptCounts.set(key, (this.acceptCounts.get(key) ?? 0) + 1);
    this.persistCb?.();
  }

  /** Record a learned alias surface→target (from observed links). Returns true if new. */
  private recordLearnedAlias(surface: string, targetPath: string): boolean {
    let set = this.learnedAliases.get(targetPath);
    if (set?.has(surface)) return false;
    if (!set) { set = new Set(); this.learnedAliases.set(targetPath, set); }
    set.add(surface);
    // Re-index just this note so the new surface becomes matchable immediately.
    const file = this.app.vault.getAbstractFileByPath(targetPath);
    if (file instanceof TFile) { this.titleIndex.removeFile(file); this.titleIndex.addFile(file); }
    return true;
  }

  /** #1: learn surface→target from links the user wrote, e.g. [[Valuable|value]]. */
  private observeLinks(file: TFile, cache: CachedMetadata | null) {
    const links = cache?.links;
    if (!Array.isArray(links)) return;
    let changed = false;
    for (const l of links) {
      const display: string | undefined = l?.displayText;
      const linkpath: string | undefined = l?.link;
      if (!display || !linkpath) continue;
      // Resolve the link target; skip headings/blocks and self-references.
      const dest = this.app.metadataCache.getFirstLinkpathDest(linkpath.split(/[#^|]/)[0], file.path);
      if (!(dest instanceof TFile) || dest.path === file.path) continue;
      const surface = display.trim();
      if (!surface || surface.toLowerCase() === dest.basename.toLowerCase()) continue; // nothing new
      if (this.titleIndex.getPath(surface.toLowerCase()) === dest.path) continue;       // already matchable
      if (this.recordLearnedAlias(surface, dest.path)) changed = true;
    }
    if (changed) { this.persistCb?.(); this.rescanCb?.(); }
  }

  /** Sync semScore hook reading only cached vectors (never blocks); null = not warm. */
  private semHook(text: string): ((from: number, to: number, targetPath: string) => number | null) | undefined {
    const si = this.semantic;
    if (!this.enableSemantic || !si || !si.isReady()) return undefined;
    return (from, to, targetPath) => {
      const file = this.app.vault.getAbstractFileByPath(targetPath);
      if (!(file instanceof TFile)) return null;
      return si.semScoreSync(sentenceAround(text, from, to), targetPath, file.stat.mtime);
    };
  }

  private async warmAndRescan(text: string, regionFrom: number, suggestions: ScoredSuggestion[]) {
    const si = this.semantic;
    if (!si || !si.isReady()) return;
    let changed = false;
    const seenNotes = new Set<string>();
    for (const s of suggestions) {
      const sentence = sentenceAround(text, s.from - regionFrom, s.to - regionFrom);
      if (await si.warmSentence(sentence)) changed = true;
      if (!seenNotes.has(s.targetPath)) {
        seenNotes.add(s.targetPath);
        const file = this.app.vault.getAbstractFileByPath(s.targetPath);
        if (file instanceof TFile) {
          const body = await this.noteEmbedText(file);
          if (await si.warmNote(s.targetPath, file.stat.mtime, body)) changed = true;
        }
      }
    }
    if (changed) {
      this.scheduleSaveEmbeddings();
      if (this.rescanCb) this.rescanCb();
    }
  }

  /** Text embedded for a note's vector: title + first ~200 words. */
  private async noteEmbedText(file: TFile): Promise<string> {
    const content = await this.app.vault.cachedRead(file);
    return `${file.basename}\n${content.split(/\s+/).slice(0, 200).join(" ")}`;
  }

  /** Pre-embed every note's vector (settings button). No-op unless semantics is ready. */
  async indexVaultForSemantics(
    onProgress?: (done: number, total: number) => void
  ): Promise<{ done: number; total: number; ok: boolean }> {
    const si = this.semantic;
    if (!this.enableSemantic || !si || !si.isReady()) return { done: 0, total: 0, ok: false };
    const files = this.app.vault.getMarkdownFiles();
    let done = 0;
    for (const f of files) {
      const body = await this.noteEmbedText(f);
      await si.warmNote(f.path, f.stat.mtime, body);
      onProgress?.(++done, files.length);
    }
    this.scheduleSaveEmbeddings();
    this.rescanCb?.();
    return { done, total: files.length, ok: true };
  }

  destroy() {
    this.graphScorer.destroy();
    if (this.embSaveTimer) window.clearTimeout(this.embSaveTimer);
  }

  // ── Reject lifecycle ──────────────────────────────────────────────────────

  private has(span: string, targetPath: string, notePath: string | null): boolean {
    return this.rejectList.some(
      (r) => r.span === span && r.targetPath === targetPath && r.notePath === notePath
    );
  }

  /** ✗ button: reject (span→target) for this note only. Persisted. */
  noteReject(span: string, targetPath: string, notePath: string, matchType: MatchType = "literal") {
    if (!this.has(span, targetPath, notePath)) {
      this.rejectList.push({ span, targetPath, notePath, matchType });
    }
  }

  /** Panel "Yes": promote to vault-bound — drop any note-bound copies first. */
  vaultReject(span: string, targetPath: string, matchType: MatchType = "literal") {
    this.rejectList = this.rejectList.filter(
      (r) => !(r.span === span && r.targetPath === targetPath)
    );
    this.rejectList.push({ span, targetPath, notePath: null, matchType });
  }

  /** Panel "↩" Restore: remove the note-bound rejection so it can reappear. */
  restoreNoteReject(span: string, targetPath: string, notePath: string) {
    this.rejectList = this.rejectList.filter(
      (r) => !(r.span === span && r.targetPath === targetPath && r.notePath === notePath)
    );
  }

  /**
   * A note (or link target) was deleted — drop every rejection that references
   * its path, in either field, so a future note of the same name is suggestable.
   * Returns true if anything was removed.
   */
  pruneRejectsForPath(path: string): boolean {
    const before = this.rejectList.length;
    this.rejectList = this.rejectList.filter(
      (r) => r.targetPath !== path && r.notePath !== path
    );
    return this.rejectList.length !== before;
  }

  // ── Settings UI accessors ─────────────────────────────────────────────────

  getRejectList(): Array<{
    span: string;
    targetPath: string;
    targetName: string;
    notePath: string | null;
    noteName: string | null;
    matchType: MatchType;
  }> {
    return this.rejectList.map((r) => ({
      span: r.span,
      targetPath: r.targetPath,
      targetName: r.targetPath.split("/").pop()?.replace(/\.md$/, "") ?? r.targetPath,
      notePath: r.notePath,
      noteName: r.notePath
        ? (r.notePath.split("/").pop()?.replace(/\.md$/, "") ?? r.notePath)
        : null,
      matchType: r.matchType ?? "literal",
    }));
  }

  removeFromRejectList(span: string, targetPath: string, notePath: string | null) {
    this.rejectList = this.rejectList.filter(
      (r) => !(r.span === span && r.targetPath === targetPath && r.notePath === notePath)
    );
  }

  /** Restore (remove) every rejection of a scope: "vault" = vault-bound (notePath
   *  null), "note" = note-bound (notePath set). Returns how many were removed. */
  restoreAllRejects(scope: "vault" | "note"): number {
    const before = this.rejectList.length;
    this.rejectList = this.rejectList.filter(
      (r) => (scope === "vault" ? r.notePath !== null : r.notePath === null)
    );
    return before - this.rejectList.length;
  }

  /** Forget all learned acceptance history (the Learned-preference signal).
   *  Does not touch learned aliases or the reject list. Returns count cleared. */
  forgetLearnedPreferences(): number {
    const n = this.acceptCounts.size;
    this.acceptCounts.clear();
    return n;
  }
}

// ---------------------------------------------------------------------------
// Reject staging panel — accumulates X-clicks, grouped by origin note
// ---------------------------------------------------------------------------

export class RejectStagingPanel {
  private el: HTMLElement | null = null;
  private items: StagedReject[]  = [];
  private minimized = false;

  constructor(
    private app: App,
    private linker: AutoLinker,
    private persistFn: () => void,
    private rescanActive: () => void
  ) {}

  add(item: StagedReject) {
    if (this.items.some((i) => i.span === item.span && i.targetPath === item.targetPath && i.notePath === item.notePath)) return;
    this.items.push(item);
    this.mount();
    this.render();
  }

  private mount() {
    if (this.el) return;
    this.el = activeDocument.body.createEl("div", { cls: "auto-linker-reject-panel" });
    window.requestAnimationFrame(() => this.el?.addClass("auto-linker-reject-panel--visible"));
  }

  private render() {
    if (!this.el) return;
    this.el.empty();

    // Header bar with title + minimize toggle
    const header = this.el.createEl("div", { cls: "auto-linker-reject-panel-headerbar" });
    header.createEl("span", {
      cls:  "auto-linker-reject-panel-title",
      text: `Reject across entire vault? (${this.items.length})`,
    });
    const minBtn = header.createEl("button", {
      cls:  "auto-linker-reject-min",
      text: this.minimized ? "+" : "−",
      attr: { "aria-label": this.minimized ? "Expand" : "Minimize" },
    });
    minBtn.addEventListener("click", () => { this.minimized = !this.minimized; this.render(); });

    if (this.minimized) return;

    // Group rows by origin note
    const body = this.el.createEl("div", { cls: "auto-linker-reject-panel-body" });
    const groups = new Map<string, StagedReject[]>();
    for (const item of this.items) {
      const arr = groups.get(item.notePath) ?? [];
      arr.push(item);
      groups.set(item.notePath, arr);
    }

    for (const [, groupItems] of groups) {
      body.createEl("div", {
        cls:  "auto-linker-reject-group-label",
        text: groupItems[0].noteName,
      });

      for (const item of groupItems) {
        const row = body.createEl("div", { cls: "auto-linker-reject-panel-row" });
        const label = row.createEl("span", {
          cls:  "auto-linker-reject-panel-label",
          text: `"${item.span}" → ${item.targetName}`,
          attr: { title: "Click to expand" },
        });
        // Truncated to one line with an ellipsis; click toggles full multi-line text.
        label.addEventListener("click", () => label.toggleClass("auto-linker-reject-panel-label--expanded", !label.hasClass("auto-linker-reject-panel-label--expanded")));

        const yes     = row.createEl("button", { cls: "auto-linker-reject-btn auto-linker-reject-yes",     text: "Yes" });
        const no      = row.createEl("button", { cls: "auto-linker-reject-btn auto-linker-reject-no",      text: "No"  });
        const restore = row.createEl("button", { cls: "auto-linker-reject-btn auto-linker-reject-restore", text: "↺", attr: { "aria-label": "Restore suggestion" } });

        yes.addEventListener("click",     () => this.confirmItem(item));
        no.addEventListener("click",      () => this.dismissItem(item));
        restore.addEventListener("click", () => this.restoreItem(item));
      }
    }

    const footer = this.el.createEl("div", { cls: "auto-linker-reject-panel-footer" });
    footer.createEl("button", { cls: "auto-linker-reject-btn auto-linker-reject-no-all",  text: "No to All"  })
      .addEventListener("click", () => this.dismissAll());
    footer.createEl("button", { cls: "auto-linker-reject-btn auto-linker-reject-yes-all", text: "Yes to All" })
      .addEventListener("click", () => this.confirmAll());
  }

  private drop(item: StagedReject) {
    this.items = this.items.filter((i) => i !== item);
    if (this.items.length === 0) this.hide();
    else this.render();
  }

  /** Yes → escalate this note-bound reject to vault-bound. */
  private confirmItem(item: StagedReject) {
    this.linker.vaultReject(item.span, item.targetPath, item.matchType);
    this.persistFn();
    this.drop(item);
  }

  /** No → keep it note-bound (already persisted on X); just dismiss the chip. */
  private dismissItem(item: StagedReject) {
    this.drop(item);
  }

  /** ↩ → undo the note-bound reject and bring the underline back. */
  private restoreItem(item: StagedReject) {
    this.linker.restoreNoteReject(item.span, item.targetPath, item.notePath);
    this.persistFn();
    this.rescanActive();
    this.drop(item);
  }

  private confirmAll() {
    for (const item of this.items) this.linker.vaultReject(item.span, item.targetPath, item.matchType);
    this.persistFn();
    this.items = [];
    this.hide();
  }

  private dismissAll() {
    this.items = [];
    this.hide();
  }

  private hide() {
    if (!this.el) return;
    this.el.removeClass("auto-linker-reject-panel--visible");
    const el = this.el;
    this.el  = null;
    this.minimized = false;
    window.setTimeout(() => el.remove(), 300);
  }

  destroy() { this.el?.remove(); this.el = null; this.items = []; }
}

// ---------------------------------------------------------------------------
// Markdown preview helper (version-tolerant)
// ---------------------------------------------------------------------------

async function renderPreview(
  app: App,
  targetPath: string,
  el: HTMLElement,
  component: Component
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(targetPath);
  if (!(file instanceof TFile)) { el.setText("(note not found)"); return; }

  const content = await app.vault.cachedRead(file);
  const excerpt = content.split("\n").slice(0, 5).join("\n").trim() || "(empty note)";

  el.empty();
  await MarkdownRenderer.render(app, excerpt, el, targetPath, component);
}

/** The CodeMirror 6 EditorView behind the active editor (Obsidian doesn't expose
 *  `cm` on its public Editor type, so we read it through a narrow structural type). */
export function activeEditorView(app: App): EditorView | undefined {
  return (app.workspace.activeEditor?.editor as { cm?: EditorView } | undefined)?.cm;
}

// ---------------------------------------------------------------------------
// Build editor extensions
// ---------------------------------------------------------------------------

export function buildAutoLinkerExtensions(
  app: App,
  linker: AutoLinker,
  stagingPanel: RejectStagingPanel,
  persistFn: () => void,
  component: Component,
  getSensitivity: () => number = () => SCORING.threshold
) {
  const decoField = createDecoField();
  const callbacks: WidgetCallbacks = {
    onApprove: (meta: DecorationMeta, mods: ApproveMods) => {
      const view = activeEditorView(app);
      if (!view) return;
      const data = meta.data as { span: string; targetName: string; targetPath: string };
      const target = data.targetPath.replace(/\.md$/, "");
      // Ctrl/Cmd → insert the bare link [[Target]] instead of [[Target|span]].
      const linkFor = (span: string) => (mods.asIs ? `[[${target}]]` : `[[${target}|${span}]]`);

      // Shift → apply to every repeat of this (span → target) in the note; else just this one.
      let metas: DecorationMeta[] = [meta];
      if (mods.all) {
        metas = view.state.field(decoField)
          .map((s) => s.meta)
          .filter((m) => {
            const d = m.data as { span?: string; targetPath?: string };
            return d?.span === data.span && d?.targetPath === data.targetPath;
          });
      }
      // Replace right-to-left so earlier offsets stay valid within one transaction.
      metas.sort((a, b) => b.from - a.from);
      view.dispatch({
        changes: metas.map((m) => ({ from: m.from, to: m.to, insert: linkFor((m.data as { span: string }).span) })),
        effects: metas.map((m) => removeDecoEffect.of({ id: m.id })),
      });

      // Learn: this (span → target) was wanted. Boosts future ranking.
      linker.recordAccept(data.span, data.targetPath);
      persistFn();
    },

    onReject: (meta: DecorationMeta) => {
      const view = activeEditorView(app);
      if (!view) return;
      const data = meta.data as { span: string; targetPath: string; targetName: string; matchType?: MatchType };
      const matchType: MatchType = data.matchType ?? "literal";
      const activeFile = app.workspace.getActiveFile();
      const notePath = activeFile?.path ?? "";

      // Note-bound reject, persisted immediately (survives reload, scoped to this note)
      linker.noteReject(data.span, data.targetPath, notePath, matchType);
      persistFn();

      // Remove all underlines for this span/target in the current note
      view.dispatch({ effects: [removeBySpanTargetEffect.of({ span: data.span, targetPath: data.targetPath })] });

      // Stage for the escalate/restore decision
      stagingPanel.add({
        span: data.span,
        targetPath: data.targetPath,
        targetName: data.targetName,
        notePath,
        noteName: activeFile?.basename ?? "Unknown",
        matchType,
      });
    },

    onPreview: (targetPath: string, el: HTMLElement) => renderPreview(app, targetPath, el, component),

    onOpen: (targetPath: string) => {
      const file = app.vault.getAbstractFileByPath(targetPath);
      if (file instanceof TFile) void app.workspace.getLeaf(false).openFile(file);
    },
  };

  const tooltip     = createSuggestionTooltip(decoField, callbacks);
  const dirtyPlugin = createDebouncedViewPlugin((view: EditorView, region: DirtyRegion) => {
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) return;

    const text        = view.state.doc.sliceString(region.from, region.to);
    const suggestions = linker.scan(text, region.from, activeFile.path, getSensitivity());

    const effects: StateEffect<unknown>[] = [clearDecosEffect.of(null)];
    for (const s of suggestions) {
      effects.push(addDecoEffect.of({
        id: s.id, from: s.from, to: s.to,
        data: { span: s.span, targetName: s.targetName, targetPath: s.targetPath, matchType: s.matchType },
      }));
    }
    view.dispatch({ effects });
  }, 600);

  return [decoField, tooltip, dirtyPlugin];
}

// ---------------------------------------------------------------------------
// Full-note scan on file open
// ---------------------------------------------------------------------------

export function scanFullNote(view: EditorView, activeFile: TFile, linker: AutoLinker, sensitivity = SCORING.threshold) {
  const text        = view.state.doc.toString();
  const suggestions = linker.scan(text, 0, activeFile.path, sensitivity);

  const effects: StateEffect<unknown>[] = [clearDecosEffect.of(null)];
  for (const s of suggestions) {
    effects.push(addDecoEffect.of({
      id: s.id, from: s.from, to: s.to,
      data: { span: s.span, targetName: s.targetName, targetPath: s.targetPath },
    }));
  }
  view.dispatch({ effects });
}

// ---------------------------------------------------------------------------
// Styles for the reject staging panel + settings table
// ---------------------------------------------------------------------------

export function injectAutoLinkerStyles(doc: Document) {
  if (doc.getElementById("auto-linker-feature-styles")) return;
  const style = doc.createElement("style");
  style.id    = "auto-linker-feature-styles";
  style.textContent = `
    /* ── Reject staging panel ─────────────────────────────────────── */
    .auto-linker-reject-panel {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 360px;
      background: var(--background-primary);
      border: 1px solid var(--background-modifier-border);
      border-radius: 8px;
      padding: 10px 12px;
      z-index: 1000;
      opacity: 0;
      transform: translateX(20px);
      transition: opacity 0.2s ease, transform 0.2s ease;
      pointer-events: none;
    }
    .auto-linker-reject-panel--visible {
      opacity: 1;
      transform: translateX(0);
      pointer-events: auto;
    }
    .theme-dark  .auto-linker-reject-panel { box-shadow: 0 4px 16px rgba(0,0,0,0.5); }
    .theme-light .auto-linker-reject-panel { box-shadow: 0 4px 12px rgba(0,0,0,0.12); }

    .auto-linker-reject-panel-headerbar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .auto-linker-reject-panel-title {
      flex: 1;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-normal);
    }
    .auto-linker-reject-min {
      font-size: 20px;
      font-weight: 900;
      line-height: 1;
      padding: 0 6px;
      border: none !important;
      background: transparent !important;
      box-shadow: none !important;
      color: var(--text-normal);
      cursor: pointer;
    }
    .auto-linker-reject-min:hover {
      color: var(--text-accent);
      background: transparent !important;
      box-shadow: none !important;
    }

    .auto-linker-reject-panel-body {
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-height: 240px;
      overflow-y: auto;
      margin-bottom: 10px;
    }
    .auto-linker-reject-group-label {
      font-size: 12px;
      font-style: italic;
      color: var(--text-muted);
      margin: 6px 0 2px 0;
    }
    .auto-linker-reject-group-label:first-child { margin-top: 0; }
    .auto-linker-reject-panel-row {
      display: flex;
      align-items: center;
      gap: 5px;
    }
    .auto-linker-reject-panel-label {
      flex: 1;
      min-width: 0;
      font-size: 13px;
      color: var(--text-normal);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }
    /* Clicking the truncated label expands it to full, wrapped text. */
    .auto-linker-reject-panel-label--expanded {
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
      overflow-wrap: anywhere;
    }
    .auto-linker-reject-panel-footer {
      display: flex;
      gap: 6px;
      justify-content: flex-end;
      border-top: 1px solid var(--background-modifier-border);
      padding-top: 8px;
    }

    .auto-linker-reject-btn {
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 3px;
      border: 1px solid var(--background-modifier-border);
      background: var(--background-secondary);
      color: var(--text-normal);
      cursor: pointer;
      white-space: nowrap;
      transition: background 0.1s, color 0.1s;
    }
    .auto-linker-reject-yes:hover,
    .auto-linker-reject-yes-all:hover { background: var(--color-red);   color: #fff; }
    .auto-linker-reject-no:hover,
    .auto-linker-reject-no-all:hover  { background: var(--color-green); color: #fff; }
    .auto-linker-reject-restore:hover { background: var(--interactive-accent); color: var(--text-on-accent, #fff); }

    /* ── Settings page reject table ───────────────────────────────── */
    .auto-linker-settings-desc {
      font-size: 12px;
      color: var(--text-muted);
      margin: 0 0 8px 0;
    }
    .auto-linker-settings-empty {
      font-size: 13px;
      color: var(--text-faint);
      font-style: italic;
      margin: 4px 0 4px 12px;
    }
    /* Collapsible reject groups — custom inline disclosure triangle so the
       marker aligns with the heading text instead of protruding into the
       left gutter. */
    .auto-linker-reject-details { margin: 0; }
    .auto-linker-reject-details > summary,
    .auto-linker-reject-subdetails > summary {
      cursor: pointer;
      list-style: none;
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .auto-linker-reject-details > summary::-webkit-details-marker,
    .auto-linker-reject-subdetails > summary::-webkit-details-marker { display: none; }
    .auto-linker-reject-details > summary::before,
    .auto-linker-reject-subdetails > summary::before {
      content: "";
      flex: 0 0 auto;
      border: 5px solid transparent;
      border-left-color: var(--text-muted);
      transition: transform 0.15s ease;
    }
    .auto-linker-reject-details[open] > summary::before,
    .auto-linker-reject-subdetails[open] > summary::before { transform: rotate(90deg); }

    .auto-linker-reject-details > summary {
      padding: 10px 0;
      font-weight: var(--font-semibold, 600);
      color: var(--text-normal);
      border-top: 1px solid var(--background-modifier-border);
    }
    /* "Restore all" pinned to the right of a group's summary. */
    .auto-linker-restore-all {
      margin-left: auto;
      font-size: 12px;
      padding: 2px 10px;
      border-radius: 4px;
      cursor: pointer;
    }
    .auto-linker-reject-subdetails { margin-left: 18px; }
    .auto-linker-reject-subdetails > summary {
      padding: 8px 0;
      color: var(--text-muted);
    }
    /* Reject rows reuse Obsidian's native .setting-item look, indented under
       their group's disclosure triangle. */
    .auto-linker-reject-details  .setting-item { border-top: none; padding: 8px 0 8px 18px; }
    .auto-linker-reject-details  .auto-linker-settings-empty { padding-left: 18px; }
  `;
  doc.head.appendChild(style);
}
