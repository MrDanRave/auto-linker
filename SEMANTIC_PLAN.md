# Auto-Linker — Semantic Matching Implementation Plan

**Audience:** the engineer/AI implementing this (build incrementally, one phase at a
time). Every phase is independently shippable and must keep the plugin working
**offline with no model present**. Do not start a phase until the previous one builds
and passes its acceptance checks.

**Build/verify each phase:** `node esbuild.config.mjs production` must exit 0, then
reload in Obsidian (Hot-Reload) and check the acceptance criteria by hand.

---

## 0. Orientation — current code (read before touching anything)

| File | Role |
|---|---|
| `src/features/autoLinker.ts` | `TitleIndex`, `scanRegion` (line 112), `AutoLinker`, `RejectStagingPanel`, `buildAutoLinkerExtensions`, `scanFullNote`, `injectAutoLinkerStyles` |
| `src/shared/cm6.ts` | Decoration field, hover tooltip, **peek** window, debounced view plugin |
| `src/settings.ts` | Settings tab (`enableAutoLinker` toggle + reject-list browser) |
| `src/main.ts` | Plugin entry, wiring, popout style injection |

**Current matcher (the thing we are replacing):** `scanRegion` loops over *every*
title in `TitleIndex.entries()` and does a **binary** prefix match — a span either
matches a title (≥`COVERAGE_THRESHOLD` 0.8 of the title length, word-boundaried,
not inside a link/tag, not rejected) or it doesn't. There is **no scoring and no
ranking**. This is why short common words ("and", "from") get suggested.

**Key existing shapes:**
```
Suggestion   { id, from, to, span, targetPath, targetName }
RejectEntry  { span, targetPath, notePath: string | null }   // null = vault-wide
TitleIndex   Map<lowercased title|alias -> path>
```

**The core architectural change across all phases:** replace the binary match with a
**confidence score in [0,1]** per candidate. A single user-facing **Sensitivity**
setting becomes a **threshold** on that score. Everything else (significance, case,
graph, semantics) are *signals that feed the score*.

---

## 1. Design decisions (these reflect the product owner's notes — honor them)

1. **Sensitivity setting drives a threshold, not a hard rule.** Low sensitivity =
   suggest only high-confidence matches; high sensitivity = suggest more, including
   weaker matches. The "AND vs and" behavior falls out of scoring + threshold, NOT a
   capitalization rule forced on all notes.

2. **No hard stop-word list.** (Owner: "stop-words too black/white.") Instead use a
   **graded significance score**: common words score low, distinctive words score
   high. Common-ness comes from a bundled **word-frequency list** per language (a
   soft, graded stop-list), reinforced by the case signal and the vault reject-list
   as the final manual override. A word is never *banned*; it just needs more
   confidence from other signals to cross the threshold.

3. **Case is a soft signal, never a hard filter.** `AND` (all-caps) and `FROM` get a
   significance **boost** (likely acronyms/titles); lowercase common words get a
   **penalty**. But `database` still matches a note titled `Database` because
   "database" is rare/distinctive enough to clear the threshold without a case match.
   We never require case to match.

4. **Stemming/lemmatization is required and must go beyond plurals/-ing** — also
   `-tion`, `-ly`, prefixes `un-`/`re-`, etc. Use a real stemmer (Snowball), not a
   hand-rolled suffix chopper. **Multilingual:** Snowball covers many Latin/Cyrillic
   languages. **Hebrew** (root/שורש morphology) is NOT well served by Snowball —
   Hebrew semantic matching is deferred to the **embedding tier** (Phase 4), whose
   multilingual model handles Hebrew roots far better than rule-based stemming.
   Document this limitation; do not fake Hebrew stemming.

5. **Bi-encoder embeddings, contextual, local-only, no ANN.** Embed the **sentence
   containing the span** (context matters) and compare to the target note's
   embedding via cosine. Brute-force cosine only (vault is thousands, not millions).
   Everything runs locally; nothing leaves the machine, ever.

6. **Semantic tier is RE-RANK ONLY.** Embeddings refine/validate candidates that the
   lexical tier already found (so we always have a concrete span to underline). We do
   **not** suggest links for text with no literal overlap — that "anchor-less"
   discovery is auto-correct-adjacent and explicitly **out of scope**.

