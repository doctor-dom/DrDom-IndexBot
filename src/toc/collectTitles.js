/**
 * Tiered title collection: getTitles retry → targeted getElements → stickers.
 * Never scans every page in the notebook.
 */

import {PluginFileAPI} from 'sn-plugin-lib';
import {log} from '../utils/debug';
import {toHostPageIndex} from '../utils/pageIndex';

const TAG = 'Collect';
const TYPE_TITLE = 100;
const TYPE_PICTURE = 200;
const CHUNK_SIZE = 25;
const CHUNK_DELAY_MS = 80;

/** Title style 1–4 → indent depth 0–3. */
export function styleToIndent(style) {
  const s = Number(style);
  if (s === 2) return 1;
  if (s === 3) return 2;
  if (s === 4) return 3;
  return 0;
}

function normalizeTitle(raw, fallbackPage) {
  const t = raw?.title && typeof raw.title === 'object' ? raw.title : raw;
  if (!t || typeof t !== 'object') return null;

  const page = toHostPageIndex(
    t.page ?? raw?.pageNum ?? raw?.page ?? fallbackPage,
  );
  const style = Number(t.style ?? 0);
  const controlTrailNums = Array.isArray(t.controlTrailNums)
    ? t.controlTrailNums.map(n => Number(n)).filter(n => Number.isFinite(n))
    : [];

  return {
    page,
    y: Number(t.Y ?? t.y ?? 0),
    x: Number(t.X ?? t.x ?? 0),
    width: Number(t.width ?? 0),
    height: Number(t.height ?? 0),
    style,
    indentLevel: styleToIndent(style),
    controlTrailNums,
    num: Number(t.num ?? raw?.numInPage ?? 0),
    source: 'title',
  };
}

function titleKey(item) {
  const page = toHostPageIndex(item.page);
  const num = Number(item.num) || 0;
  if (num > 0) return `${page}:${num}`;
  return `${page}:${Math.round(item.y)}:${Math.round(item.x)}`;
}

function mergeTitles(lists) {
  const map = new Map();
  for (const list of lists) {
    for (const item of list || []) {
      if (!item) continue;
      map.set(titleKey(item), item);
    }
  }
  return [...map.values()];
}

function sortTitles(list) {
  return [...list].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (a.y !== b.y) return a.y - b.y;
    return a.x - b.x;
  });
}

function pageListForCount(pageCount) {
  const out = [];
  for (let p = 1; p <= pageCount; p++) out.push(p);
  return out;
}

