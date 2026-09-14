/**
 * Title collection: getTitles (file 0-based) + getElements scan, spatial dedupe.
 */

import {PluginFileAPI} from 'sn-plugin-lib';
import {log} from '../utils/debug';
import {
  filePageIndices,
  filePageToHost,
  toHostPageIndex,
} from '../utils/pageIndex';
import {rectsOverlap} from './tocMarkers';

const TAG = 'Collect';
const TYPE_TITLE = 100;
const TYPE_PICTURE = 200;
const CHUNK_SIZE = 25;
const CHUNK_DELAY_MS = 80;
const DEDUPE_PAD = 32;

/** Title style 1–4 → indent depth 0–3. */
export function styleToIndent(style) {
  const s = Number(style);
  if (s === 2) return 1;
  if (s === 3) return 2;
  if (s === 4) return 3;
  return 0;
}

function normalizeTitleCore(raw, hostPage) {
  const t = raw?.title && typeof raw.title === 'object' ? raw.title : raw;
  if (!t || typeof t !== 'object') return null;

  const page = toHostPageIndex(hostPage);

  const style = Number(t.style ?? 0);
  const controlTrailNums = Array.isArray(t.controlTrailNums)
    ? t.controlTrailNums.map(n => Number(n)).filter(n => Number.isFinite(n))
    : [];

  const inlineText =
    t.text ??
    t.fullText ??
    t.showText ??
    raw?.text ??
    raw?.textBox?.textContentFull ??
    '';

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
    ...(String(inlineText || '').trim()
      ? {text: String(inlineText).trim()}
      : {}),
  };
}

function normalizeTitleFromGetTitles(raw) {
  const t = raw?.title && typeof raw.title === 'object' ? raw.title : raw;
  const rawPage = t?.page ?? raw?.pageNum ?? raw?.page ?? 0;
  const n = Number(rawPage);
  const hostPage = Number.isFinite(n) && n >= 0 ? filePageToHost(n) : 1;
  return normalizeTitleCore(raw, hostPage);
}

