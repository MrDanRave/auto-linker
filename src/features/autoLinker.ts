import { App, TFile, Component, MarkdownRenderer } from "obsidian";
import { EditorView } from "@codemirror/view";
import { Token, tokenize, analyzeCase, detectLang, stem, commonness } from "./nlp";
import {
  addDecoEffect,
  removeDecoEffect,
  clearDecosEffect,
  removeBySpanTargetEffect,
  DecorationMeta,
  WidgetCallbacks,
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

export interface ScoredSuggestion extends Suggestion {
  confidence: number;
  matchType: "literal";
}

/** Scoring weights + default Sensitivity value.  Exported so settings can "Restore defaults". */
export const SCORING = {
  weights: { lex: 0.40, sig: 0.25, case: 0.10, graph: 0.10, sem: 0.15 },
  /** Default Sensitivity slider position (0–100). */
  threshold: 55,
};

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
}

interface PersistedState {
  rejectList: RejectEntry[];
}

interface StagedReject {
  span: string;
  targetPath: string;
  targetName: string;
  notePath: string;   // origin note (where the X was clicked)
  noteName: string;
}

const VAULT = "*"; // key token for vault-bound entries

function rejectKey(span: string, targetPath: string, notePath: string | null): string {
  return `${span}|||${targetPath}|||${notePath ?? VAULT}`;
}

// ---------------------------------------------------------------------------
// Title index
// ---------------------------------------------------------------------------

export class TitleIndex {
  private index = new Map<string, string>();           // lowerTitle|alias → targetPath
  private invertedIndex = new Map<string, Set<string>>(); // stemmedToken → Set<targetPath>
  private forwardTokens = new Map<string, Set<string>>(); // targetPath → Set<stemmedToken>
  private docFreq = new Map<string, number>();          // stemmedToken → # files containing it
  private _totalDocs = 0;

  constructor(private app: App) {}

  get totalDocs(): number { return this._totalDocs; }

  private nameToStemmed(name: string): Set<string> {
    const lang = detectLang(name);
    const stemmed = new Set<string>();
    for (const t of tokenize(name)) {
      if (t.text.length >= MIN_MATCH_LENGTH) {
        stemmed.add(stem(t.lower, lang));
      }
    }
    return stemmed;
  }

  private addToInverted(targetPath: string, names: string[]) {
    // Collect union of stemmed tokens across all names for this file.
    const allStemmed = new Set<string>();
    for (const n of names) {
      for (const s of this.nameToStemmed(n)) allStemmed.add(s);
    }
    if (allStemmed.size === 0) return;

    this.forwardTokens.set(targetPath, allStemmed);
    this._totalDocs++;

    for (const s of allStemmed) {
      let set = this.invertedIndex.get(s);
      if (!set) { set = new Set(); this.invertedIndex.set(s, set); }
      set.add(targetPath);
      this.docFreq.set(s, (this.docFreq.get(s) ?? 0) + 1);
    }
  }

  private removeFromInverted(targetPath: string) {
    const stemmedSet = this.forwardTokens.get(targetPath);
    if (!stemmedSet) return;

    this.forwardTokens.delete(targetPath);
    this._totalDocs = Math.max(0, this._totalDocs - 1);

    for (const s of stemmedSet) {
      const set = this.invertedIndex.get(s);
      if (set) {
        set.delete(targetPath);
        if (set.size === 0) this.invertedIndex.delete(s);
      }
      const df = (this.docFreq.get(s) ?? 1) - 1;
      if (df <= 0) this.docFreq.delete(s);
      else this.docFreq.set(s, df);
    }
  }

  /** Paths of titles that share at least one stemmed token with `stemmedToken`. */
  getCandidates(stemmedToken: string): Set<string> | undefined {
    return this.invertedIndex.get(stemmedToken);
  }

  /** IDF score normalized to [0,1].  Higher = rarer across all note titles. */
  normalizedIdf(stemmedToken: string): number {
    const N = this._totalDocs;
    if (N === 0) return 0;
    const df = this.docFreq.get(stemmedToken) ?? 0;
    if (df === 0) return 1.0;
    const raw    = Math.log(1 + N / df);
    const maxIdf = Math.log(1 + N);
    const minIdf = Math.log(2);
    return (raw - minIdf) / (maxIdf - minIdf + 1e-6);
  }