function chunkPages(pages, size) {
  const chunks = [];
  for (let i = 0; i < pages.length; i += size) {
    chunks.push(pages.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function getTitlesForPages(notePath, pages) {
  if (!pages.length) return {items: [], ok: true, partial: false};
  const res = await PluginFileAPI.getTitles(notePath, pages);
  const ok = res?.success !== false;
  const items = [];
  if (Array.isArray(res?.result)) {
    for (const raw of res.result) {
      const n = normalizeTitle(raw, pages[0] || 1);
      if (n) items.push(n);
    }
  }
  return {items, ok, partial: !ok};
}

async function collectViaGetTitles(notePath, pageCount) {
  const allPages = pageListForCount(pageCount);
  const first = await getTitlesForPages(notePath, allPages);
  log(
    TAG,
    `getTitles all pages success=${first.ok} count=${first.items.length}`,
  );

  if (first.ok && first.items.length > 0) {
    return first.items;
  }

  if (first.ok && first.items.length === 0) {
    return [];
  }

  // Retry in chunks when the full call failed
  log(TAG, 'getTitles full call failed — retrying in chunks');
  const chunks = chunkPages(allPages, CHUNK_SIZE);
  const chunkResults = [];
  let anyPartial = false;

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(CHUNK_DELAY_MS);
    const chunk = await getTitlesForPages(notePath, chunks[i]);
    chunkResults.push(chunk.items);
    if (chunk.partial) anyPartial = true;
    log(
      TAG,
      `getTitles chunk ${i + 1}/${chunks.length} ok=${chunk.ok} count=${chunk.items.length}`,
    );
  }

  const merged = mergeTitles(chunkResults);
  if (merged.length > 0) {
    return merged;
  }

  if (!anyPartial && first.items.length > 0) {
    return first.items;
  }

  return merged;
}

async function resolveCandidatePages(notePath, pageCount, currentPage, seedTitles) {
  const pages = new Set();

  for (const t of seedTitles) {
    pages.add(toHostPageIndex(t.page));
  }

  if (pages.size === 0) {
    try {
      const stars = await PluginFileAPI.searchFiveStars(notePath);
      const starPages = stars?.result ?? stars;
      if (Array.isArray(starPages)) {
        for (const p of starPages) pages.add(toHostPageIndex(p));
      }
    } catch (e) {
      log(TAG, `searchFiveStars failed: ${e.message}`);
    }

    try {
      const marks = await PluginFileAPI.getMarkPages(notePath);
      const markPages = marks?.result ?? marks;
      if (Array.isArray(markPages)) {
        for (const p of markPages) pages.add(toHostPageIndex(p));
      }
    } catch (e) {
      log(TAG, `getMarkPages failed: ${e.message}`);
    }
  }

  if (pages.size === 0 && currentPage) {
    pages.add(toHostPageIndex(currentPage));
  }

  return [...pages].filter(p => p >= 1 && p <= pageCount).sort((a, b) => a - b);
}

async function collectTitlesFromElements(notePath, pages) {
  const out = [];
  for (const page of pages) {
    const hostPage = toHostPageIndex(page);
    const res = await PluginFileAPI.getElements(hostPage, notePath);
    if (!res?.success || !Array.isArray(res.result)) {
      log(TAG, `getElements page=${hostPage} failed: ${JSON.stringify(res?.error)}`);
      continue;
    }
    for (const el of res.result) {
      if (el?.type !== TYPE_TITLE) continue;
      const n = normalizeTitle(el, hostPage);
      if (n) out.push(n);
    }
  }
  log(TAG, `getElements titles on ${pages.length} pages → ${out.length}`);
  return out;
}

function stickerBasename(path) {
  const base = String(path || '').split(/[/\\]/).pop() || 'Sticker';
  return base.replace(/\.sticker$/i, '').replace(/[_-]+/g, ' ').trim() || 'Sticker';
}

function normalizeSticker(el, page) {
  const pic = el?.picture;
  const path = pic?.picturePath || '';
  if (!path.toLowerCase().endsWith('.sticker')) return null;

  const rect = pic?.rect || {};
  return {
    page: toHostPageIndex(page),
    y: Number(rect.top ?? 0),
    x: Number(rect.left ?? 0),
    width: Number((rect.right ?? 0) - (rect.left ?? 0)),
    height: Number((rect.bottom ?? 0) - (rect.top ?? 0)),
    style: 1,
    indentLevel: 0,
    controlTrailNums: [],
    num: Number(el.numInPage ?? 0),
    source: 'sticker',
    text: stickerBasename(path),
  };
}

async function collectStickersFromElements(notePath, pages) {
  const out = [];
  for (const page of pages) {
    const hostPage = toHostPageIndex(page);
    const res = await PluginFileAPI.getElements(hostPage, notePath);
    if (!res?.success || !Array.isArray(res.result)) continue;
    for (const el of res.result) {
      if (el?.type !== TYPE_PICTURE) continue;
      const n = normalizeSticker(el, hostPage);
      if (n) out.push(n);
    }
  }
  log(TAG, `stickers on ${pages.length} pages → ${out.length}`);
  return out;
}

/**
 * @returns {Promise<Array<{page,y,x,width,height,style,indentLevel,controlTrailNums,num,text?,source}>>}
 */
export async function collectTitles(notePath, pageCount, currentPage = 1) {
  let list = await collectViaGetTitles(notePath, pageCount);

  const needsFallback = !list || list.length === 0;
  if (needsFallback) {
    const candidatePages = await resolveCandidatePages(
      notePath,
      pageCount,
      currentPage,
      list || [],
    );
    log(TAG, `candidate pages for fallback: ${candidatePages.join(',') || '(none)'}`);

    if (candidatePages.length > 0) {
      const fromElements = await collectTitlesFromElements(notePath, candidatePages);
      list = mergeTitles([list || [], fromElements]);

      if (!list.length) {
        const stickers = await collectStickersFromElements(notePath, candidatePages);
        list = mergeTitles([list, stickers]);
      }
    }
  }

  const sorted = sortTitles(list || []);
  log(TAG, `sorted ${sorted.length} titles`);
  return sorted;
}
