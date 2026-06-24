# Auto-Linker — Semantic Matching Implementation Plan (v2)

**Audience:** the engineer/AI implementing this (build incrementally, one phase at a
time). Every phase is independently shippable and must keep the plugin working
**offline with no model present**. Do not start a phase until the previous one builds
and passes its acceptance checks.

**Build/verify each phase:** `node esbuild.config.mjs production` must exit 0, then
reload in Obsidian (Hot-Reload) and check the acceptance criteria by hand.

> **Revision note (v2).** Phases 1–3 are shipped (v1.2.4–1.2.6). This revision reworks
> the matcher architecture based on a long design discussion. The big changes vs v1:
> a **three-bucket tokenizer**, a **weighted bipartite (DAG) index** with **base/child**
> grouping, **IDF-weighted lexScore**, the **removal of the hard coverage gate and
> mid-word matching**, explicit **dedup policies**, and a new **acceptance-learning**
> signal. Where a v1 mechanism is superseded, it's marked **[superseded]**.

---

## 0. Orientation — current code (read before touching anything)

| File | Role |
|---|---|
| `src/features/nlp.ts` | `tokenize`, `analyzeCase`, `detectLang`, `stem` (Porter2), `commonness` (frequency list) |
| `src/features/autoLinker.ts` | `TitleIndex` (+ inverted index), `scoreRegion`, `scanRegion` **[superseded]**, `AutoLinker`, `RejectStagingPanel`, `buildAutoLinkerExtensions`, `scanFullNote`, `injectAutoLinkerStyles` |
| `src/features/graph.ts` | `GraphScorer` — PageRank over `resolvedLinks` |
| `src/shared/cm6.ts` | Decoration field, hover tooltip, **peek** window, debounced view plugin |
| `src/settings.ts` | Settings tab (`enableAutoLinker`, `sensitivity` slider + reject browser) |
| `src/main.ts` | Plugin entry, wiring, popout style injection |

**Key existing shapes:**
```
Suggestion        { id, from, to, span, targetPath, targetName }
ScoredSuggestion  Suggestion & { confidence, matchType: 'literal' }
RejectEntry       { span, targetPath, notePath: string | null }   // null = vault-wide
TitleIndex        Map<lowerTitle|alias -> path>  +  inverted Map<stemmedToken -> Set<path>>  +  IDF data
SCORING           { weights: {lex,sig,case,graph,sem}, threshold }
```

---

## 1. Design decisions (these reflect the product owner's notes — honor them)

1. **Sensitivity is a threshold, not a rule.** Low = only high-confidence matches; high
   = more, including weak ones. "AND vs and" falls out of scoring + threshold.

2. **No hard stop-word list.** Common-ness is a **graded significance score** (frequency
   list + IDF), never a ban. A word just needs more confidence from other signals.

3. **Case is a soft signal.** ALL-CAPS / TitleCase get a boost; lowercase *common* words
   get a penalty (currently **−1.5**, chosen so the penalty survives a maximal graph
   boost). Never a hard filter — `database` still matches `Database`.

4. **Real stemming (Snowball/Porter2), multilingual where rule-based stemming works.**
   Hebrew/Arabic are **not** rule-stemmable → deferred to the embedding tier (Phase 6).

5. **The hard coverage gate is gone.** `COVERAGE_THRESHOLD` (0.8) was the only
   partial-match knob in the binary era; it did two jobs that newer machinery does
   better. **lexScore** (graded) measures match quality; the **confidence threshold**
   gates whether to show. A weak partial match isn't banned — it earns a low lexScore
   and must make it up elsewhere. **[supersedes v1 §2 coverage gate]**

6. **No mid-word matching.** We have typo/fuzzy tolerance (Phase 5), so incremental
   mid-word suggestion (`kuber…`→`Kubernetes`) is **out**. Matching fires on complete
   tokens/n-grams only. This also deletes the O(titles × textlen) prefix scan.

