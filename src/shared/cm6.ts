import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  showTooltip,
  Tooltip,
} from "@codemirror/view";
import {
  StateField,
  StateEffect,
  Transaction,
  RangeSetBuilder,
  EditorState,
} from "@codemirror/state";
import { setIcon } from "obsidian";

// ---------------------------------------------------------------------------
// Effects — dispatched to add/remove/clear decoration ranges
// ---------------------------------------------------------------------------

export interface DecorationMeta {
  id: string;
  from: number;
  to: number;
  data: unknown;
}

export const addDecoEffect    = StateEffect.define<DecorationMeta>();
export const removeDecoEffect = StateEffect.define<{ id: string }>();
export const clearDecosEffect = StateEffect.define<null>();

/** Removes all decorations whose data.span + data.targetPath match. */
export const removeBySpanTargetEffect = StateEffect.define<{ span: string; targetPath: string }>();

// ---------------------------------------------------------------------------
// Callbacks invoked by the hover tooltip
// ---------------------------------------------------------------------------

export type WidgetAction = "approve" | "reject";

export interface WidgetCallbacks {
  onApprove: (meta: DecorationMeta) => void;
  onReject:  (meta: DecorationMeta) => void;
  /** Render a markdown preview of the target note into the given element. */
  onPreview: (targetPath: string, el: HTMLElement) => Promise<void>;
  onOpen:    (targetPath: string) => void;
}

// ---------------------------------------------------------------------------
// StateField — holds the active decoration set
// ---------------------------------------------------------------------------

interface StoredDeco {
  meta: DecorationMeta;
  mark: Decoration;
}

function buildDecoSet(stored: StoredDeco[]): DecorationSet {
  if (stored.length === 0) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const sorted = [...stored].sort((a, b) =>
    a.meta.from !== b.meta.from ? a.meta.from - b.meta.from : b.meta.to - a.meta.to
  );
  let cursor = -1;
  for (const s of sorted) {
    if (s.meta.from < cursor) continue;
    builder.add(s.meta.from, s.meta.to, s.mark);
    cursor = s.meta.to;
  }
  return builder.finish();
}

export type SuggestionField = StateField<StoredDeco[]>;

export function createDecoField(): SuggestionField {
  return StateField.define<StoredDeco[]>({
    create() {
      return [];
    },

    update(stored, tr: Transaction) {
      let updated: StoredDeco[] = stored.map((s) => ({
        ...s,
        meta: {
          ...s.meta,
          from: tr.changes.mapPos(s.meta.from),
          to:   tr.changes.mapPos(s.meta.to),
        },
      }));

      if (tr.docChanged) {
        const dirty = new Set<string>();
        tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => {
          for (const s of updated) {
            if (s.meta.from < toB && s.meta.to > fromB) dirty.add(s.meta.id);
          }
        });
        if (dirty.size > 0) updated = updated.filter((s) => !dirty.has(s.meta.id));
      }

      for (const effect of tr.effects) {
        if (effect.is(clearDecosEffect)) {
          updated = [];
        } else if (effect.is(removeDecoEffect)) {
          updated = updated.filter((s) => s.meta.id !== effect.value.id);
        } else if (effect.is(removeBySpanTargetEffect)) {
          const { span, targetPath } = effect.value;
          updated = updated.filter((s) => {
            const d = s.meta.data as { span?: string; targetPath?: string } | undefined;
            return !(d?.span === span && d?.targetPath === targetPath);
          });
        } else if (effect.is(addDecoEffect)) {
          const meta = effect.value;
          updated = updated.filter((s) => s.meta.id !== meta.id);
          updated.push({
            meta,
            mark: Decoration.mark({
              class: "auto-linker-suggestion",
              attributes: { "data-deco-id": meta.id },
            }),
          });
        }
      }

      return updated;
    },

    provide(field) {
      return EditorView.decorations.from(field, (stored) => buildDecoSet(stored));
    },
  });
}

// ---------------------------------------------------------------------------
// Hover tooltip — target label, eye preview, approve, reject
// ---------------------------------------------------------------------------

const setHoveredEffect = StateEffect.define<string | null>();
const HIDE_DELAY_MS    = 220;

