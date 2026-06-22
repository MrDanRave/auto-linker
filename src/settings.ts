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

    // ── Feature toggle ────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Auto-linker")
      .setDesc("Underlines text matching a note title and offers one-click wiki-link insertion.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableAutoLinker)
          .onChange(async (value) => {
            this.plugin.settings.enableAutoLinker = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Rejected suggestions browser ─────────────────────────────────────
    const linker = this.plugin.autoLinker;
    if (!linker) return;

    containerEl.createEl("h3", { text: "Rejected Suggestions" });

    const rejectList = linker.getRejectList();

    if (rejectList.length === 0) {
      containerEl.createEl("p", {
        cls:  "auto-linker-settings-empty",
        text: "No rejected suggestions.",
      });
      return;
    }

    containerEl.createEl("p", {
      cls:  "auto-linker-settings-desc",
      text: `${rejectList.length} rejected suggestion${rejectList.length === 1 ? "" : "s"}. "All notes" = vault-wide; otherwise rejected only in the named note. Removing an entry makes it suggestable again.`,
    });

    const table = containerEl.createEl("div", { cls: "auto-linker-reject-table" });

    for (const entry of rejectList) {
      const row = table.createEl("div", { cls: "auto-linker-reject-table-row" });

      row.createEl("span", {
        cls:  "auto-linker-reject-table-label",
        text: `"${entry.span}" → ${entry.targetName}`,
      });

      row.createEl("span", {
        cls:  "auto-linker-reject-table-scope",
        text: entry.noteName ? `in ${entry.noteName}` : "all notes",
      });

      const removeBtn = row.createEl("button", {
        cls:  "auto-linker-reject-table-remove",
        text: "Remove",
        attr: { "aria-label": `Remove: "${entry.span}" → ${entry.targetName}` },
      });

      removeBtn.addEventListener("click", async () => {
        linker.removeFromRejectList(entry.span, entry.targetPath, entry.notePath);
        await this.plugin.persistAutoLinker();
        this.display(); // re-render
      });
    }
  }
}