7. **lexScore measures coverage of the title's *information*, not its characters.**
   `kruger` matching `Dunning-Kruger` is ~half the *distinctive* content and an exact
   token hit — not "6/14 chars." Use **IDF-weighted coverage** + an exact-token bonus.
   This is why a unique token can carry a low-coverage match past the threshold, and why
   common segments (`user` in a path-heavy vault) self-suppress — IDF is self-tuning per
   vault.

8. **Bi-encoder embeddings, contextual, local-only, no ANN.** Embed the **sentence**
   containing the span; brute-force cosine vs the target note vector. Re-rank only.

9. **Semantic tier is RE-RANK ONLY.** Embeddings validate/refine lexical candidates;
   we never invent anchors for text with no literal overlap (out of scope).

10. **The index is recall, not decision.** The index only *activates candidates*
    ("which notes share a token with this text"). Every actual decision — which note,
    show-or-not, one underline or two — happens in **scoring** and **dedup**.

11. **Learn from the user.** Accepting a suggestion is positive evidence; rejecting is
    negative (reject list already exists). A per-(span→target) **acceptance** signal
    personalizes ranking — distinct from PageRank (see Phase 7).

12. **Self-link skip is an intentional, pedagogical property.** A note never suggests a
    link to itself (`target === activeFile`). While writing the `Database` note you're
    only ever nudged toward the *other* concepts it's built from — pushing toward atomic,
    outward-defined notes. Those outward links then feed `resolvedLinks` → PageRank, so
    the self-link skip and the authority signal reinforce each other. Keep it.

---

## 2. The scoring model

For a candidate = (span `S` at `[from,to]` in the active note, target title `T` at
`targetPath`), compute sub-scores normalized to `[0,1]` (case may go negative), then a
weighted sum over the **available** signals:

```
confidence =  W.lex    * lexScore          // IDF-weighted coverage of T's information
            + W.sig    * significance(S)   // frequency-list + IDF; common words sink
            + W.case   * caseScore          // ALL-CAPS / TitleCase boost; lowercase-common penalty
            + W.graph  * pageRank(T)         // target authority (Phase 3, SHIPPED)
            + W.sem    * semScore(S,T)       // contextual meaning (Phase 6)
            + W.accept * acceptance(S->T)    // learned accept/reject history (Phase 7)
```

- **Default weights** (sum need not be 1; we renormalize over available signals):
  `lex 0.35, sig 0.20, case 0.10, graph 0.10, sem 0.15, accept 0.10`.
- **Availability & renormalization.** A signal is *available* when it has data; drop the
  rest and renormalize so confidence stays in `[0,1]`:
  - `graph` — available once any links exist (else ≈0 everywhere; renormalizes out).
  - `sem` — available only when the embedding tier is on and the model is present.
  - `accept` — **available only for a (span→target) pair that has history.** A brand-new
    pair renormalizes `accept` out so unseen pairs aren't penalized by a zero.
- **Suggest if `confidence >= threshold01`,** where
  `threshold01 = lerp(0.75, 0.30, sensitivity/100)` (0 = strict 0.75, 100 = loose 0.30,
  default 55 ≈ 0.50).

### Sub-score definitions
- **lexScore** — best of:
  - exact case-insensitive full-title match → `1.0`;
  - **IDF-weighted token coverage**: of the target title's tokens, the fraction of
    summed token-IDF that the span's matched tokens cover, times an **exact-token bonus**
    (a clean token equality beats a fuzzy one). A single distinctive token of a
    multi-word title therefore scores well; a single *common* token scores poorly.
  - **fuzzy** (Phase 5): edit distance `d` over length `L` → `max(0, 1 − d/L)`, capped so
    only `d ≤ 2` (or `≤ 1` for short tokens) qualifies.
- **significance(S)** — graded "is this worth linking":
  - base from the **frequency list** (`commonness`): very common → ~0.05; unknown/rare →
    ~0.9. Multi-token span → take the **least common** token.
  - reinforced by **IDF over the title corpus** (`TitleIndex.normalizedIdf`): a token
    that appears in few titles is distinctive. Frequency-list and IDF *reinforce*.
- **caseScore** — `1.0` ALL-CAPS (len≥2); `0.8` TitleCase not at sentence start; `0.0`
  TitleCase at sentence start or neutral; **`−1.5`** lowercase **and** a common word.
