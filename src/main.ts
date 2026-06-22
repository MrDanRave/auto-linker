import { Plugin } from "obsidian";
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
  settings: AutoLinkerSettings;
  autoLinker: AutoLinker | null = null;
  private stagingPanel: RejectStagingPanel | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new AutoLinkerSettingTab(this.app, this));

    injectCM6Styles(document);
    injectAutoLinkerStyles(document);

    if (this.settings.enableAutoLinker) {
      const linker = new AutoLinker(this.app);
      this.autoLinker = linker;

      await linker.load(() => this.loadData());
      linker.buildWhenReady();
      linker.registerMetadataEvents((e) => this.registerEvent(e));

      const persistFn = () =>
        linker.save(() => this.loadData(), (d) => this.saveData(d));

      const panel = new RejectStagingPanel(this.app, linker, persistFn);
      this.stagingPanel = panel;

      const extensions = buildAutoLinkerExtensions(this.app, linker, panel, persistFn);
      this.registerEditorExtension(extensions);

      this.registerEvent(
        this.app.workspace.on("file-open", (file) => {
          if (!file) return;
          setTimeout(() => {
            const cm = this.app.workspace.activeEditor?.editor?.cm as EditorView | undefined;
            if (!cm) return;
            scanFullNote(cm, file, linker);
          }, 200);
        })
      );
    }
  }

  onunload() {
    this.stagingPanel?.destroy();
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
