/**
 * Sync snap-back links on heading pages; remove orphans when headings move.
 */

import {PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';
import {log} from '../utils/debug';
import {toHostPageIndex} from '../utils/pageIndex';
import {
  isIndexBotSnapBackLink,
  SNAPBACK_SENTINEL,
  SNAPBACK_SHOW,
} from './tocMarkers';

const TAG = 'SnapBack';
const TYPE_LINK = 600;
const MARGIN = 48;
const LINK_FONT = 28;
const LINK_W = 72;
const LINK_H = 36;
const CHAR_FACTOR = 0.55;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      val => {
        clearTimeout(timer);
        resolve(val);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function estimateTextWidth(text, fontSize) {
  return String(text || '').length * fontSize * CHAR_FACTOR;
}

function uniqueHeadingPages(headings, tocPage) {
  const toc = toHostPageIndex(tocPage);
  const set = new Set();
  for (const h of headings || []) {
    const p = toHostPageIndex(h.page);
    if (p !== toc) set.add(p);
  }
  return [...set].sort((a, b) => a - b);
}

function buildSnapBackElement(notePath, tocPage, page, pageSize) {
  const showW = Math.ceil(estimateTextWidth(SNAPBACK_SHOW, LINK_FONT)) + 8;
  const width = Math.max(LINK_W, showW);
  const x = Math.max(MARGIN, pageSize.width - MARGIN - width);
  const y = MARGIN;

  return {
    type: TYPE_LINK,
    pageNum: toHostPageIndex(page),
    layerNum: 0,
    link: {
      category: 0,
      X: x,
      Y: y,
      width,
      height: LINK_H,
      page: toHostPageIndex(page),
      style: 0,
      linkType: 0,
      destPath: notePath,
      destPage: toHostPageIndex(tocPage),
      fontSize: LINK_FONT,
      fullText: SNAPBACK_SENTINEL,
      showText: SNAPBACK_SHOW,
      italic: 0,
    },
  };
}

async function getPageElements(notePath, page) {
  const hostPage = toHostPageIndex(page);
  const res = await withTimeout(
    PluginFileAPI.getElements(hostPage, notePath),
    15000,
    `getElements(${hostPage})`,
  );
  if (!res?.success || !Array.isArray(res.result)) {
    log(TAG, `getElements page=${hostPage} failed`);
    return null;
  }
  return res.result;
}

async function replacePageElements(notePath, page, elements) {
  const hostPage = toHostPageIndex(page);
  const res = await withTimeout(
    PluginFileAPI.replaceElements(notePath, hostPage, elements),
    20000,
    `replaceElements(${hostPage})`,
  );
  if (!res?.success) {
    throw new Error(
      `Failed to update page ${hostPage}: ${res?.error?.message || 'unknown'}`,
    );
  }
}

async function stripSnapBackOnPage(notePath, page) {
  const els = await getPageElements(notePath, page);
  if (!els) return 0;
  const kept = els.filter(el => !isIndexBotSnapBackLink(el));
  const removed = els.length - kept.length;
  if (removed > 0) {
    await replacePageElements(notePath, page, kept);
    log(TAG, `Removed ${removed} snap-back on page ${page}`);
  }
  return removed;
}

/**
 * @returns {{ targetPages: number[], removed: number, inserted: number }}
 */
export async function syncSnapBackLinks({
  notePath,
  tocPage = 1,
  headings,
  pageSize,
  pageCount,
  enabled = false,
}) {
  const targetPages = enabled ? uniqueHeadingPages(headings, tocPage) : [];
  const targetSet = new Set(targetPages);
  let removed = 0;
  let inserted = 0;

  const pages = Math.max(1, toHostPageIndex(pageCount));
  for (let page = 1; page <= pages; page++) {
    const els = await getPageElements(notePath, page);
    if (!els) continue;

    const hasSnap = els.some(isIndexBotSnapBackLink);
    const shouldHave = enabled && targetSet.has(page);

    if (!shouldHave && hasSnap) {
      const kept = els.filter(el => !isIndexBotSnapBackLink(el));
      await replacePageElements(notePath, page, kept);
      removed += els.length - kept.length;
      continue;
    }

    if (shouldHave) {
      const kept = els.filter(el => !isIndexBotSnapBackLink(el));
      if (kept.length !== els.length) {
        await replacePageElements(notePath, page, kept);
        removed += els.length - kept.length;
      }
      const linkEl = buildSnapBackElement(notePath, tocPage, page, pageSize);
      const ins = await withTimeout(
        PluginFileAPI.insertElements(notePath, page, [linkEl]),
        20000,
        `insertElements snap-back p${page}`,
      );
      if (ins?.success !== false) {
        inserted += 1;
        log(TAG, `Inserted snap-back on page ${page}`);
      } else {
        log(TAG, `insert snap-back page ${page} failed: ${JSON.stringify(ins?.error)}`);
      }
    }
  }

  log(
    TAG,
    `sync enabled=${enabled} targets=${targetPages.length} inserted=${inserted} removed=${removed}`,
  );

  try {
    await PluginCommAPI.reloadFile();
  } catch (e) {
    log(TAG, `reloadFile: ${e.message}`);
  }

  return {targetPages, removed, inserted};
}