  build() {
    this.index.clear();
    this.invertedIndex.clear();
    this.forwardTokens.clear();
    this.docFreq.clear();
    this._totalDocs = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      this.addFile(file);
    }
  }

  addFile(file: TFile) {
    this.index.set(file.basename.toLowerCase(), file.path);
    const cache   = this.app.metadataCache.getFileCache(file);
    const aliases = cache?.frontmatter?.["aliases"];
    const names   = [file.basename];
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === "string") {
          this.index.set(alias.toLowerCase(), file.path);
          names.push(alias);
        }
      }
    }
    this.addToInverted(file.path, names);
  }

  removeFile(file: TFile) {
    for (const [key, path] of this.index) {
      if (path === file.path) this.index.delete(key);
    }
    this.removeFromInverted(file.path);
  }

  renameFile(file: TFile, oldPath: string) {
    for (const [key, path] of this.index) {
      if (path === oldPath) this.index.delete(key);
    }
    this.removeFromInverted(oldPath);
    this.addFile(file);
  }

  entries(): [string, string][] { return [...this.index.entries()]; }
  getPath(lowerTitle: string): string | undefined { return this.index.get(lowerTitle); }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

const MIN_MATCH_LENGTH   = 3;
const COVERAGE_THRESHOLD = 0.8;
const LINK_PATTERN = /\[\[([^\]]+)\]\]/g;
const TAG_PATTERN  = /#\w+/g;

export function scanRegion(
  text: string,
  regionFrom: number,
  activeFilePath: string,
  index: TitleIndex,
  rejectList: RejectEntry[]
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // All reject keys; a candidate is blocked if a vault-bound OR a matching
  // note-bound entry exists for it.
  const rejectSet = new Set(rejectList.map((r) => rejectKey(r.span, r.targetPath, r.notePath)));

  const skipRanges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  LINK_PATTERN.lastIndex = 0;
  while ((m = LINK_PATTERN.exec(text)) !== null)
    skipRanges.push([regionFrom + m.index, regionFrom + m.index + m[0].length]);
  TAG_PATTERN.lastIndex = 0;
  while ((m = TAG_PATTERN.exec(text)) !== null)
    skipRanges.push([regionFrom + m.index, regionFrom + m.index + m[0].length]);

  function isSkipped(from: number, to: number) {
    return skipRanges.some(([s, e]) => from < e && to > s);
  }

  const lowerText = text.toLowerCase();

  for (const [lowerTitle, targetPath] of index.entries()) {
    if (targetPath === activeFilePath) continue;
    if (lowerTitle.length < MIN_MATCH_LENGTH) continue;

    const L      = lowerTitle.length;
    const minLen = Math.max(MIN_MATCH_LENGTH, Math.ceil(L * COVERAGE_THRESHOLD));

    let matchedAtThisTitle = false;
    for (let prefixLen = L; prefixLen >= minLen && !matchedAtThisTitle; prefixLen--) {
      const prefix = lowerTitle.slice(0, prefixLen);
      let pos = 0;
      while ((pos = lowerText.indexOf(prefix, pos)) !== -1) {
        const from = regionFrom + pos;
        const to   = regionFrom + pos + prefixLen;

        const charBefore     = text[pos - 1];
        const charAfter      = text[pos + prefixLen];
        const boundaryBefore = !charBefore || /\W/.test(charBefore);
        const boundaryAfter  = !charAfter  || /\W/.test(charAfter);

        if (boundaryBefore && boundaryAfter && !isSkipped(from, to)) {
          const span = text.slice(pos, pos + prefixLen);
          const blockedVault = rejectSet.has(rejectKey(span, targetPath, null));
          const blockedNote  = rejectSet.has(rejectKey(span, targetPath, activeFilePath));
          if (!blockedVault && !blockedNote) {
            suggestions.push({
              id: `${targetPath}::${from}::${to}`,
              from, to, span, targetPath,
              targetName: targetPath.split("/").pop()?.replace(/\.md$/, "") ?? targetPath,
            });
            matchedAtThisTitle = true;
          }
        }
        pos += 1;
      }
    }
  }

  return suggestions;
}