- **pageRank(T)** — Phase 3 (shipped): normalized PageRank over `resolvedLinks`.
- **semScore(S,T)** — Phase 6; `0` + renormalized out until then.
- **acceptance(S→T)** — Phase 7; centered so accepts > neutral, rejects < neutral;
  renormalized out for pairs with no history.

### Acceptance test cases (must hold at default sensitivity)
- Vault has `AND`, `Database`. `"x AND y"` → **suggest** `AND`; `"x and y"` → **no**.
- `"my database layer"` → **suggest** `Database` (case mismatch is fine).
- lowercase `from` with `FROM` present → **no** suggestion; `FROM`/`From` → suggest.
- `kruger` finds `Dunning-Kruger` (unique token carries a low-coverage match).
- `802.1q` (a note titled `802.1Q`) is matchable as one atom.
- `Story of Love` matches as a phrase; bare `of` does not suggest it.
- In a path-heavy vault, bare `user` does **not** suggest `user/root/mnt` (low IDF).

---

## 3. Tokenizer & index architecture (the heart of the v2 rework)

### 3a. The token flow (one assembly line, two pipelines)

The **same tokenizer** runs on titles (build) and note text (scan) — they must chew
identically or a title won't match the text that should hit it.

**Build — once per title/alias:**
```
basename "Hub1 : Dumbo"
  1. SEPARATE     split on separator chars by bucket (see 3b) -> ["Hub1", "Dumbo"]
  2. NORMALIZE    lowercase -> "hub1", "dumbo"
  3. STEM         Porter2 (en); he/ar pass through -> "hub1", "dumbo"
  4. BASE-EXTRACT "hub1" has a digit -> base "hub" + child "hub1"
                  "dumbo" has no digit/special -> root, NO father
  5. INSERT       weighted edges into the index:
                    hub   -> Hub1:Dumbo  (base edge, weight = IDF)
                    hub1  -> Hub1:Dumbo  (exact/child edge)
                    dumbo -> Hub1:Dumbo  (root edge)
```

**Scan — on the edited note (debounced):**
```
note text
  1. SEPARATE/NORMALIZE/STEM   same rules
  2. CANDIDATE GEN  single tokens + contiguous n-grams (for phrase titles)
  3. LOOKUP         each token -> activated target notes (recall only)
  4. SCORE          confidence per (span -> target)  [section 2]
  5. THRESHOLD      drop below threshold01(sensitivity)
  6. DEDUP          merge / suppress / overlap rules  [section 3e]
  7. SORT desc, emit decorations
```

### 3b. Three-bucket separators (per-vault configurable)

Every non-alphanumeric character belongs to exactly one bucket. Defaults below; the user
can reassign any char in settings (§4).

| Bucket                         | Default chars        | Behavior                                                                                                                      |
| ------------------------------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Intra-token** (kept inside)  | `.`                  | Stays part of the token. `802.1q` → one atom.                                                                                 |
| **Phrase separator**           | whitespace, `/`, `-` | Splits into parts. Parts are indexed as **weak** candidates (edges exist); the **strong** match is the contiguous n-gram run. |
| **Anchor separator** (doubler) | `:` `=` `+` `;`      | Splits into parts; **each part is a strong, independent anchor** to the whole note.                                           |

Worked outcomes (all from this one mechanism):
- `Story of Love` (whitespace=phrase) → phrase match strong; bare `of` killed by
  significance; bare `story`/`love` weak candidates.
- `dunning-kruger` (`-`=phrase) → phrase match strong; `kruger` weakly indexed but its
  high IDF carries it (see §1.7).
- `user/root/mnt` (`/`=phrase) → only the full run matches strongly; segments are weak
  and (when common) IDF-suppressed.
- `Hub1 : Dumbo` (`:`=anchor) → `Hub` *and* `Dumbo` each strongly suggest the note.
- `802.1Q` (`.`=intra) → one atomic token, indexable as-is.

