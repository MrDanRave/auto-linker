import { App, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
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

interface RejectEntry {
  span: string;
  targetPath: string;
}

interface PersistedState {
  rejectList: RejectEntry[];
}

interface StagedReject {
  span: string;
  targetPath: string;
  targetName: string;
}

// ---------------------------------------------------------------------------
// Title index
// ---------------------------------------------------------------------------

export class TitleIndex {
  private index = new Map<string, string>();

  constructor(private app: App) {}

  build() {
    this.index.clear();
    for (const file of this.app.vault.getMarkdownFiles()) {
      this.addFile(file);
    }
  }

  addFile(file: TFile) {
    this.index.set(file.basename.toLowerCase(), file.path);
    const cache   = this.app.metadataCache.getFileCache(file);
    const aliases = cache?.frontmatter?.["aliases"];
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === "string") this.index.set(alias.toLowerCase(), file.path);
      }
    }
  }

  removeFile(file: TFile) {
    for (const [key, path] of this.index) {
      if (path === file.path) this.index.delete(key);
    }
  }

  renameFile(file: TFile, oldPath: string) {
    for (const [key, path] of this.index) {
      if (path === oldPath) this.index.delete(key);
    }
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
  rejectList: RejectEntry[],
  sessionRejects: Set<string>
): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // Permanent and session rejects share one lookup set
  const rejectSet = new Set([
    ...rejectList.map((r) => `${r.span}|||${r.targetPath}`),
    ...sessionRejects,
  ]);

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
          const span      = text.slice(pos, pos + prefixLen);
          const rejectKey = `${span}|||${targetPath}`;
          if (!rejectSet.has(rejectKey)) {
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
// AutoLinker
// ---------------------------------------------------------------------------

export class AutoLinker {
  readonly titleIndex: TitleIndex;
  private rejectList: RejectEntry[] = [];

  // Rejects active for this session only — not persisted, cleared on plugin reload
  private sessionRejects = new Set<string>();

  private readonly DATA_KEY = "autoLinker";

  constructor(private app: App) {
    this.titleIndex = new TitleIndex(app);
  }

  async load(loadData: () => Promise<Record<string, unknown> | null>) {
    const data  = (await loadData()) as Record<string, PersistedState> | null;
    const saved = data?.[this.DATA_KEY] as PersistedState | undefined;
    this.rejectList = saved?.rejectList ?? [];
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
    registerEvent(this.app.metadataCache.on("changed", (file) => this.titleIndex.addFile(file)));
    registerEvent(this.app.metadataCache.on("deleted", (file) => this.titleIndex.removeFile(file)));
    registerEvent(this.app.vault.on("rename" as "create", (file, oldPath) => {
      if (file instanceof TFile) this.titleIndex.renameFile(file, oldPath as string);
    }));
  }

  scan(text: string, regionFrom: number, activeFilePath: string): Suggestion[] {
    return scanRegion(text, regionFrom, activeFilePath, this.titleIndex, this.rejectList, this.sessionRejects);
  }

  // ── Reject lifecycle ────────────────────────────────────────────────────

  /** X button: suppress for this session only, not yet permanent. */
  sessionReject(span: string, targetPath: string) {
    this.sessionRejects.add(`${span}|||${targetPath}`);
  }

  /** Panel "Yes": promote a session reject to the permanent list. */
  confirmReject(span: string, targetPath: string) {
    const key = `${span}|||${targetPath}`;
    if (!this.rejectList.some((r) => `${r.span}|||${r.targetPath}` === key)) {
      this.rejectList.push({ span, targetPath });
    }
  }

  /** Panel "↩": undo the session reject so the suggestion can reappear. */
  restoreReject(span: string, targetPath: string) {
    this.sessionRejects.delete(`${span}|||${targetPath}`);
  }

  // ── Settings UI accessors ───────────────────────────────────────────────

  getRejectList(): Array<{ span: string; targetPath: string; targetName: string }> {
    return this.rejectList.map((r) => ({
      ...r,
      targetName: r.targetPath.split("/").pop()?.replace(/\.md$/, "") ?? r.targetPath,
    }));
  }

  removeFromRejectList(span: string, targetPath: string) {
    this.rejectList = this.rejectList.filter(
      (r) => !(r.span === span && r.targetPath === targetPath)
    );
  }
}

// ---------------------------------------------------------------------------
// Reject staging panel
// ---------------------------------------------------------------------------

export class RejectStagingPanel {
  private el: HTMLElement | null = null;
  private items: StagedReject[]  = [];

  constructor(
    private app: App,
    private linker: AutoLinker,
    private persistFn: () => void
  ) {}

  add(item: StagedReject) {
    if (this.items.some((i) => i.span === item.span && i.targetPath === item.targetPath)) return;
    this.items.push(item);
    this.mount();
    this.render();
  }

  private getView(): EditorView | undefined {
    return this.app.workspace.activeEditor?.editor?.cm as EditorView | undefined;
  }

  private mount() {
    if (this.el) return;
    this.el = document.body.createEl("div", { cls: "auto-linker-reject-panel" });
    requestAnimationFrame(() => this.el?.addClass("auto-linker-reject-panel--visible"));
  }

  private render() {
    if (!this.el) return;
    this.el.empty();

    this.el.createEl("p", {
      cls:  "auto-linker-reject-panel-header",
      text: "Permanently reject these suggestions?",
    });

    const list = this.el.createEl("div", { cls: "auto-linker-reject-panel-list" });

    for (const item of [...this.items]) {
      const row = list.createEl("div", { cls: "auto-linker-reject-panel-row" });
      row.createEl("span", {
        cls:  "auto-linker-reject-panel-label",
        text: `"${item.span}" → ${item.targetName}`,
      });

      const yes = row.createEl("button", {
        cls: "auto-linker-reject-btn auto-linker-reject-yes", text: "Yes",
      });
      const no = row.createEl("button", {
        cls: "auto-linker-reject-btn auto-linker-reject-no", text: "No",
      });
      const restore = row.createEl("button", {
        cls:  "auto-linker-reject-btn auto-linker-reject-restore",
        text: "↩",
        attr: { "aria-label": "Restore suggestion" },
      });

      yes.addEventListener("click",     () => this.confirmItem(item));
      no.addEventListener("click",      () => this.sessionItem(item));
      restore.addEventListener("click", () => this.restoreItem(item));
    }

    const footer = this.el.createEl("div", { cls: "auto-linker-reject-panel-footer" });
    footer.createEl("button", {
      cls: "auto-linker-reject-btn auto-linker-reject-no-all", text: "No to All",
    }).addEventListener("click", () => this.sessionAll());
    footer.createEl("button", {
      cls: "auto-linker-reject-btn auto-linker-reject-yes-all", text: "Yes to All",
    }).addEventListener("click", () => this.confirmAll());
  }

  private removeItem(item: StagedReject) {
    this.items = this.items.filter((i) => i !== item);
    if (this.items.length === 0) this.hide();
    else this.render();
  }

  private confirmItem(item: StagedReject) {
    this.linker.confirmReject(item.span, item.targetPath);
    this.persistFn();
    this.removeItem(item);
  }

  private sessionItem(item: StagedReject) {
    // Already session-rejected; just dismiss from the panel
    this.removeItem(item);
  }

  private restoreItem(item: StagedReject) {
    this.linker.restoreReject(item.span, item.targetPath);
    const view = this.getView();
    if (view) {
      const activeFile = this.app.workspace.getActiveFile();
      if (activeFile) scanFullNote(view, activeFile, this.linker);
    }
    this.removeItem(item);
  }

  private confirmAll() {
    for (const item of this.items) this.linker.confirmReject(item.span, item.targetPath);
    this.persistFn();
    this.items = [];
    this.hide();
  }

  private sessionAll() {
    // All already session-rejected; close without persisting
    this.items = [];
    this.hide();
  }

  private hide() {
    if (!this.el) return;
    this.el.removeClass("auto-linker-reject-panel--visible");
    const el = this.el;
    this.el  = null;
    setTimeout(() => el.remove(), 300);
  }

  destroy() { this.el?.remove(); this.el = null; }
}

// ---------------------------------------------------------------------------
// Build editor extensions
// ---------------------------------------------------------------------------

export function buildAutoLinkerExtensions(
  app: App,
  linker: AutoLinker,
  stagingPanel: RejectStagingPanel,
  persistFn: () => void
) {
  const callbacks: WidgetCallbacks = {
    onApprove: (meta: DecorationMeta) => {
      const view = app.workspace.activeEditor?.editor?.cm as EditorView | undefined;
      if (!view) return;
      const data = meta.data as { span: string; targetName: string; targetPath: string };
      const replacement = `[[${data.targetPath.replace(/\.md$/, "")}|${data.span}]]`;
      view.dispatch({
        changes: { from: meta.from, to: meta.to, insert: replacement },
        effects: [removeDecoEffect.of({ id: meta.id })],
      });
      persistFn();
    },

    onReject: (meta: DecorationMeta) => {
      const view = app.workspace.activeEditor?.editor?.cm as EditorView | undefined;
      if (!view) return;
      const data = meta.data as { span: string; targetPath: string; targetName: string };
      // Remove all underlines for this span/target pair across the entire note
      view.dispatch({ effects: [removeBySpanTargetEffect.of({ span: data.span, targetPath: data.targetPath })] });
      // Session-reject immediately so re-scans don't re-add it
      linker.sessionReject(data.span, data.targetPath);
      // Hand to the staging panel — the user decides permanent vs session
      stagingPanel.add({ span: data.span, targetPath: data.targetPath, targetName: data.targetName });
    },

    onPreview: async (targetPath: string): Promise<string> => {
      const file = app.vault.getAbstractFileByPath(targetPath);
      if (!(file instanceof TFile)) return "";
      const content = await app.vault.cachedRead(file);
      return content.split("\n").slice(0, 8).join("\n");
    },

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
    const suggestions = linker.scan(text, region.from, activeFile.path);

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

export function scanFullNote(view: EditorView, activeFile: TFile, linker: AutoLinker) {
  const text        = view.state.doc.toString();
  const suggestions = linker.scan(text, 0, activeFile.path);

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
      padding: 12px 14px;
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

    .auto-linker-reject-panel-header {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin: 0 0 8px 0;
    }
    .auto-linker-reject-panel-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-height: 220px;
      overflow-y: auto;
      margin-bottom: 10px;
    }
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

    /* Shared button base */
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
    .auto-linker-reject-restore:hover  { background: var(--color-green); color: #fff; }
    .auto-linker-reject-no:hover,
    .auto-linker-reject-no-all:hover  { background: var(--background-modifier-hover); }

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
    }
    .auto-linker-reject-table {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 24px;
      max-height: 320px;
      overflow-y: auto;
    }
    .auto-linker-reject-table-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 8px;
      border-radius: 4px;
      background: var(--background-secondary);
    }
    .auto-linker-reject-table-row:hover { background: var(--background-modifier-hover); }
    .auto-linker-reject-table-label {
      flex: 1;
      font-size: 13px;
      color: var(--text-normal);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .auto-linker-reject-table-remove {
      font-size: 12px;
      padding: 2px 8px;
      border-radius: 3px;
      border: 1px solid var(--background-modifier-border);
      background: transparent;
      color: var(--text-muted);
      cursor: pointer;
    }
    .auto-linker-reject-table-remove:hover {
      background: var(--color-red);
      color: #fff;
      border-color: transparent;
    }
  `;
  doc.head.appendChild(style);
}