function makeTooltipForId(
  state: EditorState,
  field: SuggestionField,
  id: string,
  callbacks: WidgetCallbacks
): readonly Tooltip[] {
  const stored = state.field(field, false);
  if (!stored) return [];
  const hit = stored.find((s) => s.meta.id === id);
  if (!hit) return [];

  return [
    {
      pos:   hit.meta.from,
      above: true,
      arrow: false,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "auto-linker-tooltip";

        const data       = hit.meta.data as { targetName?: string; targetPath?: string } | undefined;
        const targetName = data?.targetName ?? "link";
        const targetPath = data?.targetPath ?? "";

        const row = dom.createEl("div", { cls: "auto-linker-tooltip-row" });
        row.createEl("span", { cls: "auto-linker-target-label", text: `→ ${targetName}` });

        const eye     = row.createEl("button", { cls: "auto-linker-btn auto-linker-btn-eye",     attr: { "aria-label": "Preview note" } });
        const approve = row.createEl("button", { cls: "auto-linker-btn auto-linker-btn-approve", text: "✓" });
        const reject  = row.createEl("button", { cls: "auto-linker-btn auto-linker-btn-reject",  text: "✗" });

        // Outline (Lucide) eye icon — not an emoji
        setIcon(eye, "eye");

        const preview = dom.createEl("div", { cls: "auto-linker-preview" });

        const noFocus = (e: MouseEvent) => e.preventDefault();
        eye.addEventListener("mousedown",     noFocus);
        approve.addEventListener("mousedown", noFocus);
        reject.addEventListener("mousedown",  noFocus);

        // Eye hover: expand preview pane and render the note markdown once
        let previewLoaded = false;
        eye.addEventListener("mouseenter", async () => {
          preview.style.display = "block";
          if (!previewLoaded) {
            previewLoaded = true;
            preview.setText("Loading…");
            try {
              preview.empty();
              await callbacks.onPreview(targetPath, preview);
            } catch {
              preview.setText("(could not load preview)");
            }
          }
        });
        // Eye click: open the note
        eye.addEventListener("click", () => callbacks.onOpen(targetPath));

        approve.addEventListener("click", () => callbacks.onApprove(hit.meta));
        reject.addEventListener("click",  () => callbacks.onReject(hit.meta));

        return { dom };
      },
    },
  ];
}

export function createSuggestionTooltip(field: SuggestionField, callbacks: WidgetCallbacks) {
  const hoveredField = StateField.define<string | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) {
        if (e.is(setHoveredEffect)) value = e.value;
      }
      return value;
    },
    provide: (f) =>
      showTooltip.computeN([f, field], (state) => {
        const id = state.field(f);
        return id ? makeTooltipForId(state, field, id, callbacks) : [];
      }),
  });

  const hoverPlugin = ViewPlugin.fromClass(
    class {
      private hideTimer: ReturnType<typeof setTimeout> | null = null;
      private readonly onMove: (e: MouseEvent) => void;

      constructor(private view: EditorView) {
        this.onMove = (e: MouseEvent) => this.handleMove(e);
        view.dom.addEventListener("mousemove", this.onMove);
      }

      private cancelHide() {
        if (this.hideTimer !== null) { clearTimeout(this.hideTimer); this.hideTimer = null; }
      }

      private scheduleHide() {
        if (this.hideTimer !== null) return;
        this.hideTimer = setTimeout(() => {
          this.hideTimer = null;
          if (this.view.state.field(hoveredField, false)) {
            this.view.dispatch({ effects: setHoveredEffect.of(null) });
          }
        }, HIDE_DELAY_MS);
      }

      private handleMove(e: MouseEvent) {
        const target = e.target as HTMLElement | null;
        if (!target || !target.closest) return;

        if (target.closest(".auto-linker-tooltip")) { this.cancelHide(); return; }

        const mark    = target.closest(".auto-linker-suggestion") as HTMLElement | null;
        const id      = mark?.getAttribute("data-deco-id") ?? null;
        const current = this.view.state.field(hoveredField, false) ?? null;

        if (id && this.view.dom.contains(mark)) {
          this.cancelHide();
          if (id !== current) this.view.dispatch({ effects: setHoveredEffect.of(id) });
        } else if (current) {
          this.scheduleHide();
        }
      }

      destroy() {
        this.view.dom.removeEventListener("mousemove", this.onMove);
        this.cancelHide();
      }
    }
  );

  return [hoveredField, hoverPlugin];
}