> **Note on "atomic-only" titles.** Phrase separators still index their parts (weakly),
> so a *globally unique* segment can trigger its whole title (e.g. `mnt` in a vault where
> `mnt` appears once). That's arguably correct. If a future need arises for titles that
> match **only** as the complete run regardless of segment rarity, add a 4th
> "atomic phrase" behavior then — do not pre-build it.

### 3c. Base/child grouping (tree-by-descendants, built intelligently)

- A token is split into **base + child** *only if it contains a digit or special char*.
  `Hub1` → base `hub`, child `hub1`. `Dumbo` has neither → it stays a **root with no
  father**.
- **Rule = strip trailing digits/specials**, NOT a prefix-trie. A trie would relate
  `Hubble`/`Hubcap` to `hub` and over-match. Digit-strip is precise; genuine variants
  that share no digit suffix (e.g. `Hubb`) are handled via **aliases**, not the tree.
- **Disambiguation falls out of scoring**, no special logic:
  - text = exact child `hub2` → lexScore 1.0 dominates → `Hub2` wins.
  - text = ambiguous base `hub` → children tie on lex/sig/case → **PageRank** breaks the
    tie (the more-linked Hub wins).

### 3d. The index as a weighted bipartite graph (a DAG, not a tree, not a deep net)

- Structure: **tokens → notes, weighted edges**; edge weight ≈ the token's
  **diagnosticity** for that note (IDF). A flat
  `Map<stemmedToken, Array<{ path, weight }>>` is the O(1) lookup layer.
- A token in the text **activates** its target notes; activations feed scoring; a
  **threshold** fires the suggestion. This is a single-layer sparse linear classifier —
  explainable, cheap, and strictly more expressive than a tree:
  - **multi-parent is native** — `Hub1 : Dumbo` is reachable from both `hub` and `dumbo`
    (a tree can't model that; a DAG can).
  - the **base→children** relation is just a *named subset of edges*, not a separate
    structure.
- **Not a deep neural net.** An MLP needs gradient training on labeled data we don't have
  and would be unexplainable. The honest "neural" core is exactly the weighted activation
  above. If accept/reject volume ever justifies a *trained* model, fit a **logistic
  regression over these same signals** (Phase 7+), never a black box.

### 3e. Dedup policies (presentation layer — never two underlines on overlapping spans)

- **(a) Overlap** — overlapping spans → keep the **highest confidence**.
- **(b) Merge (corroboration)** — when **adjacent/proximate** spans activate the **same
  target** via different anchors, merge into **one** span covering both and **boost**
  confidence (two anchors agreeing is stronger). `"hub dumbo"` → a single suggestion for
  `Hub1 : Dumbo`, not two.
- **(c) Suppress sub-span** — a longer, higher-confidence span suppresses a shorter span
  **contained within it** that points elsewhere. `"Hubble"` → only `Hubble Telescope`,
  never `Hub`(→`Hub1`) + `Hubble`(→`Hubble Telescope`).
- General rule: **maximize confident coverage of the text; no two emitted spans overlap.**
  When competing interpretations are close, **acceptance history** (Phase 7) is the
  tiebreak.

---

## 4. Settings model

Persisted (extend the settings object; migrate missing keys to defaults):
```
enableAutoLinker:  boolean                       // existing
sensitivity:       number                          // existing, 0-100, default 55
weights:           { lex, sig, case, graph, sem, accept }   // each 0-100
tokenizer:         { intra: string, phrase: string, anchor: string }  // char sets per bucket
enableSemantic:    boolean                         // default false (Phase 6)
semanticModelPath: string                          // default "" (air-gap / custom model)
```

Settings-tab UI (`settings.ts`):
- **Sensitivity slider** (shipped).
- **One slider per signal weight** — "Lexical match", "Significance (down-weights common
  words)", "Capitalization", "Note importance (links)", "Semantic meaning", "Learned
  preference". Semantic + Learned-preference sliders are disabled/greyed when their tier
  has no data/model. Each gets an **ⓘ** info tooltip (`setIcon(el,"info")` /
  `setTooltip`) describing the signal and what its two ends mean.
- **Tokenizer customization** — three small inputs (or a chip editor) letting the user
  assign characters to **intra / phrase / anchor** buckets, seeded with the defaults.
  Changing it triggers a full index rebuild + active-note rescan.
