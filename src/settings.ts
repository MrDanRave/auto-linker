import { App, Modal, PluginSettingTab, Setting } from "obsidian";
import type AutoLinkerPlugin from "./main";
import { BucketConfig, DEFAULT_BUCKETS } from "./features/nlp";
import { DEFAULT_MODEL } from "./features/embeddings";
import { ScoringWeights, SCORING } from "./features/autoLinker";

export interface AutoLinkerSettings {
  enableAutoLinker: boolean;
  /** 0–100; maps to confidence threshold via lerp(0.75, 0.30, t/100).
   *  0 = strictest (threshold 0.75), 100 = loosest (threshold 0.30), default 55 ≈ 0.50 */
  sensitivity: number;
  /** Per-signal weights (0–100 sliders; relative — the scorer renormalizes). */
  weights: ScoringWeights;
  /** Phase 6 semantic re-rank tier — off by default (CPU + one-time model download). */
  enableSemantic: boolean;
  /** Optional local model path for air-gapped use; "" = download/cache the default. */
  semanticModelPath: string;
  /** Per-vault tokenizer character buckets (intra / phrase / anchor). */
  tokenizer: BucketConfig;
}

/** Default weights on the 0–100 slider scale (mirrors SCORING.weights ×100). */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  lex:   Math.round(SCORING.weights.lex   * 100),
  sig:   Math.round(SCORING.weights.sig   * 100),
  case:  Math.round(SCORING.weights.case  * 100),
  graph: Math.round(SCORING.weights.graph * 100),
  sem:   Math.round(SCORING.weights.sem   * 100),
  accept:Math.round(SCORING.weights.accept* 100),
};

export const DEFAULT_SETTINGS: AutoLinkerSettings = {
  enableAutoLinker: true,
  sensitivity: 55,
  weights: { ...DEFAULT_WEIGHTS },
  enableSemantic: false,
  semanticModelPath: "",
  tokenizer: { ...DEFAULT_BUCKETS },
};

/** Soft-block shown before the first semantic-model download. */
class SemanticEnableModal extends Modal {
  constructor(app: App, private onConfirm: () => void, private onCancel: () => void) {
    super(app);
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h3", { text: "Enable semantic linking?" });
    contentEl.createEl("p", {
      text:
        "Semantic linking uses a small on-device embedding model to rank suggestions " +
        "by meaning. The model (" + DEFAULT_MODEL + ", ~50 MB) is downloaded once, then " +
        "stored locally and used fully offline — no note content ever leaves your device.",
    });
    const row = contentEl.createEl("div", { cls: "modal-button-container" });
    const cancel = row.createEl("button", { text: "Cancel" });
    const ok = row.createEl("button", { text: "Download & enable", cls: "mod-cta" });
    cancel.addEventListener("click", () => { this.onCancel(); this.close(); });
    ok.addEventListener("click", () => { this.onConfirm(); this.close(); });
  }
  onClose() { this.contentEl.empty(); }
}

interface RejectRow {
  span: string;
  targetPath: string;
  targetName: string;
  notePath: string | null;
  noteName: string | null;
}

export class AutoLinkerSettingTab extends PluginSettingTab {
  plugin: AutoLinkerPlugin;
  /** Which collapsible groups are open — preserved across re-renders. */
  private openKeys = new Set<string>();