---

## 2. The scoring model (the heart — implement in Phase 2, extend later)

For a candidate = (span `S` at `[from,to]` in the active note, target title `T` at
`targetPath`), compute sub-scores each normalized to `[0,1]`, then a weighted sum:

```
confidence =  W.lex   * lexScore        // how well S matches T (string level)
            + W.sig   * significance(S) // how "link-worthy" S is at all
            + W.case  * caseScore        // capitalization / acronym signal
            + W.graph * graphScore(T)    // target authority (Phase 3)
            + W.sem   * semScore(S,T)    // contextual meaning (Phase 4)
```

- Weights are **user settings** (a slider each — see §3); the exported
  `const SCORING = {...}` object holds the **defaults** and the "Restore defaults"
  target. Default values (sum need not be 1; we normalize):
  `lex 0.40, sig 0.25, case 0.10, graph 0.10, sem 0.15`.
- **When a signal is unavailable** (e.g. embeddings off/absent → `sem`), drop its
  weight and **renormalize the remaining weights** so confidence stays in [0,1].
- **Suggest if `confidence >= threshold`.** `threshold` is derived from the
  Sensitivity setting (see §3).

### Sub-score definitions
- **lexScore** — `1.0` for exact case-insensitive full-title match; for a prefix
  covering fraction `c` of the title (`c` in `[0.8,1]`) map linearly to `[0.6,0.95]`;
  for a fuzzy match with edit distance `d` over length `L`, `max(0, 1 - d/L)` with a
  cap so only `d<=2` (or `<=1` for short tokens) qualifies. Take the best available.
- **significance(S)** — graded "is this worth linking":
  - base from word-frequency rank: very common word → ~0.05; unknown/rare → ~0.9.
    Use a bundled frequency list (see Phase 1). Multi-word spans → take the *least
    common* token (a phrase containing one rare word is significant).
  - length bonus: longer spans/phrases slightly higher.
- **caseScore** — `1.0` if `S` is ALL-CAPS (len≥2) or TitleCase **and not** merely the
  capitalized first word of a sentence; `~0.5` neutral; **penalty toward 0** if `S` is
  all-lowercase AND a common word. (This is what makes `AND`→link, `and`→no-link.)
- **graphScore(T)** — Phase 3; until then `0` with weight renormalized out.
- **semScore(S,T)** — Phase 4; until then `0` with weight renormalized out.

### Acceptance test cases (must hold from Phase 2 on, default sensitivity)
- Vault has notes `AND`, `Database`. Text `"x AND y"` → **suggest** `AND`.
- Same vault, text `"x and y"` → **do NOT suggest** `AND`.
- Text `"my database layer"` → **suggest** `Database` (case mismatch is fine).
- Text containing `from` when a note `FROM` exists → suggest only for `FROM`/`From`
  contexts, not lowercase `from`.

---

## 3. Settings model (spec) — per-signal weights + one threshold + restore defaults

The scoring weights are **user settings**, each its own slider; the `SCORING` constants
become the **defaults**. There is **no stop-word list UI** — common-word handling is
the "Significance" signal, controlled only by its weight slider.

Persisted settings (extend the settings object; migrate missing keys to defaults):
```
weights: { lex, sig, case, graph, sem }   // each 0–100, default {40,25,10,10,15}
threshold: number                          // 0–100, default 55  (the master sensitivity)
enableSemantic: boolean                    // default false (Phase 4 — embedding tier)
semanticModelPath: string                  // default "" — optional local model path (air-gap, option C)
```

Settings-tab UI (`settings.ts`):
- **One slider per signal weight** — labels: "Lexical match", "Significance
  (down-weights common words)", "Capitalization", "Note importance (links)",
  "Semantic meaning". The Semantic slider is disabled/greyed when `enableSemantic` is
  off.
- **One "Suggestion threshold" slider** (the master sensitivity). Description: "Higher
  = more suggestions, including weaker matches. Lower = only confident matches."
- **"Restore defaults" button** — resets all weights + threshold to the `SCORING`
  defaults and re-renders.
- Changing any slider re-scans the active note.