- **"Restore defaults"** — resets weights, sensitivity, and tokenizer buckets to the
  `SCORING` / default constants.
- **enableSemantic toggle** — first enable opens the **soft-block download modal**
  (Phase 6 §6a-bis). `semanticModelPath` field for air-gap/custom models. **"Index vault
  for semantics"** button (progress, cancellable).
- Changing any control re-scans the active note.

**Internal mapping:** weights read 0–100, /100, **renormalized over available signals**
(disabled/absent/no-data signal dropped). Sensitivity → `threshold01` as in §2.

---

## PHASE 1 — NLP preprocessing pipeline ✅ SHIPPED (v1.2.4)

`src/features/nlp.ts`: `tokenize` (Intl.Segmenter w/ regex fallback), `analyzeCase`
(+ `isSentenceStart`), `stem` (full Porter2; he/ar pass-through), `detectLang` (script
ranges), `commonness` (bundled EN frequency tiers). Pure, no Obsidian deps.

> **v2 carry-forward:** the tokenizer here is **letters-first**
> (`\p{L}[\p{L}\p{N}_-]*`). Phase 4 must extend it to be bucket-driven and to accept
> digit-led / punctuation-bearing atoms (`802.1q`).

---

## PHASE 2 — Inverted index + scored candidates + Sensitivity ✅ SHIPPED (v1.2.5)

Replaced binary `scanRegion` with `scoreRegion` (confidence = lex+sig+case, graph/sem
renormalized out), added a flat inverted index to `TitleIndex`, IDF data, and the
Sensitivity slider.

> **v2 carry-forward / superseded by Phase 4:** the shipped matcher still uses the
> **hard coverage gate** and **character-coverage lexScore**, indexes **whole stemmed
> title tokens only** (no base/child, no buckets), and keeps `scanRegion` for reference.
> Phase 4 replaces all of this.

---

## PHASE 3 — Graph authority (PageRank) ✅ SHIPPED (v1.2.6)

`src/features/graph.ts`: 20-iteration PageRank (damping 0.85) over `resolvedLinks`,
normalized to `[0,1]`, immediate build on `resolved`, debounced (2s) rebuild on change,
`destroy()` clears the timer. Wired as `W.graph * pageRank(targetPath)`; renormalizes out
on an empty/linkless vault. Case penalty tightened to **−1.5** so lowercase common words
stay suppressed even at maximal graph score.

---

## PHASE 4 — Tokenizer & index rework (the v2 core) — NEXT

**Goal:** implement §3 — the three-bucket tokenizer, base/child grouping, the weighted
bipartite (DAG) index, IDF-weighted lexScore, dedup policies — and **delete the coverage
gate, mid-word prefix scan, and `scanRegion`**.

### 4a. Tokenizer (extend `nlp.ts`)
- Add a bucket-driven splitter: `tokenizeWithBuckets(text, buckets)` returning tokens
  plus, for each, whether it arose from a **phrase** or **anchor** separator (callers
  weight anchors strongly, phrase parts weakly).
- Drop letters-first restriction: accept atoms containing intra-token chars and digit-led
  atoms (`802.1q`). Keep exact `start/end` offsets.
- `extractBase(token)`: if the token contains a digit/special, return
  `{ base, child }` (strip trailing digits/specials); else `{ child }` only (no base).

### 4b. Index (rework `TitleIndex`)
- Replace `Map<stemmedToken, Set<path>>` with the **weighted edge map**
  `Map<stemmedToken, Array<{ path, weight }>>` (weight = IDF), plus a `base → children`
  view. Maintain incrementally on the existing metadata events.
- For multi-word/phrase titles, index both the **full phrase** (strong) and its
  **content tokens** (weak edges). Anchor-separated parts get strong edges.

### 4c. Scorer (rework `scoreRegion`)
- Generate candidates from the inverted graph (tokens + contiguous n-grams). **No
  prefix/coverage scan.**
- `lexScore` = **IDF-weighted token coverage** + exact-token bonus (fuzzy added in
  Phase 5). Remove `COVERAGE_THRESHOLD` and `MIN_MATCH_LENGTH`-as-gate entirely.
