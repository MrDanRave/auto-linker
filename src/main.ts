import { Plugin, TFile, Notice } from "obsidian";
import { DEFAULT_SETTINGS, AutoLinkerSettings, AutoLinkerSettingTab } from "./settings";
import {
  AutoLinker,
  RejectStagingPanel,
  buildAutoLinkerExtensions,
  scanFullNote,
  injectAutoLinkerStyles,
  activeEditorView,
} from "./features/autoLinker";
import { injectCM6Styles } from "./shared/cm6";

export default class AutoLinkerPlugin extends Plugin {
  settings: AutoLinkerSettings = { ...DEFAULT_SETTINGS };
  autoLinker: AutoLinker | null = null;
  private stagingPanel: RejectStagingPanel | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new AutoLinkerSettingTab(this.app, this));

    injectCM6Styles(activeDocument);
    injectAutoLinkerStyles(activeDocument);

    // Popout windows have their own document — inject there too.
    this.registerEvent(
      this.app.workspace.on("window-open", (_workspaceWindow, popoutWindow) => {
        injectCM6Styles(popoutWindow.document);
        injectAutoLinkerStyles(popoutWindow.document);
      })
    );

    if (this.settings.enableAutoLinker) {
      const linker = new AutoLinker(this.app, this.settings.tokenizer);
      this.autoLinker = linker;

      await linker.load(() => this.loadData());
      linker.buildWhenReady();
      linker.registerMetadataEvents((e) => this.registerEvent(e));
      linker.setEmbeddingsPath(`${this.manifest.dir}/embeddings.json`);

      // Configure the semantic tier if the user has it enabled (lazy model load).
      if (this.settings.enableSemantic) void this.applySemantic();

      const persistFn    = () => { void linker.save(() => this.loadData(), (d) => this.saveData(d)); };
      const rescanActive = () => this.rescanActiveEditor();
      linker.setPersist(persistFn);
      linker.setRescan(rescanActive);
      linker.setWeights(this.settings.weights);

      const panel = new RejectStagingPanel(this.app, linker, persistFn, rescanActive);
      this.stagingPanel = panel;

      const extensions = buildAutoLinkerExtensions(this.app, linker, panel, persistFn, this, () => this.settings.sensitivity);
      this.registerEditorExtension(extensions);

      // Full-note scan when a file is opened
      this.registerEvent(
        this.app.workspace.on("file-open", (file) => {
          if (!file) return;
          window.setTimeout(() => this.rescanActiveEditor(), 200);
        })
      );

      // When a file is deleted, drop its rejections so a same-named note
      // created later is suggestable again.
      this.registerEvent(
        this.app.vault.on("delete", (file) => {
          if (!(file instanceof TFile)) return;
          if (linker.pruneRejectsForPath(file.path)) {
            persistFn();
            this.rescanActiveEditor();
          }
        })
      );
    }
  }

  /** Pre-compute embeddings for the whole vault (settings button). */
  async indexVaultForSemantics(onProgress?: (done: number, total: number) => void) {
    if (!this.autoLinker) return { done: 0, total: 0, ok: false };
    return this.autoLinker.indexVaultForSemantics(onProgress);
  }

  /** Re-apply signal weights from settings, then rescan. */
  applyWeights() {
    if (!this.autoLinker) return;
    this.autoLinker.setWeights(this.settings.weights);
    this.rescanActiveEditor();
  }

  /** Re-apply tokenizer buckets from settings: rebuild index + rescan. */
  applyTokenizer() {
    if (!this.autoLinker) return;
    this.autoLinker.setBuckets(this.settings.tokenizer);
    this.rescanActiveEditor();
  }

  /** Enable/disable the semantic tier from settings (loads the model lazily). */
  async applySemantic() {
    if (!this.autoLinker) return;
    const status = await this.autoLinker.configureSemantic(
      this.settings.enableSemantic,
      this.settings.semanticModelPath,
      () => this.rescanActiveEditor(),
    );
    if (this.settings.enableSemantic) {
      if (status === "ready") {
        new Notice("Auto-linker: semantic model ready.");
      } else {
        const err = this.autoLinker.semanticError();
        new Notice(`Auto-linker: semantic model ${status}.${err ? " " + err : ""} (see console)`);
      }
    }
    this.rescanActiveEditor();
  }

  rescanActiveEditor() {
    if (!this.autoLinker) return;
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const cm = activeEditorView(this.app);
    if (!cm) return;
    scanFullNote(cm, file, this.autoLinker, this.settings.sensitivity);
  }

  onunload() {
    this.stagingPanel?.destroy();
    this.autoLinker?.destroy();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<AutoLinkerSettings>);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  /** Persist the auto-linker reject list (called from settings UI after un-rejecting). */
  async persistAutoLinker(): Promise<void> {
    if (this.autoLinker) {
      await this.autoLinker.save(() => this.loadData(), (d) => this.saveData(d));
    }
  }
}
