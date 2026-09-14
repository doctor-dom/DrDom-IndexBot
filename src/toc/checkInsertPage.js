/**
 * Preflight: detect refresh vs initial; first run works from any page.
 */

import {PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';
import {log} from '../utils/debug';
import {
  filePageToHost,
  filePageIndices,
  toHostPageIndex,
} from '../utils/pageIndex';
import {
  analyzeIndexBotTocPage,
  isPageBlankAfterIndexBot,
} from './tocMarkers';

const TAG = 'Preflight';
const DEFAULT_TOC_HOST_PAGE = 1;
const MAX_TOC_PROBE = 4;

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

async function getPageElements(notePath, filePage) {
  const res = await withTimeout(
    PluginFileAPI.getElements(filePage, notePath),
    15000,
    `getElements(detect file=${filePage})`,
  );
  if (!res?.success || !Array.isArray(res.result)) {
    return null;
  }
  return res.result;
}

function probeFilePages(pageCount) {
  const pages = filePageIndices(Math.min(Math.max(1, pageCount), MAX_TOC_PROBE));
  if (!pages.length) return [0];
  return pages;
}

/**
 * Scan early file pages for IndexBot ToC markers.
 * @returns {{ found: boolean, filePage: number|null, hostPage: number|null, hasHeader: boolean, orphanLinksOnly: boolean }}
 */
export async function detectExistingToc(notePath, pageCount = 2) {
  for (const filePage of probeFilePages(pageCount)) {
    try {
      const elements = await getPageElements(notePath, filePage);
      if (!elements) continue;
      const info = analyzeIndexBotTocPage(elements);
      if (info.found) {
        const hostPage = filePageToHost(filePage);
        log(
          TAG,
          `detectExistingToc file=${filePage} host=${hostPage} header=${info.hasHeader} orphanLinks=${info.orphanLinksOnly} links=${info.linkCount}`,
        );
        return {
          found: true,
          filePage,
          hostPage,
          hasHeader: info.hasHeader,
          orphanLinksOnly: info.orphanLinksOnly,
          linkCount: info.linkCount,
        };
      }
    } catch (e) {
      log(TAG, `detectExistingToc file=${filePage} failed: ${e.message}`);
    }
  }
  log(TAG, 'detectExistingToc not found on early pages');
  return {
    found: false,
    filePage: null,
    hostPage: null,
    hasHeader: false,
    orphanLinksOnly: false,
    linkCount: 0,
  };
}

async function page1LooksBlank(notePath, pageCount) {
  const filePage0 = 0;
  try {
    const elements = await getPageElements(notePath, filePage0);
    if (!elements) return true;
    if (analyzeIndexBotTocPage(elements).found) return false;
    return isPageBlankAfterIndexBot(elements);
  } catch (e) {
    log(TAG, `page blank check failed: ${e.message}`);
    return false;
  }
}

export async function checkInsertPage() {
  try {
    const fp = await withTimeout(
      PluginCommAPI.getCurrentFilePath(),
      5000,
      'getCurrentFilePath',
    );
    const notePath = fp?.result || fp;
    if (!notePath || typeof notePath !== 'string') {
      return {
        ready: false,
        mode: 'initial',
        hasExistingToc: false,
        currentPage: 1,
        isBlank: false,
        notePath: '',
        message: 'Open a NOTE file first.',
      };
    }

    const pn = await withTimeout(
      PluginCommAPI.getCurrentPageNum(),
      5000,
      'getCurrentPageNum',
    );
    const currentPage = toHostPageIndex(pn?.result ?? pn);

    let pageCount = 1;
    try {
      const totalRes = await withTimeout(
        PluginFileAPI.getNoteTotalPageNum(notePath),
        8000,
        'getNoteTotalPageNum',
      );
      pageCount = toHostPageIndex(totalRes?.result ?? totalRes ?? 1);
    } catch {
      // keep default
    }

    const tocDetect = await detectExistingToc(notePath, pageCount);

    if (tocDetect.found) {
      const headerOnly =
        tocDetect.hasHeader &&
        (tocDetect.linkCount ?? 0) === 0 &&
        !tocDetect.orphanLinksOnly;
      const msg = tocDetect.orphanLinksOnly
        ? 'Ready — will rebuild ToC on page 1 (orphan links detected)'
        : headerOnly
          ? 'Ready — will rebuild incomplete ToC on page 1'
          : 'Ready — will refresh ToC on page 1';
      return {
        ready: true,
        mode: 'refresh',
        hasExistingToc: true,
        detectedTocFilePage: tocDetect.filePage,
        detectedTocHostPage: tocDetect.hostPage ?? DEFAULT_TOC_HOST_PAGE,
        orphanLinksOnly: tocDetect.orphanLinksOnly,
        currentPage,
        isBlank: false,
        notePath,
        pageCount,
        message: msg,
      };
    }

    const isBlank = await page1LooksBlank(notePath, pageCount);
    const message = isBlank
      ? 'Ready — ToC will be written on page 1'
      : 'Ready — a blank page 1 will be added automatically for the ToC';

    return {
      ready: true,
      mode: 'initial',
      hasExistingToc: false,
      detectedTocFilePage: null,
      detectedTocHostPage: DEFAULT_TOC_HOST_PAGE,
      orphanLinksOnly: false,
      currentPage,
      isBlank,
      notePath,
      pageCount,
      message,
    };
  } catch (e) {
    log(TAG, `checkInsertPage error: ${e.message}`);
    return {
      ready: false,
      mode: 'initial',
      hasExistingToc: false,
      currentPage: 1,
      isBlank: false,
      notePath: '',
      message: e.message || 'Could not check page.',
    };
  }
}

export function assertInsertPageReady(checkResult) {
  if (!checkResult?.notePath) {
    throw new Error('Could not get current note path. Open a NOTE file first.');
  }
  if (!checkResult.ready && checkResult.mode !== 'refresh') {
    throw new Error(checkResult.message || 'Could not prepare note for ToC.');
  }
  return checkResult;
}
