# Auto Linker

**Surfaces the links you'd have made by hand.** As you write, Auto Linker quietly underlines the words that match your other notes and offers a one‑click wiki‑link — ranked by a confidence score, not a blind text match, so you get the *useful* links and not the noise.

![demo](demo.gif)

---

## Why it's different

Most "auto link" tools do a **binary** match: a word either equals a note title or it doesn't — which is why they happily suggest linking the word *"and"* to your `AND` note. Auto Linker instead computes a **confidence score in [0,1]** for every candidate and only shows the ones that clear a threshold you control. That score blends several signals:

- **Lexical match** — how closely the text matches a note's title (exact, stemmed, or a close typo).
- **Significance** — common words (*the, and, from*) score low; distinctive words score high. No hard stop‑word list; it's graded, and self‑tunes to your vault via IDF.
- **Capitalization** — `AND` (the SQL keyword) reads differently from *"and"*; ALL‑CAPS / TitleCase get a boost, lowercase function words a penalty.
- **Note importance** — well‑linked "hub" notes (PageRank over your link graph) rank higher.
- **Semantic meaning** *(optional, local)* — an on‑device embedding model re‑ranks candidates by meaning.
- **Learned preference** — it learns from the links you actually make and the suggestions you accept.

The result: typing *"my database layer"* suggests `Database`, but *"x and y"* doesn't suggest `AND` — without you maintaining a stop‑word list.

## Features

- **Scored, ranked suggestions** with a single **Sensitivity** dial (more vs. only‑confident).
- **Per‑signal weight sliders** — tune the balance yourself; restore defaults anytime.
- **Smart tokenizer** — handles `802.1Q`, `Topic : Subtopic`, `client-server`, and path‑like titles via configurable separator rules.
- **Typo tolerance** — `databse` still finds `Database`; bounded so it stays quiet.
- **Multi‑word titles & aliases**, including a distinctive word standing in for the whole (`kruger` → `Dunning‑Kruger`).
- **Learned aliases** — link `[[Valuable|value]]` once and *value* starts suggesting `Valuable` thereafter.
- **Reject memory** — dismiss a suggestion per‑note or vault‑wide; manage them in settings.
- **Hover to preview** the target note, approve (✓), or reject (✗) inline.
- **Skips** `[[existing links]]`, `#tags`, inline `` `code` `` and ```` ``` fenced blocks ````.
- **Never links a note to itself** — nudging you toward atomic, outward‑defined notes.

## Privacy

Everything runs **locally**. The index, scores, reject list, learned aliases, and the optional embedding cache all stay on your device — no telemetry, no external API. The **only** network event in the whole plugin is the optional, one‑time download of the embedding model when *you* turn the semantic tier on (it carries no note data, and can be avoided entirely by pointing at a model you already have).

## The semantic tier (optional, off by default)

Turning on **Semantic meaning** loads a small embedding model that re‑ranks suggestions by meaning. When you enable it you choose:

- **Download** the default multilingual model (`Xenova/paraphrase-multilingual-MiniLM-L12-v2`, ~50 MB, once), or
- **Use local model** — point at a transformers.js‑format model already on disk (air‑gapped / your own).

Use **Settings → "Index vault for semantics"** to pre‑compute every note's "meaning fingerprint" so meaning‑based ranking is ready across the whole vault immediately.

> The semantic tier **re‑ranks** literal candidates — it refines what the text match already found. It does **not** discover links for text with no word in common with a note title (e.g. typing *"velociraptor"* won't surface a `Dinosaur` note). Add an alias for that.

> Rule‑based stemming covers Latin/Cyrillic scripts; Hebrew/Arabic morphology is left to the multilingual embedding model rather than faked.

## Install

**Manually:** copy `main.js`, `manifest.json`, and `styles.css` (if present) into `<vault>/.obsidian/plugins/auto-linker/`, then enable it in *Settings → Community plugins*.

**Via [BRAT](https://github.com/TfTHacker/obsidian42-brat):** add this repository as a beta plugin, then enable **Auto Linker** in the Community Plugins list.

## Usage

1. Start typing. Matching spans get a subtle underline (a **dotted** underline means the match was lifted by meaning rather than text alone).
2. Hover a suggestion to **preview** the target, then **✓** to insert `[[Note|text]]` or **✗** to dismiss.
3. Dismissed suggestions can be escalated to vault‑wide from the staging panel, and reviewed under *Settings → Rejected suggestions*.
4. Tune **Sensitivity** and the **Signal weights** in settings to match how you work.

## Build from source

```bash
npm install
npm run dev      # watch mode — pairs with the Hot-Reload plugin
npm run build    # production build → main.js
```

Built with esbuild; the embedding backend (`@xenova/transformers`) is bundled and lazy‑loaded only when the semantic tier is enabled.

## License

MIT