**Info hoverables:** each slider gets a small **ⓘ icon** (use `setIcon(el,"info")` or
`setIcon(el,"help-circle")`) with a hover tooltip (Obsidian renders an element's
`aria-label`/`setTooltip()` as a native tooltip — desired here). Each tooltip briefly
says *what the signal is* and *what the two ends mean*. Suggested copy:
- **Lexical match** — "Rewards spans whose text matches a note title. Low: text
  similarity barely matters. High: close textual matches dominate."
- **Significance** — "Down-weights very common words (the, and, from). Low: common
  words can still be suggested. High: only distinctive words are suggested."
- **Capitalization** — "Treats ALL-CAPS / Capitalized words as more link-worthy (e.g.
  AND vs and). Low: ignore casing. High: casing strongly affects suggestions."
- **Note importance** — "Favors notes with many backlinks. Low: ignore how connected a
  note is. High: prefer well-linked hub notes."
- **Semantic meaning** — "Uses an on-device model to match by meaning, not just words.
  Low: meaning barely matters. High: meaning strongly affects ranking. Requires the
  semantic tier to be enabled."
- **Suggestion threshold** — "The confidence a match must beat to be shown. Low: only
  very confident matches. High: more matches, including weaker ones."

**Internal mapping:**
- Weights are read 0–100, divided by 100, and **renormalized** (so they always sum to
  1 over the *available* signals; a disabled/absent signal is dropped and the rest
  renormalize — see §2).
- `threshold01 = lerp(0.75, 0.30, threshold/100)` → slider 0 = strict (0.75), 100 =
  loose (0.30), default 55 ≈ 0.50. Suggest if `confidence >= threshold01`.

`enableSemantic` stays a separate toggle because the embedding tier has CPU/model cost.
Turning it **on for the first time** (no local model yet) opens the **soft-block
confirmation modal** described in Phase 4 §4a-bis (states download source + on-disk
size; Cancel reverts the toggle to OFF).

---

## PHASE 1 — NLP preprocessing pipeline (foundations, no behavior change yet)

