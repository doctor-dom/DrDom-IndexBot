# IndexBot



Supernote NOTE plugin that builds an editable **Table of Contents** from native Heading/Title elements, with jump links on page 1.



## Use



### First run



1. Mark headings with the **Heading** tool (lasso handwriting, tap **H**, choose H1–H4 for hierarchy).

2. Open the note on **any page** and tap **IndexBot** in the note sidebar.

3. Pick a layout, optionally enable **Snap-back links**, then **Generate ToC**.

4. Tap **Cancel** anytime to close IndexBot without generating.



IndexBot writes the ToC on **page 1**. If page 1 already has content, it **automatically inserts a blank page at the front** before writing:



- Your former page 1 becomes page 2 (all later pages shift by one).

- Heading jump links are updated to match the new page numbers.

- The ToC is written on the new blank page 1.



If page 1 is already blank, IndexBot uses it directly (no extra page is added).



### Refresh (update existing ToC)



If a ToC is already on page 1, you can run IndexBot from **any page**. The primary button reads **Update ToC** — it re-scans the note and replaces the ToC on page 1. No new page is inserted on refresh.



## Layouts



| Layout | Description |

|--------|-------------|

| **Outline** | Bullets and indent by level; H1 bold |

| **Compact** | Indented hierarchy with leader dots (default) |

| **Numbered** | `1.` / `1.1` / `1.1.1` with indent |

| **Flat** | Single level, no indent |



## Snap-back links (optional)



When enabled (large **ON/OFF** pill), each page with a heading gets a small **← ToC** link (top-right) back to page 1. On refresh, links are updated and removed from pages that no longer have headings.



## Supernote OS compatibility

IndexBot targets **Chauvet 3.29.45+** (Manta/Nomad plugin preview) for reliable `Element.userData` on `getElements`. That matters when IndexBot **replaces** page elements (ToC refresh and snap-back): kept content should not lose plugin metadata on round-trip.

Details, release notes, and a device checklist: [`docs/compatibility-chauvet.md`](docs/compatibility-chauvet.md).

Dependency: `sn-plugin-lib` **^0.1.65** (npm; rebuild `.snplg` after `npm install` in this folder).

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