function normalizeTitleFromElements(raw, filePage) {
  return normalizeTitleCore(raw, filePageToHost(filePage));
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

function titleRect(item) {
  const x = Number(item.x) || 0;
  const y = Number(item.y) || 0;
  const w = Number(item.width) || 0;
  const h = Number(item.height) || 0;
  if (w <= 0 || h <= 0) {
    return {left: x - 24, top: y - 24, right: x + 24, bottom: y + 24};
  }
  return {left: x, top: y, right: x + w, bottom: y + h};
}

function titlesOverlap(a, b) {
  return rectsOverlap(titleRect(a), titleRect(b), DEDUPE_PAD);
}

function titleQuality(item) {
  let score = 0;
  if (item.controlTrailNums?.length) score += 10;
  if (item.text) score += 5;
  if (item.source === 'title') score += 2;
  if (Number(item.num) > 0) score += 1;
  return score;
}

function dedupeTitlesSpatial(list) {
  const sorted = sortTitles(list);
  const kept = [];
  for (const item of sorted) {
    const page = toHostPageIndex(item.page);
    const dupIdx = kept.findIndex(
      k => toHostPageIndex(k.page) === page && titlesOverlap(k, item),
    );
    if (dupIdx >= 0) {
      if (titleQuality(item) > titleQuality(kept[dupIdx])) {
        kept[dupIdx] = item;
      }
    } else {
      kept.push(item);
    }
  }
  return kept;
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

function formatApiError(res) {
  const err = res?.error;
  if (!err) return '';
  if (typeof err === 'string') return err;
  const code = err.code ?? err.errorCode ?? '?';
  const msg = err.message ?? err.msg ?? JSON.stringify(err);
  return `code=${code} message=${msg}`;
}

function isTitleElement(el) {
  return el?.type === TYPE_TITLE || (el?.title && typeof el.title === 'object');
}

function elementTypeHistogram(elements) {
  const hist = {};
  for (const el of elements || []) {
    const t = el?.type ?? 'unknown';
    hist[t] = (hist[t] || 0) + 1;
  }
  return hist;
}

async function getTitlesForPages(notePath, filePages, label) {
  if (!filePages.length) return {items: [], ok: true, partial: false};
  const res = await PluginFileAPI.getTitles(notePath, filePages);
  const ok = res?.success !== false;
  const items = [];
  if (Array.isArray(res?.result)) {
    for (const raw of res.result) {
      const n = normalizeTitleFromGetTitles(raw);
      if (n) items.push(n);
    }
  }
  if (!ok) {
    log(TAG, `getTitles ${label} failed: ${formatApiError(res)}`);
  } else {
    log(
      TAG,
      `getTitles ${label} filePages=[${filePages[0]}..${filePages[filePages.length - 1]}] count=${items.length}`,
    );
  }
  return {items, ok, partial: !ok};
}

async function collectViaGetTitlesChunked(notePath, filePages, label) {
  const chunks = chunkPages(filePages, CHUNK_SIZE);
  const chunkResults = [];
  let anyPartial = false;

  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await sleep(CHUNK_DELAY_MS);
    const chunk = await getTitlesForPages(
      notePath,
      chunks[i],
      `${label} chunk ${i + 1}/${chunks.length}`,
    );
    chunkResults.push(chunk.items);
    if (chunk.partial) anyPartial = true;
  }

  return {items: mergeTitles(chunkResults), anyPartial};
}

async function collectViaGetTitles(notePath, pageCount) {
  const filePages = filePageIndices(pageCount);
  if (!filePages.length) return [];

  let first = await getTitlesForPages(notePath, filePages, 'file-index all');
  if (first.ok && first.items.length > 0) {
    return first.items;
  }

  if (!first.ok) {
    log(TAG, 'getTitles full call failed — retrying in chunks');
    const chunked = await collectViaGetTitlesChunked(
      notePath,
      filePages,
      'file-index',
    );
    if (chunked.items.length > 0) return chunked.items;
  }

  return first.items;
}

async function collectTitlesFromElements(notePath, filePages) {
  const out = [];
  for (const filePage of filePages) {
    const res = await PluginFileAPI.getElements(filePage, notePath);
    if (!res?.success || !Array.isArray(res.result)) {
      log(TAG, `getElements file=${filePage} failed: ${formatApiError(res)}`);
      continue;
    }
    const hist = elementTypeHistogram(res.result);
    log(TAG, `getElements file=${filePage} types=${JSON.stringify(hist)}`);
    for (const el of res.result) {
      if (!isTitleElement(el)) continue;
      const n = normalizeTitleFromElements(el, filePage);
      if (n) out.push(n);
    }
  }
  log(TAG, `getElements titles on ${filePages.length} file pages → ${out.length}`);
  return out;
}

function stickerBasename(path) {
  const base = String(path || '').split(/[/\\]/).pop() || 'Sticker';
  return base.replace(/\.sticker$/i, '').replace(/[_-]+/g, ' ').trim() || 'Sticker';
}

function normalizeSticker(el, hostPage) {
  const pic = el?.picture;
  const path = pic?.picturePath || '';
  if (!path.toLowerCase().endsWith('.sticker')) return null;

  const rect = pic?.rect || {};
  return {
    page: toHostPageIndex(hostPage),
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

async function collectStickersFromElements(notePath, filePages) {
  const out = [];
  for (const filePage of filePages) {
    const hostPage = filePageToHost(filePage);
    const res = await PluginFileAPI.getElements(filePage, notePath);
    if (!res?.success || !Array.isArray(res.result)) continue;
    for (const el of res.result) {
      if (el?.type !== TYPE_PICTURE) continue;
      const n = normalizeSticker(el, hostPage);
      if (n) out.push(n);
    }
  }
  log(TAG, `stickers on ${filePages.length} file pages → ${out.length}`);
  return out;
}

/**
 * @param {number} pageCount host total page count
 * @param {{ tocHostPage?: number, excludeTocHostPage?: boolean }} [options]
 */
export async function collectTitles(notePath, pageCount, options = {}) {
  const tocHostPage = toHostPageIndex(options.tocHostPage ?? 1);
  const excludeTocHostPage = Boolean(options.excludeTocHostPage);
  const filePages = filePageIndices(pageCount);

  const fromGetTitles = await collectViaGetTitles(notePath, pageCount);
  const getTitlesCount = (fromGetTitles || []).length;

  const fromElements = await collectTitlesFromElements(notePath, filePages);
  let list = mergeTitles([fromGetTitles || [], fromElements]);
  const mergedCount = list.length;

  list = dedupeTitlesSpatial(list);
  if (excludeTocHostPage) {
    list = list.filter(t => toHostPageIndex(t.page) !== tocHostPage);
  }
  const uniqueCount = list.length;

  log(
    TAG,
    `getTitles=${getTitlesCount} getElements=${fromElements.length} merged=${mergedCount} unique=${uniqueCount} excludeToc=${excludeTocHostPage}`,
  );

  if (!list.length) {
    const stickers = await collectStickersFromElements(notePath, filePages);
    list = mergeTitles([list, stickers]);
    if (excludeTocHostPage) {
      list = list.filter(t => toHostPageIndex(t.page) !== tocHostPage);
    }
    if (stickers.length > 0) {
      log(TAG, `stickers merged total=${list.length}`);
    }
  }

  const sorted = sortTitles(list || []);
  log(TAG, `sorted ${sorted.length} titles`);
  return sorted;
}

/** Shift every heading host page after inserting a page at the front. */
export function shiftTitlePages(titles, delta = 1) {
  const d = Number(delta) || 0;
  if (d === 0) return titles;
  return titles.map(t => ({
    ...t,
    page: toHostPageIndex(t.page) + d,
  }));
}
