# Auto Linker

An Obsidian plugin that scans open notes for text matching existing note titles and suggests wiki-link insertions inline.

Hover any underlined phrase to see the target note, preview its contents, approve the link (`[[Target|span]]`), or reject the suggestion. Rejections are managed per-vault via a staging panel that lets you choose between session-only and permanent rejection.

## Features

- Underlines text matching note titles or frontmatter aliases within ~1 s of typing
- Hover tooltip with approve (✓), reject (✗), and preview (👁) actions
- Preview pane shows the first lines of the target note on eye-icon hover; click to open
- Reject staging panel: X removes the suggestion from the note, then lets you decide permanent vs session-only rejection
- Browsable reject list in Settings with per-entry removal

## Installation (BRAT)

1. Install the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin.
2. Open BRAT settings → **Add Beta Plugin**.
3. Paste this repository URL and confirm.
4. Enable **Auto Linker** in Obsidian's Community Plugins list.

## Development

```
npm install
npm run dev      # watch mode — requires Hot-Reload plugin for live reload
npm run build    # production build → main.js
```

## License

MIT
