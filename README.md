# IndexBot

Supernote NOTE plugin that builds an editable **Table of Contents** from native Title headings, with jump links on page 1.

## Use

### First run

1. Mark headings with the **Title** tool (H1–H4 styles set hierarchy).
2. Go to **page 1** — it must be **blank**.
3. Tap **IndexBot** in the note sidebar.
4. Pick a layout, optionally enable **Snap-back links**, then **Generate ToC**.

### Refresh (update existing ToC)

If a ToC is already on page 1, you can run IndexBot from **any page**. It re-scans the note and replaces the ToC on page 1.

## Layouts

| Layout | Description |
|--------|-------------|
| **Outline** | Bullets and indent by level; H1 bold |
| **Compact** | Indented hierarchy with leader dots (default) |
| **Numbered** | `1.` / `1.1` / `1.1.1` with indent |
| **Flat** | Single level, no indent |

## Snap-back links (optional)

When enabled, each page with a heading gets a small **← ToC** link (top-right) back to page 1. On refresh, links are updated and removed from pages that no longer have headings.

## Device logs (USB)

| File | When |
|------|------|
| `MyStyle/IndexBot/indexbot-last-run.txt` | Last successful run |
| `MyStyle/IndexBot/indexbot-error.log` | Last failed run |

## Build

From the home-base repo root:

```powershell
npm run snplg -- IndexBot
```

Output: `dist/indexbot/IndexBot.snplg`

## SDK reference

Shared docs: `../../docs/sdk-reference/`
