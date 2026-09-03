/**
 * OCR a Title's handwriting via controlTrailNums → strokes → recognizeElements.
 */

import {PluginCommAPI, PluginFileAPI, PluginManager} from 'sn-plugin-lib';
import {log} from '../utils/debug';
import {toHostPageIndex} from '../utils/pageIndex';

const TAG = 'OCR';
const TYPE_STROKE = 0;

const A5X_EMR_MAX_X = 15819;
const A5X_EMR_MAX_Y = 11864;
const MANTA_PAGE_SIZE = {width: 1920, height: 2560};

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

/**
 * Resolve pixel page size for recognition mapping.
 */
export async function resolvePageSize(notePath, pageNum) {
  let pageSize = {width: 1404, height: 1872};

  if (typeof PluginCommAPI.getPageDisplaySize === 'function') {
    try {
      const ds = await withTimeout(
        PluginCommAPI.getPageDisplaySize(),
        3000,
        'getPageDisplaySize',
      );
      const size = ds?.result?.width ? ds.result : ds;
      if (size?.width && size?.height) {
        pageSize = {width: size.width, height: size.height};
        log(TAG, `pageDisplaySize ${pageSize.width}x${pageSize.height}`);
        return pageSize;
      }
    } catch (e) {
      log(TAG, `getPageDisplaySize failed: ${e.message}`);
    }
  }

  if (notePath) {
    try {
      const hostPage = toHostPageIndex(pageNum);
      const ps = await withTimeout(
        PluginFileAPI.getPageSize(notePath, hostPage),
        5000,
        'getPageSize',
      );
      if (ps?.result?.width) pageSize = ps.result;
      else if (ps?.width) pageSize = ps;
      log(TAG, `getPageSize ${pageSize.width}x${pageSize.height}`);
    } catch (e) {
      log(TAG, `getPageSize failed: ${e.message}`);
    }
  }

  return pageSize;
}

function recognitionSizeForStrokes(strokes, pageSize) {
  let emrMaxX = 0;
  let emrMaxY = 0;
  for (const el of strokes) {
    if (el.maxX !== undefined && el.maxX > emrMaxX) emrMaxX = el.maxX;
    if (el.maxY !== undefined && el.maxY > emrMaxY) emrMaxY = el.maxY;
  }

  if (emrMaxX > A5X_EMR_MAX_X || emrMaxY > A5X_EMR_MAX_Y) {
    const isPortrait = pageSize.width <= pageSize.height;
    return isPortrait
      ? MANTA_PAGE_SIZE
      : {width: MANTA_PAGE_SIZE.height, height: MANTA_PAGE_SIZE.width};
  }
  return pageSize;
}

/**
 * Load page elements once; cache by page for batch OCR.
 */
export function createElementCache(notePath) {
  const cache = new Map();
  return {
    async get(page) {
      const hostPage = toHostPageIndex(page);
      if (cache.has(hostPage)) return cache.get(hostPage);
      const res = await withTimeout(
        PluginFileAPI.getElements(hostPage, notePath),
        15000,
        `getElements(${hostPage})`,
      );
      const els = res?.success && Array.isArray(res.result) ? res.result : [];
      cache.set(hostPage, els);
      return els;
    },
  };
}

function strokesForTitle(elements, controlTrailNums) {
  const want = new Set(
    (controlTrailNums || []).map(n => Number(n)).filter(n => Number.isFinite(n)),
  );
  if (want.size === 0) return [];
  return elements.filter(
    el => el?.type === TYPE_STROKE && want.has(Number(el.numInPage)),
  );
}

function cleanTitle(text) {
  return String(text || 'Untitled')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\r\n]+/g, ' ');
}

/**
 * @returns {Promise<string>} recognized title text or 'Untitled'
 */
export async function ocrTitle(title, elementCache, pageSize) {
  try {
    if (title?.text && String(title.text).trim()) {
      return cleanTitle(title.text);
    }

    const elements = await elementCache.get(title.page);
    const strokes = strokesForTitle(elements, title.controlTrailNums);
    if (strokes.length === 0) {
      log(
        TAG,
        `page=${title.page} no strokes for trails=${JSON.stringify(title.controlTrailNums)}`,
      );
      return 'Untitled';
    }

    const size = recognitionSizeForStrokes(strokes, pageSize);
    const recognized = await withTimeout(
      PluginCommAPI.recognizeElements(strokes, size),
      30000,
      'recognizeElements',
    );

    if (recognized?.success && typeof recognized.result === 'string') {
      const text = recognized.result.replace(/\s+/g, ' ').trim();
      if (text) return text;
    }

    log(
      TAG,
      `OCR failed page=${title.page}: ${JSON.stringify(recognized?.error || recognized)}`,
    );
    return 'Untitled';
  } catch (e) {
    log(TAG, `OCR error page=${title.page}: ${e.message}`);
    return 'Untitled';
  }
}

/**
 * OCR all titles; calls onProgress(i, total) after each.
 * @returns {Promise<Array<title & {text: string}>>}
 */
export async function ocrAllTitles(titles, notePath, pageSize, onProgress) {
  try {
    const deviceType = await withTimeout(
      PluginManager.getDeviceType(),
      3000,
      'getDeviceType',
    );
    log(TAG, `deviceType=${JSON.stringify(deviceType)}`);
  } catch {
    // optional
  }

  const cache = createElementCache(notePath);
  const out = [];
  const total = titles.length;

  for (let i = 0; i < total; i++) {
    const title = titles[i];
    const text = await ocrTitle(title, cache, pageSize);
    out.push({...title, text});
    log(TAG, `Recognized ${i + 1}/${total}: "${text}"`);
    if (typeof onProgress === 'function') onProgress(i + 1, total, text);
  }

  return out;
}