// ---------------------------------------------------------------------------
// Scored region scanner (Phase 2) — replaces the binary scanRegion
// ---------------------------------------------------------------------------

export function scoreRegion(
  text: string,
  regionFrom: number,
  activeFilePath: string,
  index: TitleIndex,
  rejectList: RejectEntry[],
  sensitivity: number
): ScoredSuggestion[] {
  const threshold = computeThreshold01(sensitivity);

  // Reject set
  const rejectSet = new Set(rejectList.map((r) => rejectKey(r.span, r.targetPath, r.notePath)));

  // Skip ranges (existing [[links]], #tags)
  const skipRanges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  LINK_PATTERN.lastIndex = 0;
  while ((m = LINK_PATTERN.exec(text)) !== null)
    skipRanges.push([regionFrom + m.index, regionFrom + m.index + m[0].length]);
  TAG_PATTERN.lastIndex = 0;
  while ((m = TAG_PATTERN.exec(text)) !== null)
    skipRanges.push([regionFrom + m.index, regionFrom + m.index + m[0].length]);
  function isSkipped(from: number, to: number) {
    return skipRanges.some(([s, e]) => from < e && to > s);
  }

  // Detect region language once; use for all stems and commonness lookups
  const lang = detectLang(text);

  // Candidate lookup: tokenize the text, stem each token, union the matching paths
  const candidatePathSet = new Set<string>();
  for (const tok of tokenize(text)) {
    if (tok.text.length < MIN_MATCH_LENGTH) continue;
    const stemmed = stem(tok.lower, lang);
    const hits = index.getCandidates(stemmed);
    if (hits) for (const p of hits) candidatePathSet.add(p);
  }

  // Renormalize weights (graph=0, sem=0 in Phase 2)
  const W        = SCORING.weights;
  const activeW  = W.lex + W.sig + W.case;
  const wLex     = W.lex  / activeW;
  const wSig     = W.sig  / activeW;
  const wCase    = W.case / activeW;

  const lowerText = text.toLowerCase();
  const scored: ScoredSuggestion[] = [];

  for (const [lowerTitle, targetPath] of index.entries()) {
    if (targetPath === activeFilePath) continue;
    if (!candidatePathSet.has(targetPath)) continue;
    if (lowerTitle.length < MIN_MATCH_LENGTH) continue;

    const L      = lowerTitle.length;
    const minLen = Math.max(MIN_MATCH_LENGTH, Math.ceil(L * COVERAGE_THRESHOLD));

    let matchedAtThisTitle = false;
    for (let prefixLen = L; prefixLen >= minLen && !matchedAtThisTitle; prefixLen--) {
      const prefix = lowerTitle.slice(0, prefixLen);
      let pos = 0;
      while ((pos = lowerText.indexOf(prefix, pos)) !== -1) {
        const from = regionFrom + pos;
        const to   = regionFrom + pos + prefixLen;

        const charBefore     = text[pos - 1];
        const charAfter      = text[pos + prefixLen];
        const boundaryBefore = !charBefore || /\W/.test(charBefore);
        const boundaryAfter  = !charAfter  || /\W/.test(charAfter);

        if (boundaryBefore && boundaryAfter && !isSkipped(from, to)) {
          const span      = text.slice(pos, pos + prefixLen);
          const spanLower = span.toLowerCase();

          const blockedVault = rejectSet.has(rejectKey(span, targetPath, null));
          const blockedNote  = rejectSet.has(rejectKey(span, targetPath, activeFilePath));
          if (blockedVault || blockedNote) { pos += 1; continue; }

          // ── lex score ──────────────────────────────────────────────────
          const coverage = prefixLen / L;
          const lexScore = coverage >= 1.0
            ? 1.0
            : 0.6 + ((coverage - 0.8) / (1.0 - 0.8)) * (0.95 - 0.6);

          // ── significance ───────────────────────────────────────────────
          // Multi-word spans: take the least common (most distinctive) token
          const spanTokens = spanLower.split(/\s+/);
          const sigScore   = Math.max(
            ...spanTokens.map((t) => 0.05 + 0.85 * (1 - commonness(t, lang)))
          );

          // ── case score ([-1, 1]; negative = penalty) ───────────────────
          const spanToken: Token = { text: span, lower: spanLower, start: pos, end: pos + prefixLen };
          const caseA = analyzeCase(spanToken, text);
          let caseScore: number;
          if (caseA.type === "allcaps") {
            caseScore = 1.0;
          } else if (caseA.type === "titlecase" && !caseA.isSentenceStart) {
            caseScore = 0.8;
          } else if (caseA.type === "titlecase" && caseA.isSentenceStart) {
            caseScore = 0.0; // could just be sentence-start capital
          } else if (caseA.type === "lower") {
            // Penalty only for truly common function words (HIGH_FREQ, commonness 0.9)
            const maxCommon = Math.max(...spanTokens.map((t) => commonness(t, lang)));
            caseScore = maxCommon > 0.5 ? -1.0 : 0.0;
          } else {
            caseScore = 0.0;
          }

          const confidence = wLex * lexScore + wSig * sigScore + wCase * caseScore;

          if (confidence >= threshold) {
            scored.push({
              id: `${targetPath}::${from}::${to}`,
              from, to, span, targetPath,
              targetName: targetPath.split("/").pop()?.replace(/\.md$/, "") ?? targetPath,
              confidence,
              matchType: "literal",
            });
            matchedAtThisTitle = true;
          }
        }
        pos += 1;
      }
    }
  }

  // Dedup overlapping spans: keep highest confidence (scored is already sorted by confidence desc below)
  scored.sort((a, b) => b.confidence - a.confidence);
  const result: ScoredSuggestion[] = [];
  const usedRanges: Array<[number, number]> = [];
  for (const s of scored) {
    if (!usedRanges.some(([sf, st]) => s.from < st && s.to > sf)) {
      result.push(s);
      usedRanges.push([s.from, s.to]);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// AutoLinker
// ---------------------------------------------------------------------------

export class AutoLinker {
  readonly titleIndex: TitleIndex;
  private rejectList: RejectEntry[] = [];
  private readonly DATA_KEY = "autoLinker";

  constructor(private app: App) {
    this.titleIndex = new TitleIndex(app);
  }

  async load(loadData: () => Promise<Record<string, unknown> | null>) {
    const data  = (await loadData()) as Record<string, PersistedState> | null;
    const saved = data?.[this.DATA_KEY] as PersistedState | undefined;
    // Migrate any legacy entries (no notePath field) → treat as vault-bound.
    this.rejectList = (saved?.rejectList ?? []).map((r) => ({
      span: r.span,
      targetPath: r.targetPath,
      notePath: r.notePath ?? null,
    }));
  }

  buildWhenReady() {
    this.app.metadataCache.on("resolved", () => this.titleIndex.build());
    this.app.workspace.onLayoutReady(() => this.titleIndex.build());
  }

  async save(
    loadData: () => Promise<Record<string, unknown> | null>,
    saveData: (d: unknown) => Promise<void>
  ) {
    const existing = ((await loadData()) ?? {}) as Record<string, unknown>;
    existing[this.DATA_KEY] = { rejectList: this.rejectList } satisfies PersistedState;
    await saveData(existing);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerMetadataEvents(registerEvent: (e: any) => void) {
    registerEvent(this.app.metadataCache.on("changed", (file) => {
      // remove-then-add so renamed/removed aliases don't linger
      this.titleIndex.removeFile(file);
      this.titleIndex.addFile(file);
    }));
    registerEvent(this.app.metadataCache.on("deleted", (file) => this.titleIndex.removeFile(file)));
    registerEvent(this.app.vault.on("rename", (file, oldPath) => {
      if (file instanceof TFile) this.titleIndex.renameFile(file, oldPath);
    }));
  }

  scan(text: string, regionFrom: number, activeFilePath: string, sensitivity = SCORING.threshold): ScoredSuggestion[] {
    return scoreRegion(text, regionFrom, activeFilePath, this.titleIndex, this.rejectList, sensitivity);
  }

  // ── Reject lifecycle ──────────────────────────────────────────────────────

  private has(span: string, targetPath: string, notePath: string | null): boolean {
    return this.rejectList.some(
      (r) => r.span === span && r.targetPath === targetPath && r.notePath === notePath
    );
  }

  /** ✗ button: reject (span→target) for this note only. Persisted. */
  noteReject(span: string, targetPath: string, notePath: string) {
    if (!this.has(span, targetPath, notePath)) {
      this.rejectList.push({ span, targetPath, notePath });
    }
  }

  /** Panel "Yes": promote to vault-bound — drop any note-bound copies first. */
  vaultReject(span: string, targetPath: string) {
    this.rejectList = this.rejectList.filter(
      (r) => !(r.span === span && r.targetPath === targetPath)
    );
    this.rejectList.push({ span, targetPath, notePath: null });
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
  }> {
    return this.rejectList.map((r) => ({
      span: r.span,
      targetPath: r.targetPath,
      targetName: r.targetPath.split("/").pop()?.replace(/\.md$/, "") ?? r.targetPath,
      notePath: r.notePath,
      noteName: r.notePath
        ? (r.notePath.split("/").pop()?.replace(/\.md$/, "") ?? r.notePath)
        : null,
    }));
  }

  removeFromRejectList(span: string, targetPath: string, notePath: string | null) {
    this.rejectList = this.rejectList.filter(
      (r) => !(r.span === span && r.targetPath === targetPath && r.notePath === notePath)
    );
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
    this.el = document.body.createEl("div", { cls: "auto-linker-reject-panel" });
    requestAnimationFrame(() => this.el?.addClass("auto-linker-reject-panel--visible"));
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
        row.createEl("span", {
          cls:  "auto-linker-reject-panel-label",
          text: `"${item.span}" → ${item.targetName}`,
        });

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
    this.linker.vaultReject(item.span, item.targetPath);
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
    for (const item of this.items) this.linker.vaultReject(item.span, item.targetPath);
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
    setTimeout(() => el.remove(), 300);
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
  // MarkdownRenderer.render is the modern API; fall back to renderMarkdown.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const MR = MarkdownRenderer as any;
  if (typeof MR.render === "function") {
    await MR.render(app, excerpt, el, targetPath, component);
  } else {
    await MR.renderMarkdown(excerpt, el, targetPath, component);
  }
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
  const callbacks: WidgetCallbacks = {
    onApprove: (meta: DecorationMeta) => {
      const view = (app.workspace.activeEditor?.editor as any)?.cm as EditorView | undefined;
      if (!view) return;
      const data = meta.data as { span: string; targetName: string; targetPath: string };
      const replacement = `[[${data.targetPath.replace(/\.md$/, "")}|${data.span}]]`;
      view.dispatch({
        changes: { from: meta.from, to: meta.to, insert: replacement },
        effects: [removeDecoEffect.of({ id: meta.id })],
      });
    },

    onReject: (meta: DecorationMeta) => {
      const view = (app.workspace.activeEditor?.editor as any)?.cm as EditorView | undefined;
      if (!view) return;
      const data = meta.data as { span: string; targetPath: string; targetName: string };
      const activeFile = app.workspace.getActiveFile();
      const notePath = activeFile?.path ?? "";

      // Note-bound reject, persisted immediately (survives reload, scoped to this note)
      linker.noteReject(data.span, data.targetPath, notePath);
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
      });
    },

    onPreview: (targetPath: string, el: HTMLElement) => renderPreview(app, targetPath, el, component),

    onOpen: (targetPath: string) => {
      const file = app.vault.getAbstractFileByPath(targetPath);
      if (file instanceof TFile) app.workspace.getLeaf(false).openFile(file);
    },
  };

  const decoField   = createDecoField();
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
        data: { span: s.span, targetName: s.targetName, targetPath: s.targetPath },
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
      font-size: 13px;
      color: var(--text-normal);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
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
