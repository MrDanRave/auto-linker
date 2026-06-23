// src/features/graph.ts
// PageRank-based graph authority scorer for auto-linker.
// Reads Obsidian's resolvedLinks to compute per-note importance scores,
// which feed into the confidence formula as the "graph" signal.

import { App } from "obsidian";

const DAMPING     = 0.85;
const ITERATIONS  = 20;
const DEBOUNCE_MS = 2000;

export class GraphScorer {
  private scores = new Map<string, number>();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private app: App) {}

  /** Full immediate rebuild — call on layout-ready and resolved events. */
  build() {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.runPageRank();
  }

  /** Debounced rebuild — call when a single file's metadata changes. */
  scheduleRebuild() {
    if (this.debounceTimer !== null) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.runPageRank();
    }, DEBOUNCE_MS);
  }

  /** Returns the normalized [0,1] PageRank score for a note path. */
  getScore(path: string): number {
    return this.scores.get(path) ?? 0;
  }

  destroy() {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  private runPageRank() {
    const resolvedLinks = this.app.metadataCache.resolvedLinks;
    const allFiles      = this.app.vault.getMarkdownFiles();

    if (allFiles.length === 0) { this.scores.clear(); return; }

    const N        = allFiles.length;
    const nodeList = allFiles.map((f) => f.path);

    // Build inbound-link and out-degree maps over existing files only.
    const inbound:   Map<string, string[]> = new Map();
    const outDegree: Map<string, number>   = new Map();
    for (const p of nodeList) { inbound.set(p, []); outDegree.set(p, 0); }

    for (const sourcePath of Object.keys(resolvedLinks)) {
      const targets = resolvedLinks[sourcePath];
      let count = 0;
      for (const targetPath of Object.keys(targets)) {
        if (inbound.has(targetPath)) {
          inbound.get(targetPath)!.push(sourcePath);
          count++;
        }
      }
      if (outDegree.has(sourcePath)) outDegree.set(sourcePath, count);
    }

    // Iterative PageRank
    const base = (1 - DAMPING) / N;
    const rank  = new Map<string, number>();
    for (const p of nodeList) rank.set(p, 1 / N);

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const next = new Map<string, number>();
      for (const p of nodeList) {
        let sum = 0;
        for (const s of (inbound.get(p) ?? [])) {
          const od = outDegree.get(s) ?? 1;
          if (od > 0) sum += (rank.get(s) ?? 0) / od;
        }
        next.set(p, base + DAMPING * sum);
      }
      for (const [p, r] of next) rank.set(p, r);
    }

    // Normalize to [0, 1]
    let maxRank = 0;
    for (const r of rank.values()) if (r > maxRank) maxRank = r;

    this.scores.clear();
    if (maxRank > 0) {
      for (const [p, r] of rank) this.scores.set(p, r / maxRank);
    }
  }
}
