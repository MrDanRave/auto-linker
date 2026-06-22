import { App, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
  addDecoEffect,
  removeDecoEffect,
  clearDecosEffect,
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
  id: string;
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

// ---------------------------------------------------------------------------
// Title index — rebuilt incrementally from metadataCache events
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
    const cache = this.app.metadataCache.getFileCache(file);
    const aliases = cache?.frontmatter?.["aliases"];
    if (Array.isArray(aliases)) {
      for (const alias of aliases) {
        if (typeof alias === "string") {
          this.index.set(alias.toLowerCase(), file.path);
        }
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

  entries(): [string, string][] {
    return [...this.index.entries()];
  }

  getPath(lowerTitle: string): string | undefined {
    return this.index.get(lowerTitle);
  }
}

// ---------------------------------------------------------------------------
// Scanner — finds candidate spans in a text region
// ---------------------------------------------------------------------------

const MIN_MATCH_LENGTH = 3;
const COVERAGE_THRESHOLD = 0.8;
const LINK_PATTERN = /\[\[([^\]]+)\]\]/g;
const TAG_PATTERN = /#\w+/g;

export function scanRegion(
  text: string,
  regionFrom: number,
  activeFilePath: string,
  index: TitleIndex,
  rejectList: RejectEntry[]
): Suggestion[] {
  const suggestions: Suggestion[] = [];
  const rejectSet = new Set(rejectList.map((r) => `${r.span}|||${r.targetPath}`));

  const skipRanges: Array<[number, number]> = [];
  let m: RegExpExecArray | null;
  LINK_PATTERN.lastIndex = 0;
  while ((m = LINK_PATTERN.exec(text)) !== null) {
    skipRanges.push([regionFrom + m.index, regionFrom + m.index + m[0].length]);
  }
  TAG_PATTERN.lastIndex = 0;
  while ((m = TAG_PATTERN.exec(text)) !== null) {
    skipRanges.push([regionFrom + m.index, regionFrom + m.index + m[0].length]);
  }

  function isSkipped(from: number, to: number) {
    return skipRanges.some(([s, e]) => from < e && to > s);
  }

  const lowerText = text.toLowerCase();

  for (const [lowerTitle, targetPath] of index.entries()) {
    if (targetPath === activeFilePath) continue;
    if (lowerTitle.length < MIN_MATCH_LENGTH) continue;

    const L = lowerTitle.length;
    const minLen = Math.max(MIN_MATCH_LENGTH, Math.ceil(L * COVERAGE_THRESHOLD));

    let matchedAtThisTitle = false;
    for (let prefixLen = L; prefixLen >= minLen && !matchedAtThisTitle; prefixLen--) {
      const prefix = lowerTitle.slice(0, prefixLen);
      let pos = 0;
      while ((pos = lowerText.indexOf(prefix, pos)) !== -1) {
        const from = regionFrom + pos;
        const to = regionFrom + pos + prefixLen;

        const charBefore = text[pos - 1];
        const charAfter = text[pos + prefixLen];
        const boundaryBefore = !charBefore || /\W/.test(charBefore);
        const boundaryAfter = !charAfter || /\W/.test(charAfter);

        if (boundaryBefore && boundaryAfter && !isSkipped(from, to)) {
          const span = text.slice(pos, pos + prefixLen);
          const rejectKey = `${span}|||${targetPath}`;
          if (!rejectSet.has(rejectKey)) {
            suggestions.push({
              id: `${targetPath}::${from}::${to}`,
              from,
              to,
              span,
              targetPath,
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
// AutoLinker — ties everything together; one instance per plugin load
// ---------------------------------------------------------------------------

export class AutoLinker {
  readonly titleIndex: TitleIndex;
  private rejectList: RejectEntry[] = [];
  private readonly DATA_KEY = "autoLinker";

  constructor(private app: App) {
    this.titleIndex = new TitleIndex(app);
  }

  async load(loadData: () => Promise<Record<string, unknown> | null>) {
    const data = (await loadData()) as Record<string, PersistedState> | null;
    const saved = data?.[this.DATA_KEY] as PersistedState | undefined;
    this.rejectList = saved?.rejectList ?? [];
  }

  buildWhenReady() {
    this.app.metadataCache.on("resolved", () => this.titleIndex.build());
    this.app.workspace.onLayoutReady(() => this.titleIndex.build());
  }

  async save(loadData: () => Promise<Record<string, unknown> | null>, saveData: (d: unknown) => Promise<void>) {
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
    return scanRegion(text, regionFrom, activeFilePath, this.titleIndex, this.rejectList);
  }

  reject(span: string, targetPath: string) {
    const key = `${span}|||${targetPath}`;
    if (!this.rejectList.some((r) => `${r.span}|||${r.targetPath}` === key)) {
      this.rejectList.push({ span, targetPath });
    }
  }
}

// ---------------------------------------------------------------------------
// Build the editor extensions for the auto-linker feature
// ---------------------------------------------------------------------------

export function buildAutoLinkerExtensions(
  app: App,
  linker: AutoLinker,
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
      const data = meta.data as { span: string; targetPath: string };
      linker.reject(data.span, data.targetPath);
      view.dispatch({ effects: [removeDecoEffect.of({ id: meta.id })] });
      persistFn();
    },
  };

  const decoField = createDecoField();
  const tooltip = createSuggestionTooltip(decoField, callbacks);

  const dirtyPlugin = createDebouncedViewPlugin((view: EditorView, region: DirtyRegion) => {
    const activeFile = app.workspace.getActiveFile();
    if (!activeFile) return;

    const text = view.state.doc.sliceString(region.from, region.to);
    const suggestions = linker.scan(text, region.from, activeFile.path);

    const effects: StateEffect<unknown>[] = [clearDecosEffect.of(null)];
    for (const s of suggestions) {
      effects.push(
        addDecoEffect.of({
          id: s.id,
          from: s.from,
          to: s.to,
          data: { span: s.span, targetName: s.targetName, targetPath: s.targetPath },
        })
      );
    }
    view.dispatch({ effects });
  }, 600);

  return [decoField, tooltip, dirtyPlugin];
}

// ---------------------------------------------------------------------------
// Full-note scan on file open
// ---------------------------------------------------------------------------

export function scanFullNote(
  view: EditorView,
  activeFile: TFile,
  linker: AutoLinker
) {
  const text = view.state.doc.toString();
  const suggestions = linker.scan(text, 0, activeFile.path);

  const effects: StateEffect<unknown>[] = [clearDecosEffect.of(null)];
  for (const s of suggestions) {
    effects.push(
      addDecoEffect.of({
        id: s.id,
        from: s.from,
        to: s.to,
        data: { span: s.span, targetName: s.targetName, targetPath: s.targetPath },
      })
    );
  }
  view.dispatch({ effects });
}
