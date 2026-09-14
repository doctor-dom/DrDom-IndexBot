# Chauvet 3.29.45+ and IndexBot

## Release note (Manta / Nomad beta)

**Chauvet 3.29.45 Beta** includes:

- **[Plugin Development]** Fixed the issue where `getElements` could not retrieve `userData`.

This fix is in **device firmware / PluginHost** (native bridge). It is **not** delivered by the IndexBot `.snplg` alone. Use the **plugin preview** firmware build that matches 3.29.45, then reinstall IndexBot after upgrade.

## `sn-plugin-lib` on npm

IndexBot depends on [`sn-plugin-lib`](https://www.npmjs.com/package/sn-plugin-lib) (currently `^0.1.65`). npm latest as of Aug 2026 is **0.1.65**. No npm changelog ties a specific version to the `userData` / `getElements` fix; treat **OS 3.29.45+** as the requirement for correct `userData` on read.

## Impact on IndexBot

IndexBot calls `PluginFileAPI.getElements` from:

| Module | Use |
|--------|-----|
| `collectTitles.js` | Title scan + merge with `getTitles` |
| `insertToc.js` | Strip old ToC, verify insert |
| `checkInsertPage.js` | Refresh vs initial detection |
| `snapBackLinks.js` | Read heading pages before snap-back updates |
| `ocrTitle.js` | Page context for OCR |

IndexBot does **not** require `userData` to find headings or build the ToC. It **does** use `getElements` → filter → `replaceElements` on:

- **ToC host page** (`stripPreviousToc`) — removes IndexBot ToC elements, keeps everything else.
- **Heading pages** (`syncSnapBackLinks`) — removes/adds snap-back links, keeps other elements.

**Before 3.29.45:** If `getElements` omitted `userData`, a round-trip through `replaceElements` could **strip `userData`** on kept elements (other plugins or future IndexBot tags).

**After 3.29.45:** Kept elements should retain `userData` when IndexBot rewrites a page.

IndexBot now tags its own inserts with `Element.userData` (`indexbot:toc-header`, `indexbot:toc-row`, `indexbot:toc-link`, `indexbot:snapback`) while keeping legacy link/text sentinel detection for older notes.

## Device smoke test (manual)

On **Chauvet 3.29.45+** with a fresh `IndexBot.snplg`:

1. **Generate ToC** on a note with 3+ headings — page 1 shows header, titles, and `→` links; `indexbot-last-run.txt` has matching `inserted` and `tocLinks`.
2. **Update ToC** — full list replaces prior ToC (no header-only page).
3. **Snap-back ON** — `← ToC` on heading pages; run again with snap-back OFF — links removed.
4. **Refresh** on a note that already had an IndexBot ToC from an older build — still detected and rebuilt.

## Build

From home-base root:

```powershell
npm run snplg -- IndexBot
```

Output: `dist/indexbot/IndexBot.snplg`
