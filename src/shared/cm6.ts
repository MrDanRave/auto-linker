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
          const semantic = (meta.data as { matchType?: string } | undefined)?.matchType === "semantic";
          updated.push({
            meta,
            mark: Decoration.mark({
              class: semantic ? "auto-linker-suggestion auto-linker-suggestion--semantic" : "auto-linker-suggestion",
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
        const dom = activeDocument.createElement("div");
        dom.className = "auto-linker-tooltip";

        const data       = hit.meta.data as { targetName?: string; targetPath?: string } | undefined;
        const targetName = data?.targetName ?? "link";
        const targetPath = data?.targetPath ?? "";

        const row = dom.createEl("div", { cls: "auto-linker-tooltip-row" });
        row.createEl("span", { cls: "auto-linker-target-label", text: `→ ${targetName}` });

        // Button order: approve (✓), reject (✗), eye
        const approve = row.createEl("button", { cls: "auto-linker-btn auto-linker-btn-approve", text: "✓" });
        const reject  = row.createEl("button", { cls: "auto-linker-btn auto-linker-btn-reject",  text: "✗" });
        const eye     = row.createEl("button", { cls: "auto-linker-btn auto-linker-btn-eye" });
        setIcon(eye, "eye"); // outline (Lucide) icon, not an emoji

        const noFocus = (e: MouseEvent) => e.preventDefault();
        approve.addEventListener("mousedown", noFocus);
        reject.addEventListener("mousedown",  noFocus);
        eye.addEventListener("mousedown",     noFocus);

        approve.addEventListener("click", () => callbacks.onApprove(hit.meta));
        reject.addEventListener("click",  () => callbacks.onReject(hit.meta));

        // ── Peek: a separate floating window anchored to the eye button. Kept
        // independent of this CM tooltip so showing it never resizes or
        // repositions the tooltip (which used to shift the eye out from under
        // the cursor and flip the whole tooltip above/below at random).
        let peek: HTMLElement | null = null;
        let peekHideTimer: number | null = null;

        const removePeek = () => {
          if (peekHideTimer !== null) { window.clearTimeout(peekHideTimer); peekHideTimer = null; }
          peek?.remove();
          peek = null;
        };
        const cancelPeekHide = () => {
          if (peekHideTimer !== null) { window.clearTimeout(peekHideTimer); peekHideTimer = null; }
        };
        const schedulePeekHide = () => {
          if (peekHideTimer !== null) return;
          peekHideTimer = window.setTimeout(removePeek, 160);
        };

        const positionPeek = () => {
          if (!peek) return;
          const win = eye.ownerDocument.defaultView;
          if (!win) return;
          const r   = eye.getBoundingClientRect();
          const pw  = peek.offsetWidth;
          const ph  = peek.offsetHeight;
          const gap = 9;
          const eyeCenterX = r.left + r.width / 2;

          let left = eyeCenterX - pw / 2;
          left = Math.max(8, Math.min(left, win.innerWidth - pw - 8));

          let above = false;
          let top: number;
          if (r.bottom + gap + ph <= win.innerHeight) {
            top = r.bottom + gap;                  // default: below the eye
          } else if (r.top - gap - ph >= 0) {
            top = r.top - gap - ph; above = true;  // flip above only if needed
          } else {
            top = r.bottom + gap;                  // neither fits cleanly → below
          }

          peek.style.left = `${left}px`;
          peek.style.top  = `${top}px`;
          peek.classList.toggle("auto-linker-peek--above", above);

          // Kink points back at the eye even after horizontal clamping
          const kink = peek.querySelector<HTMLElement>(".auto-linker-peek-kink");
          if (kink) kink.style.left = `${Math.max(12, Math.min(eyeCenterX - left, pw - 12))}px`;
        };

        const showPeek = () => {
          cancelPeekHide();
          if (peek) return;
          const doc = eye.ownerDocument;
          // Insurance: never leave a stray peek behind from a prior tooltip.
          doc.body.querySelectorAll(".auto-linker-peek").forEach((e) => e.remove());
          peek = doc.body.createDiv({ cls: "auto-linker-peek" });
          peek.createDiv({ cls: "auto-linker-peek-kink" });
          const content = peek.createDiv({ cls: "auto-linker-peek-content" });
          peek.addEventListener("mouseenter", cancelPeekHide);
          peek.addEventListener("mouseleave", schedulePeekHide);

          const done = callbacks.onPreview(targetPath, content)
            .catch(() => { content.setText("(could not load preview)"); });
          window.requestAnimationFrame(positionPeek);
          void done.finally(() => positionPeek());
        };

        eye.addEventListener("mouseenter", showPeek);
        eye.addEventListener("mouseleave", schedulePeekHide);
        eye.addEventListener("click", () => { removePeek(); callbacks.onOpen(targetPath); });

        return {
          dom,
          // Tag CodeMirror's wrapper directly so the theme reset + arrow-hide
          // don't depend on the :has() selector matching.
          mount() { dom.parentElement?.classList.add("auto-linker-cm-wrap"); },
          destroy() { removePeek(); },
        };
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
      private hideTimer: number | null = null;
      private readonly onMove: (e: MouseEvent) => void;

      constructor(private view: EditorView) {
        this.onMove = (e: MouseEvent) => this.handleMove(e);
        view.dom.addEventListener("mousemove", this.onMove);
      }

      private cancelHide() {
        if (this.hideTimer !== null) { window.clearTimeout(this.hideTimer); this.hideTimer = null; }
      }

      private scheduleHide() {
        if (this.hideTimer !== null) return;
        this.hideTimer = window.setTimeout(() => {
          this.hideTimer = null;
          if (this.view.state.field(hoveredField, false)) {
            this.view.dispatch({ effects: setHoveredEffect.of(null) });
          }
        }, HIDE_DELAY_MS);
      }

      private handleMove(e: MouseEvent) {
        const target = e.target as HTMLElement | null;
        if (!target || !target.closest) return;

        if (target.closest(".auto-linker-tooltip") || target.closest(".auto-linker-peek")) { this.cancelHide(); return; }

        const mark    = target.closest<HTMLElement>(".auto-linker-suggestion");
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
      private timer: number | null = null;

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (this.timer !== null) window.clearTimeout(this.timer);

        let from = update.view.viewport.from;
        let to   = update.view.viewport.to;
        update.changes.iterChangedRanges((_fA, _tA, fB, tB) => {
          if (fB < from) from = fB;
          if (tB > to)   to   = tB;
        });

        const region: DirtyRegion = { from, to };
        const view = update.view;
        this.timer = window.setTimeout(() => { this.timer = null; onDirty(view, region); }, debounceMs);
      }

      destroy() { if (this.timer !== null) window.clearTimeout(this.timer); }
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
    /* Semantic (meaning-lifted) suggestions get a dotted underline so it's clear
       why they were suggested vs a literal text match. */
    .auto-linker-suggestion--semantic {
      border-bottom-style: dotted;
    }

    /* Reset CodeMirror's tooltip chrome (light bg + arrow). We tag the wrapper
       in mount() instead of using :has(), which was failing to match. */
    .cm-tooltip.auto-linker-cm-wrap {
      background: transparent !important;
      border: none !important;
      box-shadow: none !important;
      padding: 0 !important;
    }
    .cm-tooltip.auto-linker-cm-wrap .cm-tooltip-arrow { display: none !important; }

    /* The visible box is the inner div — colors forced so CodeMirror's own
       light tooltip theme can never win and leave invisible/reversed text. */
    .auto-linker-tooltip {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 6px 8px;
      background: var(--background-secondary) !important;
      color: var(--text-normal) !important;
      border: 1px solid var(--background-modifier-border);
      border-radius: 6px;
      box-shadow: 0 2px 12px rgba(0,0,0,0.35);
      max-width: min(340px, 90vw);
    }

    .auto-linker-tooltip-row {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .auto-linker-target-label {
      font-size: 12px;
      color: var(--text-accent);
      font-style: italic;
      max-width: 220px;
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

    /* Peek — a detached, manually-positioned speech bubble anchored to the eye */
    .auto-linker-peek {
      position: fixed;
      z-index: 1001;
      width: 280px;
      background: var(--background-secondary);
      color: var(--text-normal);
      border: 1px solid var(--background-modifier-border);
      border-radius: 6px;
      box-shadow: 0 2px 14px rgba(0,0,0,0.4);
      padding: 8px 10px;
    }
    .auto-linker-peek-content {
      max-height: 7.5em;          /* ~5 lines at 1.5 line-height */
      overflow: hidden;
      font-size: 12px;
      line-height: 1.5;
      overflow-wrap: anywhere;
      white-space: normal;
    }
    .auto-linker-peek-content > * { margin: 0 0 4px 0 !important; }
    .auto-linker-peek-content h1,
    .auto-linker-peek-content h2,
    .auto-linker-peek-content h3 { font-size: 13px; }
    .auto-linker-peek-content ul { padding-left: 18px; }
    /* read-only — strip MarkdownRenderer's copy / edit buttons */
    .auto-linker-peek-content button,
    .auto-linker-peek-content .copy-code-button,
    .auto-linker-peek-content .edit-block-button { display: none !important; }
    /* Make links inert so hovering them can't trigger Obsidian's own
       page-preview popover behind our peek. */
    .auto-linker-peek-content a,
    .auto-linker-peek-content .internal-link,
    .auto-linker-peek-content .external-link,
    .auto-linker-peek-content .tag { pointer-events: none; }

    /* Kink — points up at the eye by default (peek below), flips down when
       the peek is rendered above the eye. Its left is set inline. */
    .auto-linker-peek-kink {
      position: absolute;
      width: 0; height: 0;
      border-left: 7px solid transparent;
      border-right: 7px solid transparent;
      top: -7px;
      border-bottom: 7px solid var(--background-secondary);
    }
    .auto-linker-peek--above .auto-linker-peek-kink {
      top: auto;
      bottom: -7px;
      border-bottom: none;
      border-top: 7px solid var(--background-secondary);
    }
  `;
  doc.head.appendChild(style);
}
