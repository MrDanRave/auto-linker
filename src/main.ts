import { Plugin, TFile, Notice } from "obsidian";
import { DEFAULT_SETTINGS, AutoLinkerSettings, AutoLinkerSettingTab } from "./settings";
import {
  AutoLinker,
  RejectStagingPanel,
  buildAutoLinkerExtensions,
  scanFullNote,
  injectAutoLinkerStyles,
} from "./features/autoLinker";
import { injectCM6Styles } from "./shared/cm6";
import { EditorView } from "@codemirror/view";

export default class AutoLinkerPlugin extends Plugin {
  settings: AutoLinkerSettings = { ...DEFAULT_SETTINGS };
  autoLinker: AutoLinker | null = null;
  private stagingPanel: RejectStagingPanel | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new AutoLinkerSettingTab(this.app, this));

    injectCM6Styles(document);
    injectAutoLinkerStyles(document);

    // Popout windows have their own document — inject there too.
    this.registerEvent(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.app.workspace.on("window-open" as any, (...args: any[]) => {
        const doc = (args[1] as Window | undefined)?.document ?? (args[0] as { doc?: Document })?.doc;
        if (doc) { injectCM6Styles(doc); injectAutoLinkerStyles(doc); }
      })
    );

    if (this.settings.enableAutoLinker) {
      const linker = new AutoLinker(this.app, this.settings.tokenizer);
      this.autoLinker = linker;

      await linker.load(() => this.loadData());
      linker.buildWhenReady();
      linker.registerMetadataEvents((e) => this.registerEvent(e));

      // Configure the semantic tier if the user has it enabled (lazy model load).
      if (this.settings.enableSemantic) void this.applySemantic();

      const persistFn    = () => linker.save(() => this.loadData(), (d) => this.saveData(d));
      const rescanActive = () => this.rescanActiveEditor();

      const panel = new RejectStagingPanel(this.app, linker, persistFn, rescanActive);
      this.stagingPanel = panel;

      const extensions = buildAutoLinkerExtensions(this.app, linker, panel, persistFn, this, () => this.settings.sensitivity);
      this.registerEditorExtension(extensions);

      // Full-note scan when a file is opened
      this.registerEvent(
        this.app.workspace.on("file-open", (file) => {
          if (!file) return;
          setTimeout(() => this.rescanActiveEditor(), 200);
        })
      );


      // When a file is deleted, drop its rejections so a same-named note
      // created later is suggestable again.
      this.registerEvent(
        this.app.vault.on("delete", async (file) => {
          if (!(file instanceof TFile)) return;
          if (linker.pruneRejectsForPath(file.path)) {
            await persistFn();
            this.rescanActiveEditor();
          }
        })
      );
    }
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
      new Notice(
        status === "ready"
          ? "Auto-linker: semantic model ready."
          : `Auto-linker: semantic model ${status} (the embedding library is not bundled yet).`,
      );
    }
    this.rescanActiveEditor();
  }

  rescanActiveEditor() {
    if (!this.autoLinker) return;
    const file = this.app.workspace.getActiveFile();
    if (!file) return;
    const cm = (this.app.workspace.activeEditor?.editor as any)?.cm as EditorView | undefined;
    if (!cm) return;
    scanFullNote(cm, file, this.autoLinker, this.settings.sensitivity);
  }

  onunload() {
    this.stagingPanel?.destroy();
    this.autoLinker?.destroy();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
