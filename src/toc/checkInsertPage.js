/**
 * Preflight: first-run requires page 1 blank; refresh allows any page.
 */

import {PluginCommAPI, PluginFileAPI} from 'sn-plugin-lib';
import {log} from '../utils/debug';
import {toHostPageIndex} from '../utils/pageIndex';
import {isPageBlankAfterIndexBot, pageHasIndexBotToc} from './tocMarkers';

const TAG = 'Preflight';
const TOC_PAGE = 1;

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

export async function detectExistingToc(notePath) {
  const page = toHostPageIndex(TOC_PAGE);
  const res = await withTimeout(
    PluginFileAPI.getElements(page, notePath),
    15000,
    'getElements(detectToc)',
  );
  if (!res?.success || !Array.isArray(res.result)) {
    log(TAG, `detectExistingToc failed: ${JSON.stringify(res?.error)}`);
    return false;
  }
  return pageHasIndexBotToc(res.result);
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
        isPage1: false,
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
    const hasExistingToc = await detectExistingToc(notePath);

    if (hasExistingToc) {
      return {
        ready: true,
        mode: 'refresh',
        hasExistingToc: true,
        currentPage,
        isPage1: currentPage === TOC_PAGE,
        isBlank: false,
        notePath,
        message: 'Ready — will refresh ToC on page 1',
      };
    }

    const pageRes = await withTimeout(
      PluginFileAPI.getElements(TOC_PAGE, notePath),
      15000,
      'getElements(page1)',
    );
    const elements =
      pageRes?.success && Array.isArray(pageRes.result) ? pageRes.result : [];
    const isPage1 = currentPage === TOC_PAGE;
    const isBlank = isPageBlankAfterIndexBot(elements);

    let message = '';
    let ready = false;
    if (!isPage1) {
      message = `You are on page ${currentPage}. Go to page 1 first.`;
    } else if (!isBlank) {
      message = 'Page 1 has content. Clear it or use a blank page.';
    } else {
      message = 'Ready — page 1 is blank';
      ready = true;
    }

    return {
      ready,
      mode: 'initial',
      hasExistingToc: false,
      currentPage,
      isPage1,
      isBlank,
      notePath,
      message,
    };
  } catch (e) {
    log(TAG, `checkInsertPage error: ${e.message}`);
    return {
      ready: false,
      mode: 'initial',
      hasExistingToc: false,
      currentPage: 1,
      isPage1: false,
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
  if (checkResult.mode === 'refresh') {
    return checkResult;
  }
  if (!checkResult.isPage1) {
    throw new Error(
      `You are on page ${checkResult.currentPage}. Go to page 1 first.`,
    );
  }
  if (!checkResult.isBlank) {
    throw new Error('Page 1 has content. Clear it or use a blank page.');
  }
  return checkResult;
}
