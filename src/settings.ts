import { App, PluginSettingTab, Setting } from "obsidian";
import type AutoLinkerPlugin from "./main";

export interface AutoLinkerSettings {
  enableAutoLinker: boolean;
}

export const DEFAULT_SETTINGS: AutoLinkerSettings = {
  enableAutoLinker: true,
};

export class AutoLinkerSettingTab extends PluginSettingTab {
  plugin: AutoLinkerPlugin;

  constructor(app: App, plugin: AutoLinkerPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Auto Linker Settings" });

    new Setting(containerEl)
      .setName("Auto-linker")
      .setDesc("Enable semantic auto-linking (underlines text matching a note title and offers one-click wiki-link insertion).")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoLinker)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoLinker = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