  constructor(app: App, plugin: AutoLinkerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Feature toggle ────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Auto-linker")
      .setDesc("Suggest wiki-links for text matching note titles.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoLinker)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoLinker = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Sensitivity slider ────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Suggestion sensitivity")
      .setDesc(
        "Higher = more suggestions, including weaker matches. " +
        "Lower = only confident matches."
      )
      .addSlider((slider) =>
        slider
          .setLimits(0, 100, 1)
          .setValue(this.plugin.settings.sensitivity)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.sensitivity = value;
            await this.plugin.saveSettings();
            this.plugin.rescanActiveEditor();
          })
      );

    // ── Signal weights ────────────────────────────────────────────────────
    new Setting(containerEl).setName("Signal weights").setHeading();

    const weightSlider = (name: string, desc: string, key: keyof ScoringWeights) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addSlider((slider) =>
          slider
            .setLimits(0, 100, 1)
            .setValue(this.plugin.settings.weights[key])
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.weights[key] = value;
              await this.plugin.saveSettings();
              this.plugin.applyWeights();
            }),
        );

    weightSlider("Lexical match", "How closely the text matches a note title.", "lex");
    weightSlider("Significance", "Down-weights common words (the, and, from).", "sig");
    weightSlider("Capitalization", "Treats ALL-CAPS / Capitalized words as more link-worthy.", "case");
    weightSlider("Note importance", "Favors well-linked notes (backlinks / PageRank).", "graph");
    weightSlider("Semantic meaning", "Match by meaning — needs the semantic tier enabled.", "sem");
    weightSlider("Learned preference", "Favors links you've accepted before.", "accept");

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("Restore default weights")
        .onClick(async () => {
          this.plugin.settings.weights = { ...DEFAULT_WEIGHTS };
          this.plugin.settings.sensitivity = SCORING.threshold;
          await this.plugin.saveSettings();
          this.plugin.applyWeights();
          this.display();
        }),
    );

    // ── Tokenizer buckets ─────────────────────────────────────────────────
    new Setting(containerEl).setName("Tokenizer").setHeading();
    containerEl.createEl("p", {
      cls: "auto-linker-settings-desc",
      text:
        "How note titles split into matchable tokens. Whitespace always separates. " +
        "Intra: kept inside a token (e.g. the dot in 802.1q). Phrase: weak separators — " +
        "the whole run matches, parts only if distinctive. Anchor: strong separators — " +
        "each part independently suggests the note.",
    });

    const bucketSetting = (
      name: string,
      desc: string,
      key: keyof BucketConfig,
    ) =>
      new Setting(containerEl)
        .setName(name)
        .setDesc(desc)
        .addText((txt) =>
          txt
            .setValue(this.plugin.settings.tokenizer[key])
            .setPlaceholder(DEFAULT_BUCKETS[key])
            .onChange(async (value) => {
              this.plugin.settings.tokenizer[key] = value;
              await this.plugin.saveSettings();
              this.plugin.applyTokenizer();
            }),
        );

    bucketSetting("Intra-token characters", "Kept inside tokens (default: .)", "intra");
    bucketSetting("Phrase separators", "Weak separators (default: /-)", "phrase");
    bucketSetting("Anchor separators", "Strong separators / doublers (default: :=+;)", "anchor");

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("Restore tokenizer defaults")
        .onClick(async () => {
          this.plugin.settings.tokenizer = { ...DEFAULT_BUCKETS };
          await this.plugin.saveSettings();
          this.plugin.applyTokenizer();
          this.display();
        }),
    );

    // ── Semantic re-rank (Phase 6) ────────────────────────────────────────
    new Setting(containerEl).setName("Semantic meaning").setHeading();
    new Setting(containerEl)
      .setName("Enable semantic linking")
      .setDesc("Re-rank suggestions by meaning using a local embedding model. Off by default.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableSemantic)
          .onChange(async (value) => {
            if (value && !this.plugin.settings.enableSemantic) {
              // First enable → soft-block confirmation before any download.
              new SemanticEnableModal(
                this.app,
                async () => {
                  this.plugin.settings.enableSemantic = true;
                  await this.plugin.saveSettings();
                  await this.plugin.applySemantic();
                  this.display();
                },
                () => { toggle.setValue(false); },   // revert
              ).open();
            } else {
              this.plugin.settings.enableSemantic = value;
              await this.plugin.saveSettings();
              await this.plugin.applySemantic();
              this.display();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Local model path")
      .setDesc("Optional. Point at your own local model.")
      .addText((txt) =>
        txt
          .setValue(this.plugin.settings.semanticModelPath)
          .setPlaceholder("(download default)")
          .onChange(async (value) => {
            this.plugin.settings.semanticModelPath = value;
            await this.plugin.saveSettings();
          }),
      );

    // ── Rejected suggestions browser ─────────────────────────────────────
    const linker = this.plugin.autoLinker;
    if (!linker) return;

    new Setting(containerEl).setName("Rejected suggestions").setHeading();

    const all = linker.getRejectList();
    const vaultRejects = all.filter((r) => r.notePath === null);
    const noteRejects  = all.filter((r) => r.notePath !== null);

    // Vault Rejections — flat list under one dropdown
    const vaultDetails = this.makeDetails(containerEl, "vault", `Vault Rejections (${vaultRejects.length})`, false);
    if (vaultRejects.length === 0) {
      vaultDetails.createEl("p", { cls: "auto-linker-settings-empty", text: "None." });
    } else {
      for (const entry of vaultRejects) this.renderRow(vaultDetails, entry);
    }

    // Note Rejections — one submenu per origin note
    const groups = new Map<string, RejectRow[]>();
    for (const r of noteRejects) {
      const arr = groups.get(r.notePath as string) ?? [];
      arr.push(r);
      groups.set(r.notePath as string, arr);
    }

    const noteDetails = this.makeDetails(containerEl, "notes", `Note Rejections (${noteRejects.length})`, true);
    if (groups.size === 0) {
      noteDetails.createEl("p", { cls: "auto-linker-settings-empty", text: "None." });
    } else {
      for (const [notePath, rows] of groups) {
        const sub = this.makeDetails(noteDetails, `note:${notePath}`, `${rows[0].noteName} (${rows.length})`, false, true);
        for (const entry of rows) this.renderRow(sub, entry);
      }
    }
  }

  /**
   * Create a <details> whose open state is tracked in `openKeys`.
   * `cascade` = closing this group also collapses any nested groups.
   */
  private makeDetails(parent: HTMLElement, key: string, label: string, cascade: boolean, sub = false): HTMLElement {
    const details = parent.createEl("details", {
      cls: sub ? "auto-linker-reject-subdetails" : "auto-linker-reject-details",
    });
    details.setAttribute("data-al-key", key);
    details.open = this.openKeys.has(key);
    details.createEl("summary", { text: label });

    details.addEventListener("toggle", () => {
      if (details.open) {
        this.openKeys.add(key);
      } else {
        this.openKeys.delete(key);
        if (cascade) {
          // Closing a top-level group collapses its submenus too.
          details.querySelectorAll("details").forEach((d) => {
            d.open = false;
            const k = d.getAttribute("data-al-key");
            if (k) this.openKeys.delete(k);
          });
        }
      }
    });

    return details;
  }

  private renderRow(parent: HTMLElement, entry: RejectRow) {
    new Setting(parent)
      .setName(`"${entry.span}" → ${entry.targetName}`)
      .addButton((btn) =>
        btn
          .setButtonText("Restore")
          .setTooltip("Make this suggestion appear again")
          .onClick(async () => {
            const linker = this.plugin.autoLinker;
            if (!linker) return;
            linker.removeFromRejectList(entry.span, entry.targetPath, entry.notePath);
            await this.plugin.persistAutoLinker();
            // openKeys persists, so re-rendering keeps the open submenus open.
            this.display();
          })
      );
  }
}