**Goal:** a reusable text-processing module. No scoring change yet; this is plumbing
Phase 2 will consume. Ship it behind the existing matcher (don't wire it in yet).

**New file:** `src/features/nlp.ts`. Exports pure functions (no Obsidian deps where
possible, for testability):

- `tokenize(text): Token[]` where `Token = { text, lower, start, end }`. Unicode-aware
  word splitting (use `Intl.Segmenter` with `{granularity:'word'}` if available, else
  a `\p{L}[\p{L}\p{N}_-]*` regex with the `u` flag). Must produce correct `start/end`
  offsets relative to `text`.
- `analyzeCase(token): 'allcaps' | 'titlecase' | 'lower' | 'mixed'` plus a flag
  `isSentenceStart` (true if the token is the first word after `.`/`!`/`?`/newline) so
  caseScore can ignore sentence-initial capitalization.
- `stem(word, lang): string` — wrap a Snowball stemmer. **Dependency:** add
  `snowball-stemmers` (or `stemmer` for English + `snowball` multi-lang; pick one that
  bundles cleanly under esbuild and ships English+major European languages). Expose
  the language set. For scripts with no supported stemmer (e.g. Hebrew, Arabic),
  `stem` returns the input unchanged and the caller relies on embeddings instead.
- `detectLang(text): string` — cheap heuristic (script ranges: Hebrew `֐-׿`,
  Cyrillic, Latin, etc.). Good enough to pick a stemmer; do not pull a heavy lib.
- `commonness(lowerWord, lang): number` in `[0,1]` (1 = extremely common) backed by a
  bundled frequency list. **Asset:** ship a compact top-N word list per supported
  language as a JSON/TS constant (English first; ~2–5k words is plenty). Words absent
  from the list → commonness 0 (treated as distinctive). This is the **graded soft
  stop-list** — NOT a binary filter.

**Acceptance:** unit-style manual checks via a temporary command or console — verify
tokenization offsets, that `stem("running"/"creation"/"unhappily","en")` collapse
sensibly, that `commonness("and")≈high`, `commonness("kubernetes")≈0`, and that case
analysis classifies `AND`/`And`/`and` correctly including sentence-start.

---

## PHASE 2 — Inverted index + scored candidates (Layer 0; replaces the binary matcher)

**Goal:** replace `scanRegion`'s binary loop with an indexed, **scored** generator.
This is the phase that fixes the noise problem and introduces Sensitivity.

### 2a. Inverted index (and what Aho-Corasick/trie means)
Today we loop over all titles and search the text for each — `O(titles × textlen)`.
Two proven ways to make this one cheap pass:

- **Inverted index:** precompute `Map<stemmedToken -> Set<targetPath>>` from all titles
  + aliases. To find candidates in a note, tokenize the note once, stem each token,
  and look up only those tokens. You touch only titles that share a word with the
  text — no full scan.
- **Aho-Corasick / trie (explanation for the owner):** a *trie* is a tree of shared
  prefixes — all titles starting with "data" share one branch. **Aho-Corasick** builds
  one automaton from *all* title strings at once so you can scan the note text a
  **single time** and emit every title that occurs anywhere in it, regardless of how
  many titles exist. Think "find all known terms in this sentence in one pass" instead
  of "for each known term, search the sentence." It's the standard tool for
  multi-pattern string matching.

**Decision:** build the **inverted index** (simpler, integrates with BM25/IDF and the
stemmer). Treat Aho-Corasick as an optional later optimization only if profiling shows
the index isn't enough. Build the index in `TitleIndex` (extend it) and rebuild
incrementally on the same metadata events it already handles.

### 2b. IDF / BM25 weighting
- Compute **document frequency** of each stemmed title token across the title corpus
  and (optionally) note bodies; store `idf(token) = log(1 + N/df)`. This makes a title
  made of rare words rank above one made of common words. Fold IDF into
  `significance` (combine with the frequency-list commonness; they reinforce).
- Full BM25 is optional here; the minimum viable version is IDF-weighted significance.
  If you implement BM25, prefer a small library (see §"Libraries") over hand-rolling.

### 2c. New scored generator
Add `scoreRegion(text, regionFrom, activeFilePath, ctx): ScoredSuggestion[]` (keep
`scanRegion` until parity is proven, then delete it). `ScoredSuggestion = Suggestion &
{ confidence: number, matchType: 'literal' }`. Steps:
1. Build `skipRanges` exactly as today (existing `[[links]]`, `#tags`, **plus
   Tab-indented lines** — still required; see original plan).
2. Tokenize the region (Phase 1). Generate candidate spans: single tokens **and**
   contiguous n-grams up to the longest title length (so multi-word titles match).
3. For each candidate span, look it up in the inverted index (stemmed) to get target
   titles; also keep the existing prefix/fuzzy matching for partial typing.
4. For each (span, target) compute `confidence` (§2). Drop if inside a skipRange,
   self-link, rejected (respect `notePath` scope), or `confidence < threshold`.
5. De-dup overlapping spans keeping the **highest confidence** (extend the existing
   overlap de-dup which currently keeps the longest).

### 2d. Wiring
- `AutoLinker.scan(...)` calls `scoreRegion` and passes `this.settings.sensitivity`
  (thread settings into `AutoLinker`). 
- Sort suggestions by confidence desc before dispatching decorations.
- Add the `sensitivity` slider to `settings.ts` (§3) and re-scan active note on change.

**Acceptance:** all four test cases in §2 pass; the reject-list is no longer needed to
suppress `and`/`from` noise at default sensitivity; raising the slider surfaces more
(weaker) matches; lowering it shows only strong ones. No perceptible typing lag on a
few-hundred-note vault.

---

## PHASE 3 — Graph authority signal (Layer 1; the PageRank idea, no ML)

**Goal:** rank/boost candidates by how "important" the target note is in the vault's
link graph — the Obsidian analogue of Google PageRank.

- Read the link graph from `app.metadataCache.resolvedLinks`
  (`{ sourcePath: { targetPath: count } }`). Build inbound counts per note.
- **Minimum version:** `graphScore(T) = normalize(backlinkCount(T))` (e.g.
  `count / (count + k)`, k≈3, so it saturates).
- **Better version:** run **PageRank** over the graph once (iterative,
  ~20 iterations, damping 0.85), cache scores, recompute lazily (debounced) when
  `resolvedLinks` changes. Normalize to `[0,1]`.
- Feed into the scoring model with weight `W.graph`. An obscure `AND.md` with no
  backlinks sinks; a hub note rises.

**Offline/empty:** brand-new vaults have no links → graphScore≈0 everywhere → weight
renormalizes out; matcher still works.

**Acceptance:** given two same-named link targets (or two plausible candidates), the
one with more backlinks ranks first; toggling a note's backlinks changes ordering after
the debounced recompute.

---

## PHASE 4 — Local embeddings, semantic RE-RANK (Layer 2; retrieve-then-rerank)

**Goal:** use contextual meaning to **validate/re-rank the lexical candidates** from
Phase 2 (NOT yet to discover brand-new ones — that's Phase 6). This is the safe,
bounded "retrieve-then-rerank" pattern: lexical recall is cheap; embeddings refine.

### 4a. Model & runtime
- **Dependency:** `@xenova/transformers` (Transformers.js — ONNX, runs in Electron,
  fully local). 
- **Model:** default to a **multilingual** bi-encoder so Hebrew works —
  `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim). Offer
  `Xenova/all-MiniLM-L6-v2` (English-only, smaller/faster) as an alternative constant.
- **Local-only:** configure Transformers.js to use a local model cache and **never**
  hit the network at runtime after the one-time fetch (`env.allowRemoteModels`
  controls this). If the model is absent and cannot be fetched, **disable the semantic
  tier and fall back to Phases 0–3** — the plugin must keep working.

### 4a-bis. Model delivery (one-time download from the repo, then offline forever)

Constraints to respect:
- Obsidian community-plugin + BRAT installs ship **only** `main.js`, `manifest.json`,
  `styles.css`. Extra files in the repo do **not** auto-land in users' plugin folders.
- Model weights are tens of MB → **do not inline into `main.js`** (base64 bloat +
  slow startup).

**Delivery design:**
- The chosen model is **committed to this repository** (use **Git LFS** for the binary
  — it's tens of MB). This means (1) a manual install already has the file in-folder to
  copy, and (2) the plugin has a first-party URL to fetch from.
- **On first enable** of semantic linking, if no local model is present, the plugin
  downloads it **from the plugin's own repo** (raw/release URL). If that source is
  unavailable, fall back to the **vendor** URL (Hugging Face). Save it into the
  plugin's folder and load locally forever after — no further network.
- **Soft block before any download** — when the user flips `enableSemantic` on for the
  first time, show a confirmation modal that:
  - explains semantic linking needs an embedding model that will be **downloaded from
    the plugin's repository** (or the model vendor if the repo copy is unavailable);
  - states the **on-disk size** (fill in the real figure for the chosen model — ≈ tens
    of MB; compute it, don't guess in the UI);
  - reassures it is stored **locally and used fully offline afterward; no note data is
    sent**;
  - buttons: **[Download & enable]** / **[Cancel]**. Cancel leaves semantic **OFF**.
  - show progress during the download; on failure, keep semantic OFF and surface a
    `Notice`.
- **Air-gap / custom path:** `semanticModelPath` lets a user point at a pre-placed
  model; if set and valid, skip the download (and the modal) entirely.

### 4b. Embedding cache (new file: `src/features/embeddings.ts`)
- `embedText(text): Promise<Float32Array>` — mean-pooled, L2-normalized sentence
  embedding.
- **Note vectors:** one embedding per note from `title + first ~200 words`. Cache as
  `Map<path, { mtime, vec }>`. Persist to a **separate file**
  (`embeddings.json` in the plugin dir) — do NOT bloat `data.json`. Recompute a note's
  vector when its `mtime` changes (path+mtime key, per the original plan).
- **Build strategy:** embed lazily on file-open/change; full-vault embedding only via
  an explicit **"Index vault for semantics"** button in settings (shows progress, is
  cancellable, yields between files). Never auto-embed the whole vault on load.
- `cosine(a,b): number` — brute force (no ANN).

### 4c. semScore
- For a candidate, embed the **sentence containing the span** (contextual — owner's
  request), compare to the target note vector via cosine, map `[-1,1]→[0,1]`.
- Feed as `W.sem`. Cache sentence embeddings within a scan pass (a sentence is reused
  across several candidates).
- Performance: only embed sentences that contain at least one lexical candidate, and
  debounce; never embed on every keystroke.

**Acceptance:** with semantics ON, a lexical candidate whose sentence meaning is
unrelated to the target gets demoted/filtered (e.g. a stray substring match), while
genuinely related ones stay. With semantics OFF or model missing, behavior is exactly
Phase 3. No network traffic at runtime (verify in devtools).

---

## PHASE 5 — Hybrid fusion + reject-model `matchType` + settings polish (Layer 3)

**Goal:** finalize the combined score, thread match provenance through persistence,
and surface the controls.

- Confirm the weighted-sum fusion (or switch to **Reciprocal Rank Fusion** if a
  weighted sum proves hard to tune: rank candidates by each signal, sum `1/(k+rank)`).
  Keep it behind the `SCORING` config.
- **`matchType: 'literal' | 'semantic'`** now flows into `Suggestion`, and into
  `RejectEntry` (add the field; default existing entries to `'literal'` in
  `AutoLinker.load()`'s migration, exactly like `notePath` was migrated). This is what
  makes the earlier "split rejections into literal vs semantic" idea meaningful.
- **Settings (full build-out per §3):** the five signal-weight sliders, the master
  "Suggestion threshold" slider, the **Restore defaults** button, the `enableSemantic`
  toggle (with its first-enable **soft-block download modal**, §4a-bis), the
  `semanticModelPath` field for air-gap/custom models, and the "Index vault for
  semantics" button + progress. The reject browser gains an optional literal/semantic
  sub-grouping under "Vault Rejections" (mirror the existing per-note `<details>`).
- Distinguish semantic-refined suggestions visually (e.g. a dotted vs solid underline)
  so the user knows why something was suggested.

**Acceptance:** rejecting a semantic suggestion stores it with `matchType:'semantic'`
and it's listed/removable separately; literal and semantic rejections don't collide;
migration of an old `data.json` (no `matchType`) works without error.

---

## Out of scope (explicitly NOT building)

- **Anchor-less semantic recall** — suggesting links for text with *no literal
  overlap* (e.g. "relational data store" → `[[Database]]`). This needs to invent which
  characters to underline (the "anchor problem") and is auto-correct-adjacent — a
  different product. The semantic tier (Phase 4) is **re-rank only**: it refines
  candidates the lexical tier already found.
- **ANN / vector databases** — brute-force cosine only.

---

## Libraries (use proven ones; don't reinvent)

- **Stemming:** `snowball-stemmers` / `stemmer` (English) — confirm clean esbuild bundle.
- **Lexical/BM25 (optional):** `minisearch` or `orama` if you'd rather not hand-roll
  the index/BM25. Orama also does hybrid vector+text if we want to consolidate later.
- **Embeddings:** `@xenova/transformers` (local ONNX).
- **NLP helpers (optional):** `wink-nlp` or `compromise` for tokenization/POS/keyphrase.
- **Do NOT add an ANN library** (owner decision); brute-force cosine only.

All must work offline and bundle under the existing esbuild config (`@xenova/transformers`
is large — verify load time and that it's lazy-loaded only when `enableSemantic` is on).

---

## Cross-cutting rules (apply in every phase)

1. **Offline, local-only, always — privacy guarantee.** No note content ever leaves
   the device: index, scoring, embeddings, reject list, and the `embeddings.json`
   cache are all local. No telemetry, no external API. The **only** network event in
   the whole design is the optional one-time download of the embedding **model
   weights** from the Hugging Face CDN when the user first enables the semantic tier —
   that request carries no user data, and can be avoided entirely by pre-placing /
   bundling the model for air-gapped use. The semantic tier is opt-in (default off).
   Every tier degrades gracefully when the one above is unavailable.
2. **Never block typing.** All scanning stays debounced; embeddings are bounded to
   candidate sentences and cached.
3. **Preserve existing behavior:** Tab-indented-line skip, `[[link]]`/`#tag` skip,
   no self-link, reject-list scoping (`notePath`), the peek, the staging panel.
4. **One source of truth for tunables:** the `SCORING` weights, `sensitivity` mapping,
   and thresholds live in named constants, not scattered magic numbers.
5. **Keep `scanRegion` until `scoreRegion` reaches parity**, then remove it in one
   commit so the diff is clear.
6. **Versioning:** ask the owner how to bump the version before each push (patch per
   phase is expected). Update `manifest.json`, `package.json`, `versions.json`.
