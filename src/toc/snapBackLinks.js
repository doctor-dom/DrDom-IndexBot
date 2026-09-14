/**
 * Sync snap-back links on heading pages; remove orphans when headings move.
 */

import {PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';
import {tocMargin} from './insertToc';
import {log} from '../utils/debug';
import {toFilePageIndex, toHostPageIndex} from '../utils/pageIndex';
import {
  isIndexBotSnapBackLink,
  INDEXBOT_USERDATA_SNAPBACK,
  SNAPBACK_SENTINEL,
  SNAPBACK_SHOW,
} from './tocMarkers';

const TAG = 'SnapBack';
const TYPE_LINK = 600;
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

async function createSdkElement(type) {
  const res = await withTimeout(
    PluginCommAPI.createElement(type),
    10000,
    `createElement(${type})`,
  );
  if (!res?.success || !res.result) {
    throw new Error(
      `createElement(${type}) failed: ${res?.error?.message || 'unknown'}`,
    );
  }
  return res.result;
}

function uniqueHeadingPages(headings, tocHostPage) {
  const toc = toHostPageIndex(tocHostPage);
  const set = new Set();
  for (const h of headings || []) {
    const p = toHostPageIndex(h.page);
    if (p !== toc) set.add(p);
  }
  return [...set].sort((a, b) => a - b);
}

async function buildSnapBackElement(notePath, tocHostPage, headingHostPage, pageSize) {
  const margin = tocMargin(pageSize);
  const showW = Math.ceil(estimateTextWidth(SNAPBACK_SHOW, LINK_FONT)) + 8;
  const width = Math.max(LINK_W, showW);
  const x = Math.max(margin, pageSize.width - margin - width);
  const y = margin;
  const hostPage = toHostPageIndex(headingHostPage);

  const el = await createSdkElement(TYPE_LINK);
  el.type = TYPE_LINK;
  el.pageNum = hostPage;
  el.layerNum = 0;
  el.userData = INDEXBOT_USERDATA_SNAPBACK;
  el.link = {
    category: 0,
    X: x,
    Y: y,
    width,
    height: LINK_H,
    page: hostPage,
    style: 0,
    linkType: 0,
    destPath: notePath,
    destPage: toHostPageIndex(tocHostPage),
    fontSize: LINK_FONT,
    fullText: SNAPBACK_SENTINEL,
    showText: SNAPBACK_SHOW,
    italic: 0,
  };
  return el;
}

async function getPageElements(notePath, hostPage) {
  const filePage = toFilePageIndex(hostPage);
  const res = await withTimeout(
    PluginFileAPI.getElements(filePage, notePath),
    15000,
    `getElements(snap file=${filePage})`,
  );
  if (!res?.success || !Array.isArray(res.result)) {
    log(TAG, `getElements host=${hostPage} file=${filePage} failed`);
    return null;
  }
  return res.result;
}

async function replacePageElements(notePath, hostPage, elements) {
  const filePage = toFilePageIndex(hostPage);
  const res = await withTimeout(
    PluginFileAPI.replaceElements(notePath, filePage, elements),
    20000,
    `replaceElements(snap file=${filePage})`,
  );
  if (!res?.success) {
    throw new Error(
      `Failed to update page ${hostPage}: ${res?.error?.message || 'unknown'}`,
    );
  }
}

/**
 * @returns {{ targetPages: number[], removed: number, inserted: number, failed: number }}
 */
export async function syncSnapBackLinks({
  notePath,
  tocPage = 1,
  headings,
  pageSize,
  enabled = false,
  onProgress,
}) {
  const tocHostPage = toHostPageIndex(tocPage);
  const targetPages = enabled ? uniqueHeadingPages(headings, tocHostPage) : [];
  const targetSet = new Set(targetPages);
  let removed = 0;
  let inserted = 0;
  let failed = 0;

  const headingPages = uniqueHeadingPages(headings, tocHostPage);
  const scanPages = enabled ? targetPages : headingPages;

  const total = scanPages.length;
  for (let i = 0; i < scanPages.length; i++) {
    const hostPage = scanPages[i];
    if (typeof onProgress === 'function') {
      onProgress(i + 1, total, hostPage);
    }

    const els = await getPageElements(notePath, hostPage);
    if (!els) {
      if (enabled && targetSet.has(hostPage)) failed += 1;
      continue;
    }

    const hasSnap = els.some(isIndexBotSnapBackLink);
    const shouldHave = enabled && targetSet.has(hostPage);

    if (!shouldHave && hasSnap) {
      const kept = els.filter(el => !isIndexBotSnapBackLink(el));
      await replacePageElements(notePath, hostPage, kept);
      removed += els.length - kept.length;
      continue;
    }

    if (shouldHave) {
      const kept = els.filter(el => !isIndexBotSnapBackLink(el));
      if (kept.length !== els.length) {
        await replacePageElements(notePath, hostPage, kept);
        removed += els.length - kept.length;
      }

      try {
        const linkEl = await buildSnapBackElement(
          notePath,
          tocHostPage,
          hostPage,
          pageSize,
        );
        const filePage = toFilePageIndex(hostPage);
        const ins = await withTimeout(
          PluginFileAPI.insertElements(notePath, filePage, [linkEl]),
          20000,
          `insertElements snap-back file=${filePage}`,
        );
        if (ins?.success === true) {
          inserted += 1;
          log(TAG, `Inserted snap-back host=${hostPage} file=${filePage}`);
        } else {
          failed += 1;
          log(
            TAG,
            `insert snap-back host=${hostPage} failed: ${JSON.stringify(ins?.error)}`,
          );
        }
      } catch (e) {
        failed += 1;
        log(TAG, `snap-back host=${hostPage} error: ${e.message}`);
      }
    }
  }

  log(
    TAG,
    `sync enabled=${enabled} scan=${scanPages.length} targets=${targetPages.length} inserted=${inserted} failed=${failed} removed=${removed}`,
  );

  return {targetPages, removed, inserted, failed};
}
