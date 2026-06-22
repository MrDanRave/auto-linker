import { App, PluginSettingTab, Setting } from "obsidian";
import type AutoLinkerPlugin from "./main";

export interface AutoLinkerSettings {
  enableAutoLinker: boolean;
}

export const DEFAULT_SETTINGS: AutoLinkerSettings = {
  enableAutoLinker: true,
};

interface RejectRow {
  span: string;
  targetPath: string;
  targetName: string;
  notePath: string | null;
  noteName: string | null;
}

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
      .setDesc("Suggest wiki-links for text matching note titles.")
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
    containerEl.createEl("p", {
      cls:  "auto-linker-settings-desc",
      text: "Remove an entry to make it suggestable again.",
    });

    const all = linker.getRejectList();
    const vaultRejects = all.filter((r) => r.notePath === null);
    const noteRejects  = all.filter((r) => r.notePath !== null);

    // Vault Rejections — flat list under one dropdown
    const vaultDetails = containerEl.createEl("details", { cls: "auto-linker-reject-details" });
    vaultDetails.createEl("summary", { text: `Vault Rejections (${vaultRejects.length})` });
    if (vaultRejects.length === 0) {
      vaultDetails.createEl("p", { cls: "auto-linker-settings-empty", text: "None." });
    } else {
      const list = vaultDetails.createEl("div", { cls: "auto-linker-reject-table" });
      for (const entry of vaultRejects) this.renderRow(list, entry);
    }

    // Note Rejections — one submenu per origin note
    const groups = new Map<string, RejectRow[]>();
    for (const r of noteRejects) {
      const arr = groups.get(r.notePath as string) ?? [];
      arr.push(r);
      groups.set(r.notePath as string, arr);
    }

    const noteDetails = containerEl.createEl("details", { cls: "auto-linker-reject-details" });
    noteDetails.createEl("summary", { text: `Note Rejections (${noteRejects.length})` });
    if (groups.size === 0) {
      noteDetails.createEl("p", { cls: "auto-linker-settings-empty", text: "None." });
    } else {
      for (const [, rows] of groups) {
        const sub = noteDetails.createEl("details", { cls: "auto-linker-reject-subdetails" });
        sub.createEl("summary", { text: `${rows[0].noteName} (${rows.length})` });
        const list = sub.createEl("div", { cls: "auto-linker-reject-table" });
        for (const entry of rows) this.renderRow(list, entry);
      }
    }
  }

  private renderRow(list: HTMLElement, entry: RejectRow) {
    const row = list.createEl("div", { cls: "auto-linker-reject-table-row" });
    row.createEl("span", {
      cls:  "auto-linker-reject-table-label",
      text: `"${entry.span}" → ${entry.targetName}`,
    });
    const removeBtn = row.createEl("button", {
      cls:  "auto-linker-reject-table-remove",
      text: "Remove",
      attr: { "aria-label": `Remove: "${entry.span}" → ${entry.targetName}` },
    });
    removeBtn.addEventListener("click", async () => {
      const linker = this.plugin.autoLinker;
      if (!linker) return;
      linker.removeFromRejectList(entry.span, entry.targetPath, entry.notePath);
      await this.plugin.persistAutoLinker();
      this.display();
    });
  }
}
