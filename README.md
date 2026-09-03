# IndexBot

Supernote NOTE plugin that builds an editable **Table of Contents** from native Title headings, with jump links on the current page.

## Use

1. Mark headings in your note with the **Title** tool (H1–H4 styles set hierarchy).
2. Go to the page where you want the ToC.
3. Tap **IndexBot** in the note sidebar.
4. Pick a layout — **Outline**, **Compact**, **Numbered**, or **Flat** — then **Generate ToC**.

On success the plugin closes and the ToC appears on the current page. Each row has an editable title and a tappable leader link (`.... →`) that jumps to the heading’s page.

## Layouts

| Layout | Description |
|--------|-------------|
| **Outline** | Bullets (`•` / `◦` / `-`) and indent by level; H1 bold |
| **Compact** | Indented hierarchy with leader dots (default) |
| **Numbered** | `1.` / `1.1` / `1.1.1` with indent by level |
| **Flat** | Single level, no indent |

No page numbers are printed in any layout.

## Device logs (USB)

| File | When |
|------|------|
| `MyStyle/IndexBot/indexbot-last-run.txt` | Last successful run (one line) |
| `MyStyle/IndexBot/indexbot-error.log` | Last failed run (full debug dump) |

## Build

From the home-base repo root:

```powershell
npm run snplg -- IndexBot
```

Output: `dist/indexbot/IndexBot.snplg` (native pack for on-device logging).

## SDK reference

Shared docs: `../../docs/sdk-reference/`
