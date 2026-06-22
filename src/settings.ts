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