// ---------------------------------------------------------------------------
// ViewPlugin — debounced dirty-region reporter
// ---------------------------------------------------------------------------

export interface DirtyRegion { from: number; to: number; }
export type OnDirtyRegion = (view: EditorView, region: DirtyRegion) => void;

export function createDebouncedViewPlugin(onDirty: OnDirtyRegion, debounceMs = 600) {
  return ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (this.timer !== null) clearTimeout(this.timer);

        let from = update.view.viewport.from;
        let to   = update.view.viewport.to;
        update.changes.iterChangedRanges((_fA, _tA, fB, tB) => {
          if (fB < from) from = fB;
          if (tB > to)   to   = tB;
        });

        const region: DirtyRegion = { from, to };
        const view = update.view;
        this.timer = setTimeout(() => { this.timer = null; onDirty(view, region); }, debounceMs);
      }

      destroy() { if (this.timer !== null) clearTimeout(this.timer); }
    }
  );
}

// ---------------------------------------------------------------------------
// CSS injected once
// ---------------------------------------------------------------------------

export function injectCM6Styles(doc: Document) {
  if (doc.getElementById("auto-linker-cm6-styles")) return;
  const style = doc.createElement("style");
  style.id = "auto-linker-cm6-styles";
  style.textContent = `
    .auto-linker-suggestion {
      border-bottom: 2px solid var(--color-accent);
      padding-bottom: 1px;
      cursor: pointer;
    }

    /* Reset CodeMirror's tooltip chrome — the visible box is the inner div,
       which is styled purely from Obsidian theme variables so it can never
       render with the wrong (reversed) theme or invisible text. */
    .cm-tooltip:has(.auto-linker-tooltip) {
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
    }
    .cm-tooltip:has(.auto-linker-tooltip) .cm-tooltip-arrow {
      display: none !important;
    }

    .auto-linker-tooltip {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 8px;
      background: var(--background-secondary);
      color: var(--text-normal);
      border: 1px solid var(--background-modifier-border);
      border-radius: 6px;
    }
    .theme-dark  .auto-linker-tooltip { box-shadow: 0 2px 12px rgba(0,0,0,0.45); }
    .theme-light .auto-linker-tooltip { box-shadow: 0 2px 8px  rgba(0,0,0,0.12); }

    .auto-linker-tooltip-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .auto-linker-target-label {
      font-size: 12px;
      color: var(--text-accent);
      font-style: italic;
      max-width: 200px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
    }

    .auto-linker-btn {
      font-size: 12px;
      padding: 1px 7px;
      line-height: 1.5;
      border-radius: 3px;
      border: 1px solid var(--background-modifier-border);
      background: var(--background-primary);
      color: var(--text-normal);
      cursor: pointer;
    }
    .auto-linker-btn-approve:hover { background: var(--color-green); color: #fff; }
    .auto-linker-btn-reject:hover  { background: var(--color-red);   color: #fff; }

    /* Eye: outline SVG icon from setIcon() */
    .auto-linker-btn-eye {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 2px 5px;
    }
    .auto-linker-btn-eye svg { width: 14px; height: 14px; }
    .auto-linker-btn-eye:hover { background: var(--interactive-accent); color: #fff; }

    /* Preview pane — rendered markdown, appears below the row on eye hover */
    .auto-linker-preview {
      display: none;
      max-width: 300px;
      max-height: 160px;
      overflow-y: auto;
      border-top: 1px solid var(--background-modifier-border);
      padding-top: 5px;
      margin-top: 2px;
      font-size: 12px;
      color: var(--text-normal);
      line-height: 1.5;
    }
    .auto-linker-preview p { margin: 0 0 4px 0; }
    .auto-linker-preview h1,
    .auto-linker-preview h2,
    .auto-linker-preview h3 { margin: 2px 0; font-size: 13px; }
    .auto-linker-preview ul { margin: 0; padding-left: 18px; }
  `;
  doc.head.appendChild(style);
}
