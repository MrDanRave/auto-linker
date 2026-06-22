import { Plugin } from "obsidian";
import { DEFAULT_SETTINGS, AutoLinkerSettings, AutoLinkerSettingTab } from "./settings";
import { AutoLinker, buildAutoLinkerExtensions, scanFullNote } from "./features/autoLinker";
import { injectCM6Styles } from "./shared/cm6";
import { EditorView } from "@codemirror/view";

export default class AutoLinkerPlugin extends Plugin {
  settings: AutoLinkerSettings;
  private autoLinker: AutoLinker | null = null;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new AutoLinkerSettingTab(this.app, this));

    injectCM6Styles(document);

    if (this.settings.enableAutoLinker) {
      const linker = new AutoLinker(this.app);
      this.autoLinker = linker;

      await linker.load(() => this.loadData());
      linker.buildWhenReady();
      linker.registerMetadataEvents((e) => this.registerEvent(e));

      const persistFn = () =>
        linker.save(() => this.loadData(), (d) => this.saveData(d));

      const extensions = buildAutoLinkerExtensions(this.app, linker, persistFn);
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

      this.addCommand({
        id: "auto-linker-scan-vault",
        name: "Auto Linker: scan entire vault for link suggestions",
        callback: () => this.runVaultScan(linker, persistFn),
      });
    }
  }

  private async runVaultScan(linker: AutoLinker, persistFn: () => void) {
    const files = this.app.vault.getMarkdownFiles();
    let i = 0;

    const tick = async () => {
      if (i >= files.length) {
        persistFn();
        return;
      }
      const file = files[i++];
      const content = await this.app.vault.cachedRead(file);
      linker.scan(content, 0, file.path);
      setTimeout(tick, 0);
    };

    setTimeout(tick, 0);
  }

  onunload() {}

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}