- Fold IDF into `significance` (combine with `commonness`).
- Apply **dedup policies §3e** (merge corroborating anchors; suppress contained sub-spans;
  overlap → highest confidence). Replace the current longest/overlap de-dup.
- Delete `scanRegion` in this commit so the diff is clean.

### 4d. Settings + wiring
- Add the **tokenizer bucket** settings (§4) with defaults; rebuild index + rescan on
  change. (Weight sliders/Restore-defaults may land here or with Phase 7's polish.)

**Acceptance:** every §2 test case passes; `kruger`→`Dunning-Kruger`, `802.1q` matches,
`Story of Love` matches as a phrase (not via bare `of`), `user`↛`user/root/mnt` in a
path-heavy vault, `"hub dumbo"`→ one merged suggestion, `Hubble`↛`Hub`+`Hubble`. No
perceptible typing lag on a few-hundred-note vault.

---

## PHASE 5 — Typo / fuzzy tolerance ✅ SHIPPED (v1.3.2)

`editDistance` (bounded Levenshtein, early-exit) in `nlp.ts`; `TitleIndex.fuzzyMatch`
prefilters by first-char bucket + length so it touches one bucket; `scoreRegion` adds
fuzzy single-token candidates with `lexScore = coverage × (1 − d/L)`. Caps: tokens
≥ `FUZZY_MIN_LEN` (4) only, `d ≤ 1` for short (≤ 5) tokens else `d ≤ 2`. Exact > base >
fuzzy by construction. The length guard keeps `hub`/`hubble`-type noise out.

**Goal (orig):** finish the `lexScore` definition with bounded fuzzy matching so small typos
still match (the reason we dropped mid-word matching).

- Add edit-distance matching for candidate tokens: `max(0, 1 − d/L)`, capped at `d ≤ 2`
  (`≤ 1` for short tokens). Generate fuzzy candidates from the index without a full scan
  (e.g. restrict to tokens sharing a stem/first-char bucket; consider a small BK-tree or
  `minisearch` fuzzy if hand-rolling is messy — must bundle cleanly).
- An exact token still outranks a fuzzy one (exact-token bonus in §2).

**Acceptance:** `databse`→`Database`, `kuberentes`→`Kubernetes`; a 3-edit difference does
**not** match; exact matches always rank above fuzzy.

---

## PHASE 6 — Local embeddings, semantic RE-RANK (was v1 Phase 4)

> **Status (v1.4.0): architecture shipped & unit-verified; model backend pending
> real-vault verification.** Built + tested (with a fake embedder): `embeddings.ts`
> (`cosine`, `toSemScore`, `SemanticIndex` note/sentence vector caches w/ mtime
> invalidation, `sentenceAround`), the `Embedder` interface, the **per-candidate weight
> renormalization** folding `sem` in only when its vectors are cached (sem=null ⇒ exact
> Phase 5 behavior; sem=1 boosts; sem=0 can demote below threshold), the async
> warm-then-rescan flow, settings (toggle + soft-block modal + `semanticModelPath`).
> `@xenova/transformers` is **bundled** (main.js ≈ 1.6 MB; the heavy ONNX/wasm runtime
> still loads at runtime, not into the JS) and initialized **lazily on enable** via
> dynamic import with graceful fallback. **Not yet verified in this sandbox** (no
> network/model/inference): the one-time model **and** ONNX-wasm download (wasm is
> fetched from a CDN on first use — carries no user data), real inference, and
> `embeddings.json` persistence (vectors are session-only for now). Needs in-Obsidian
> testing.

**Goal:** use contextual meaning to validate/re-rank the lexical candidates from Phases
4–5 (retrieve-then-rerank). Off by default; degrade gracefully when absent.

### 6a. Model & runtime
- **Dep:** `@xenova/transformers` (ONNX, local). **Model:** multilingual bi-encoder
  `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (384-dim, so Hebrew works); offer
  `Xenova/all-MiniLM-L6-v2` (EN, smaller) as an alternative constant.
- Local-only (`env.allowRemoteModels` off after the one-time fetch). Model absent &
  unfetchable → disable tier, fall back to Phases 4–5.

### 6a-bis. Model delivery (one-time download, then offline forever)
- Community/BRAT installs ship only `main.js`/`manifest.json`/`styles.css`; weights are
  tens of MB → **do not inline**. Commit the model to the repo via **Git LFS**.
- **First enable** with no local model → **soft-block modal**: explains the download
  (from the plugin repo, vendor fallback), states **on-disk size** (compute it),
  reassures local/offline/no-data-sent, **[Download & enable] / [Cancel]** (Cancel leaves
  OFF), progress + failure `Notice`. `semanticModelPath` skips the modal/download.

### 6b. Embedding cache (`src/features/embeddings.ts`)
- `embedText` (mean-pooled, L2-normalized). Note vectors from `title + first ~200 words`,
  cached `Map<path,{mtime,vec}>`, persisted to **`embeddings.json`** (NOT `data.json`).
  Recompute on `mtime` change. Lazy on open/change; full-vault only via the explicit
  "Index vault for semantics" button (progress, cancellable, yields). `cosine` brute
  force.

### 6c. semScore
- Embed the **sentence containing the span**, cosine vs target vector, `[-1,1]→[0,1]`,
  feed as `W.sem`. Cache sentence embeddings within a scan pass; only embed sentences that
  contain a lexical candidate; debounce.

**Acceptance:** with semantics ON, a candidate whose sentence is unrelated to the target
is demoted/filtered; related ones stay. OFF/missing → behavior == Phase 5. No runtime
network traffic (verify in devtools).

---

## PHASE 7 — Acceptance learning + hybrid fusion + persistence + settings polish

> **Status (v1.5.0): the learning core is shipped & unit-verified.**
> - **Learned aliases (#1):** `observeLinks` watches `metadataCache "changed"` and records
>   `[[Target|surface]]` display text whose surface isn't already derivable → injected into
>   `TitleIndex` as alias edges (so `value`→`Valuable` works with no stemmer change).
>   Persisted in `data.json` (`learnedAliases`).
> - **Acceptance signal:** `recordAccept` (on ✓) counts `(stemmed-span → target)`; folded into
>   confidence as `W.accept` only for pairs with history (renormalized out otherwise),
>   saturating via `ACCEPT_SATURATE`. Persisted (`acceptance`). Survives save/load.
> **(v1.5.1) Signal-weight controls shipped:** six 0–100 sliders (Lexical, Significance,
> Capitalization, Note importance, Semantic, Learned preference) + "Restore default
> weights". Weights persist in settings, thread through `AutoLinker.setWeights` →
> `scoreRegion` (relative, renormalized — so the slider scale and the 0–1 `SCORING`
> defaults are interchangeable), and re-scan live on change.
> **Remaining:** `matchType: 'literal' | 'semantic'` provenance + `RejectEntry` migration;
> reject-browser literal/semantic grouping; the "Index vault for semantics" button.
> Time-decay on acceptance is deferred.

**Goal:** add the **learned preference** signal, finalize fusion, thread match
provenance, and build out the full settings UI.

### 7a. Acceptance signal
- On **accept** (`onApprove`): record/increment for the `(stemmedSpan → targetPath)`
  pair. On **reject**: reuse the existing reject list as the hard-negative; optionally a
  soft negative too.
- Store a small, **time-decayed** count per pair; persist in `data.json` (tiny — keep it
  out of `embeddings.json`). `acceptance(S→T)` centered so accepts > neutral, rejects <
  neutral; **renormalized out for pairs with no history** (no penalty for new pairs).
- **Distinct from PageRank** (document this): per-(span→target) *behavioral* vs
  per-target *structural*; immediate vs slow; sees case/span nuance and rejections the
  graph can't. They couple (accept → link → PageRank), so **damp** the acceptance
  contribution (cap + decay) to avoid a runaway feedback loop.

### 7a-bis. Learned aliases (positive map, sourced from real links)
The positive mirror of the reject list, stored **plugin-local** (`data.json`), **never**
in note frontmatter — keeping link-suggestion separate from note-metadata editing.
- **Source: observe the links the user already makes.** On `metadataCache` "changed",
  inspect the file's links; when a link's display text differs from the target's
  basename/aliases (e.g. `[[valuable|value]]`), record `value → valuable.md`. Accepting an
  auto-suggestion produces the same `[[target|surface]]` shape, so manual links and
  accepted suggestions feed one store. Skip when the surface form is already derivable
  from the title/aliases (`[[Database]]` teaches nothing).
- **Effect: index-level, not just a boost.** A learned surface form is injected as a
  lookup edge to its target (exactly like a frontmatter alias), so it *creates* a
  candidate that scoring alone never could — this is what lets `value` reach `valuable`
  despite the stem mismatch (`valu` ≠ `valuabl`), with **no algorithm/stemmer change**.
- Settings: a small browser to view/remove learned aliases, mirroring the reject browser.

### 7b. Fusion + provenance
- Confirm weighted-sum fusion (or switch to **Reciprocal Rank Fusion** if tuning is hard).
- `matchType: 'literal' | 'semantic'` flows into `Suggestion` **and** `RejectEntry`
  (migrate existing entries to `'literal'` in `AutoLinker.load()`, like `notePath` was).
- Distinguish semantic-refined suggestions visually (dotted vs solid underline).

### 7c. Settings build-out (§4)
- Six weight sliders + ⓘ tooltips, Restore-defaults, tokenizer-bucket editor (if not done
  in Phase 4), `enableSemantic` + modal, `semanticModelPath`, "Index vault" button.
- Reject browser gains an optional literal/semantic sub-grouping under "Vault Rejections".

**Acceptance:** accepting then re-typing the same span ranks that target higher; an old
`data.json` (no `matchType`/no acceptance) migrates without error; literal vs semantic
rejections don't collide; weight/threshold/tokenizer changes re-scan live.

---

## Out of scope (explicitly NOT building)

- **Anchor-less semantic recall** — suggesting links for text with *no literal overlap*
  (the "anchor problem"; auto-correct-adjacent). The semantic tier is **re-rank only**.
- **ANN / vector databases** — brute-force cosine only.
- **Deep neural net for ranking** — the explainable weighted-graph + (later) logistic
  regression is the ceiling until labeled accept/reject volume justifies more.
- **Prefix/mid-word matching** — removed (Phase 4); fuzzy tolerance covers typos instead.

---

## Libraries (use proven ones; don't reinvent)

- **Stemming:** `snowball-stemmers` / `stemmer` (or the in-repo Porter2). Confirm clean
  esbuild bundle.
- **Lexical/fuzzy (optional):** `minisearch` or `orama` if hand-rolling the index/fuzzy
  gets messy. Orama also does hybrid vector+text if we consolidate later.
- **Embeddings:** `@xenova/transformers` (local ONNX; lazy-load only when semantic is on —
  it's large).
- **Do NOT add an ANN library** (owner decision).

All must work offline and bundle under the existing esbuild config.

---

## Cross-cutting rules (apply in every phase)

1. **Offline, local-only, always.** No note content ever leaves the device — index,
   scoring, embeddings, reject list, acceptance counts, and `embeddings.json` are all
   local. No telemetry. The **only** network event is the optional one-time model-weights
   download (no user data; avoidable by pre-placing the model). Every tier degrades
   gracefully when the one above is unavailable.
2. **Never block typing.** Scanning stays debounced; embeddings bounded to candidate
   sentences and cached; index rebuilds incremental.
3. **Preserve existing behavior:** Tab-indented-line skip, `[[link]]`/`#tag` skip, no
   self-link, reject-list scoping (`notePath`), the peek, the staging panel.
4. **One source of truth for tunables:** `SCORING` weights, the sensitivity mapping,
   tokenizer-bucket defaults, and thresholds live in named constants.
5. **Same tokenizer for titles and text** — build and scan must tokenize identically.
6. **The index is recall; scoring + dedup are decision.** Keep them separable.
7. **Versioning:** ask the owner how to bump before each push (patch per phase). Update
   `manifest.json`, `package.json`, `versions.json`.
