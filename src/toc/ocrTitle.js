/**
 * OCR title handwriting: stroke-trail lasso → title-box lasso → file-stroke fallback.
 * Lasso rects are always pixel space (EMR bounds converted via PointUtils).
 */

import {
  PluginCommAPI,
  PluginFileAPI,
  PluginManager,
  PointUtils,
} from 'sn-plugin-lib';
import {log} from '../utils/debug';
import {toFilePageIndex, toHostPageIndex} from '../utils/pageIndex';

const TAG = 'OCR';
const TYPE_STROKE = 0;
const RECT_PAD = 20;
const JUMP_SETTLE_MS = 200;

const A5X_EMR_MAX_X = 15819;
const A5X_EMR_MAX_Y = 11864;
const MANTA_PAGE_SIZE = {width: 1920, height: 2560};
const DEFAULT_EMR_WORD_W = 6000;
const DEFAULT_EMR_WORD_H = 1500;

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

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
      const filePage = toFilePageIndex(pageNum);
      const ps = await withTimeout(
        PluginFileAPI.getPageSize(notePath, filePage),
        5000,
        'getPageSize',
      );
      if (ps?.result?.width) pageSize = ps.result;
      else if (ps?.width) pageSize = ps;
      log(TAG, `getPageSize file=${filePage} ${pageSize.width}x${pageSize.height}`);
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

function cleanTitle(text) {
  return String(text || 'Untitled')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\r\n]+/g, ' ');
}

function titleBounds(title) {
  return {
    x: Number(title.x ?? title.X ?? 0),
    y: Number(title.y ?? title.Y ?? 0),
    w: Number(title.width ?? 0),
    h: Number(title.height ?? 0),
  };
}

function coordsLookEmr(x, y, w, h, pageSize) {
  return (
    x > pageSize.width ||
    y > pageSize.height ||
    w > pageSize.width ||
    h > pageSize.height
  );
}

function clampPixelRect(rect, pageSize) {
  if (!rect) return null;
  const left = Math.max(0, Math.round(rect.left));
  const top = Math.max(0, Math.round(rect.top));
  const right = Math.min(pageSize.width, Math.round(rect.right));
  const bottom = Math.min(pageSize.height, Math.round(rect.bottom));
  if (right <= left || bottom <= top) return null;
  return {left, top, right, bottom};
}

function padPixelRect(rect, pad, pageSize) {
  if (!rect) return null;
  return clampPixelRect(
    {
      left: rect.left - pad,
      top: rect.top - pad,
      right: rect.right + pad,
      bottom: rect.bottom + pad,
    },
    pageSize,
  );
}

function emrBoundsToPixelRect(x, y, w, h, pageSize) {
  try {
    const tl = PointUtils.emrPoint2Android({x, y}, pageSize);
    const br = PointUtils.emrPoint2Android({x: x + w, y: y + h}, pageSize);
    return clampPixelRect(
      {
        left: Math.min(tl.x, br.x),
        top: Math.min(tl.y, br.y),
        right: Math.max(tl.x, br.x),
        bottom: Math.max(tl.y, br.y),
      },
      pageSize,
    );
  } catch (e) {
    log(TAG, `emrBoundsToPixelRect failed: ${e.message}`);
    return null;
  }
}

function emrPointToPixel(x, y, pageSize) {
  try {
    return PointUtils.emrPoint2Android({x, y}, pageSize);
  } catch {
    return null;
  }
}

function unionRects(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

function recognizeResultPixelRect(rr, pageSize) {
  if (!rr || typeof rr !== 'object') return null;
  const left = Number(rr.up_left_point_x ?? 0);
  const top = Number(rr.up_left_point_y ?? 0);
  const right = Number(rr.down_right_point_x ?? 0);
  const bottom = Number(rr.down_right_point_y ?? 0);
  if (right <= left || bottom <= top) return null;
  return clampPixelRect({left, top, right, bottom}, pageSize);
}

/**
 * Title metadata → pixel lasso rect (auto EMR vs pixel detection).
 */
function pixelRectFromTitle(title, pageSize, pad = RECT_PAD) {
  const {x, y, w: rawW, h: rawH} = titleBounds(title);
  let w = rawW;
  let h = rawH;
  const space = coordsLookEmr(x, y, w, h, pageSize) ? 'emr' : 'pixel';

  if (space === 'emr') {
    if (w < 100) w = DEFAULT_EMR_WORD_W;
    if (h < 100) h = DEFAULT_EMR_WORD_H;
    const rect = emrBoundsToPixelRect(x, y, w, h, pageSize);
    return rect ? {rect: padPixelRect(rect, pad, pageSize), space} : {rect: null, space};
  }

  if (w < 8) w = Math.min(400, pageSize.width - x - pad);
  if (h < 8) h = Math.min(80, pageSize.height - y - pad);
  const rect = clampPixelRect(
    {left: x, top: y, right: x + w, bottom: y + h},
    pageSize,
  );
  return {rect: padPixelRect(rect, pad, pageSize), space};
}

function strokeEmrEstimateRect(stroke, title) {
  const mx = Number(stroke.maxX ?? 0);
  const my = Number(stroke.maxY ?? 0);
  if (mx <= 0 && my <= 0) return null;

  let w = Number(title?.width ?? 0);
  let h = Number(title?.height ?? 0);
  if (w < 100) w = DEFAULT_EMR_WORD_W;
  if (h < 100) h = DEFAULT_EMR_WORD_H;

  return {x: mx - w, y: my - h, w, h};
}

/**
 * Build pixel lasso rect from controlTrailNums strokes (primary OCR target).
 */
function pixelRectFromStrokes(strokes, title, pageSize) {
  if (!strokes.length) return null;

  let union = null;
  const titleInfo = pixelRectFromTitle(title, pageSize, 0);
  union = unionRects(union, titleInfo.rect);

  for (const stroke of strokes) {
    const rrRect = recognizeResultPixelRect(stroke.recognizeResult, pageSize);
    union = unionRects(union, rrRect);

    const mx = Number(stroke.maxX ?? 0);
    const my = Number(stroke.maxY ?? 0);
    if (mx > pageSize.width || my > pageSize.height) {
      const emrBox = strokeEmrEstimateRect(stroke, title);
      if (emrBox) {
        union = unionRects(
          union,
          emrBoundsToPixelRect(emrBox.x, emrBox.y, emrBox.w, emrBox.h, pageSize),
        );
      }
    } else if (mx > 0 || my > 0) {
      const pt = emrPointToPixel(mx, my, pageSize);
      if (pt) {
        union = unionRects(
          union,
          clampPixelRect(
            {left: pt.x - 60, top: pt.y - 30, right: pt.x + 60, bottom: pt.y + 30},
            pageSize,
          ),
        );
      }
    }
  }

  return padPixelRect(union, RECT_PAD, pageSize);
}

function strokeOverlapsPixelRect(el, pixelRect, pageSize) {
  if (!pixelRect || el?.type !== TYPE_STROKE) return false;

  const rrRect = recognizeResultPixelRect(el.recognizeResult, pageSize);
  if (rrRect) {
    return !(
      rrRect.right < pixelRect.left ||
      rrRect.left > pixelRect.right ||
      rrRect.bottom < pixelRect.top ||
      rrRect.top > pixelRect.bottom
    );
  }

  const mx = Number(el.maxX ?? 0);
  const my = Number(el.maxY ?? 0);
  if (mx <= 0 && my <= 0) return false;

  let px;
  let py;
  if (mx > pageSize.width || my > pageSize.height) {
    const pt = emrPointToPixel(mx, my, pageSize);
    if (!pt) return false;
    px = pt.x;
    py = pt.y;
  } else {
    px = mx;
    py = my;
  }

  return (
    px >= pixelRect.left &&
    px <= pixelRect.right &&
    py >= pixelRect.top &&
    py <= pixelRect.bottom
  );
}

function strokesForTitle(elements, controlTrailNums, pixelRect, pageSize) {
  const trails = (controlTrailNums || [])
    .map(n => Number(n))
    .filter(n => Number.isFinite(n));
  const strokes = elements.filter(el => el?.type === TYPE_STROKE);
  if (trails.length === 0 && !pixelRect) return [];

  const want = new Set(trails);
  const wantAlt = new Set();
  for (const n of trails) {
    wantAlt.add(n);
    wantAlt.add(n - 1);
    wantAlt.add(n + 1);
  }

  const byTrail = strokes.filter(el => {
    const num = Number(el.numInPage);
    return want.has(num) || wantAlt.has(num);
  });
  if (byTrail.length > 0) return byTrail;

  if (pixelRect) {
    const byGeom = strokes.filter(el =>
      strokeOverlapsPixelRect(el, pixelRect, pageSize),
    );
    if (byGeom.length > 0) return byGeom;
  }

  return [];
}

async function recognizeStrokeElements(strokes, pageSize, label) {
  if (!strokes.length) return {text: '', reason: 'no strokes'};
  const size = recognitionSizeForStrokes(strokes, pageSize);
  const recognized = await withTimeout(
    PluginCommAPI.recognizeElements(strokes, size),
    30000,
    `recognizeElements(${label})`,
  );
  if (recognized?.success && typeof recognized.result === 'string') {
    const text = recognized.result.replace(/\s+/g, ' ').trim();
    if (text) return {text, reason: 'ok'};
  }
  const code = recognized?.error?.code ?? '?';
  const msg =
    recognized?.error?.message ??
    JSON.stringify(recognized?.error || recognized);
  return {text: '', reason: `recognize failed code=${code} ${msg}`};
}

async function jumpToPageIfAvailable(page, settle = false) {
  if (typeof PluginCommAPI.jumpToPage !== 'function') return false;
  const hostPage = toHostPageIndex(page);
  try {
    const res = await withTimeout(
      PluginCommAPI.jumpToPage(hostPage),
      8000,
      `jumpToPage(${hostPage})`,
    );
    const ok = res?.success !== false;
    log(TAG, `jumpToPage(${hostPage}) ok=${ok}`);
    if (ok && settle) await sleep(JUMP_SETTLE_MS);
    return ok;
  } catch (e) {
    log(TAG, `jumpToPage(${hostPage}) failed: ${e.message}`);
    return false;
  }
}

async function ocrViaLassoRect(rect, pageSize, label) {
  if (!rect) return {text: '', reason: 'invalid lasso rect'};

  if (typeof PluginCommAPI.lassoElements !== 'function') {
    return {text: '', reason: 'lassoElements unavailable'};
  }

  log(
    TAG,
    `lasso ${label} rect L${rect.left} T${rect.top} R${rect.right} B${rect.bottom}`,
  );

  const lassoRes = await withTimeout(
    PluginCommAPI.lassoElements(rect),
    10000,
    'lassoElements',
  );
  if (lassoRes?.success === false) {
    return {
      text: '',
      reason: `lasso failed: ${lassoRes?.error?.message || 'unknown'}`,
    };
  }

  const lassoEls = await withTimeout(
    PluginCommAPI.getLassoElements(),
    10000,
    'getLassoElements',
  );
  const elements =
    lassoEls?.success && Array.isArray(lassoEls.result) ? lassoEls.result : [];
  const supported = elements.filter(
    el => el?.type === TYPE_STROKE || el?.type === 500,
  );
  log(TAG, `lasso ${label} selected=${elements.length} supported=${supported.length}`);
  if (supported.length === 0) {
    return {text: '', reason: 'lasso selection empty'};
  }

  return recognizeStrokeElements(supported, pageSize, label);
}

async function ocrViaStrokeTrailLasso(title, elementCache, pageSize) {
  const elements = await elementCache.get(title.page);
  const titleInfo = pixelRectFromTitle(title, pageSize, 0);
  const strokes = strokesForTitle(
    elements,
    title.controlTrailNums,
    titleInfo.rect,
    pageSize,
  );
  if (strokes.length === 0) {
    return {
      text: '',
      reason: `no strokes for trails=${JSON.stringify(title.controlTrailNums)}`,
    };
  }

  const rect = pixelRectFromStrokes(strokes, title, pageSize);
  if (!rect) {
    return {text: '', reason: 'stroke-trail rect invalid'};
  }

  return ocrViaLassoRect(rect, pageSize, 'stroke-trail');
}

async function ocrViaTitleBoxLasso(title, pageSize) {
  const {x, y, w, h} = titleBounds(title);
  const titleInfo = pixelRectFromTitle(title, pageSize);
  log(
    TAG,
    `title box page=${title.page} raw=(${x},${y},${w},${h}) space=${titleInfo.space}`,
  );
  return ocrViaLassoRect(titleInfo.rect, pageSize, 'title-box');
}

/**
 * Load page elements; try host page and page-1 for API index quirks.
 */
export function createElementCache(notePath) {
  const cache = new Map();

  async function loadPage(hostPage) {
    const key = toHostPageIndex(hostPage);
    if (cache.has(key)) return cache.get(key);

    const filePage = toFilePageIndex(key);
    const res = await withTimeout(
      PluginFileAPI.getElements(filePage, notePath),
      15000,
      `getElements(file=${filePage})`,
    );
    const merged =
      res?.success && Array.isArray(res.result) ? res.result : [];
    log(TAG, `getElements file=${filePage} host=${key} count=${merged.length}`);
    cache.set(key, merged);
    return merged;
  }

  return {get: loadPage};
}

async function ocrViaFileStrokes(title, elementCache, pageSize) {
  const elements = await elementCache.get(title.page);
  const titleInfo = pixelRectFromTitle(title, pageSize, 0);
  const strokes = strokesForTitle(
    elements,
    title.controlTrailNums,
    titleInfo.rect,
    pageSize,
  );
  if (strokes.length === 0) {
    return {
      text: '',
      reason: `no file strokes trails=${JSON.stringify(title.controlTrailNums)} pageEls=${elements.length}`,
    };
  }
  log(
    TAG,
    `file-stroke fallback page=${title.page} strokes=${strokes.length} trails=${JSON.stringify(title.controlTrailNums)}`,
  );
  return recognizeStrokeElements(strokes, pageSize, 'file');
}

/**
 * @returns {Promise<string>}
 */
export async function ocrTitle(title, ctx) {
  try {
    if (title?.text && String(title.text).trim()) {
      return cleanTitle(title.text);
    }

    const pageSize =
      ctx.pageSizeByPage?.get(toHostPageIndex(title.page)) ||
      ctx.defaultPageSize ||
      (await resolvePageSize(ctx.notePath, title.page));

    const hostPage = toHostPageIndex(title.page);
    const onPage = ctx.currentOcrPage === hostPage;

    if (onPage || (await jumpToPageIfAvailable(title.page, true))) {
      ctx.currentOcrPage = hostPage;

      const trail = await ocrViaStrokeTrailLasso(title, ctx.elementCache, pageSize);
      if (trail.text) {
        log(TAG, `stroke-trail OCR page=${title.page}: "${trail.text}"`);
        return trail.text;
      }
      log(TAG, `stroke-trail OCR page=${title.page} ${trail.reason}`);

      const box = await ocrViaTitleBoxLasso(title, pageSize);
      if (box.text) {
        log(TAG, `title-box OCR page=${title.page}: "${box.text}"`);
        return box.text;
      }
      log(TAG, `title-box OCR page=${title.page} ${box.reason}`);
    }

    const file = await ocrViaFileStrokes(title, ctx.elementCache, pageSize);
    if (file.text) {
      log(TAG, `file OCR page=${title.page}: "${file.text}"`);
      return file.text;
    }
    log(TAG, `OCR page=${title.page} untitled: ${file.reason}`);
    return 'Untitled';
  } catch (e) {
    log(TAG, `OCR error page=${title.page}: ${e.message}`);
    return 'Untitled';
  }
}

function groupTitlesByPage(titles) {
  const map = new Map();
  for (const t of titles) {
    const p = toHostPageIndex(t.page);
    if (!map.has(p)) map.set(p, []);
    map.get(p).push(t);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}

/**
 * OCR all titles grouped by page; calls onProgress(i, total, text) after each.
 */
export async function ocrAllTitles(
  titles,
  notePath,
  defaultPageSize,
  onProgress,
  shouldCancel,
  startPage = 1,
) {
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
  const pageSizeByPage = new Map();
  const grouped = groupTitlesByPage(titles);
  for (const [page] of grouped) {
    pageSizeByPage.set(page, await resolvePageSize(notePath, page));
  }

  const ctx = {
    notePath,
    elementCache: cache,
    defaultPageSize,
    pageSizeByPage,
    currentOcrPage: toHostPageIndex(startPage),
  };

  const out = [];
  const total = titles.length;
  let done = 0;

  for (const [page, pageTitles] of grouped) {
    if (typeof shouldCancel === 'function' && shouldCancel()) {
      const err = new Error('Cancelled');
      err.code = 'CANCELLED';
      throw err;
    }

    const jumped = await jumpToPageIfAvailable(page, true);
    if (jumped) ctx.currentOcrPage = page;
    log(TAG, `OCR batch page=${page} titles=${pageTitles.length} jumped=${jumped}`);

    for (const title of pageTitles) {
      if (typeof shouldCancel === 'function' && shouldCancel()) {
        const err = new Error('Cancelled');
        err.code = 'CANCELLED';
        throw err;
      }
      const text = await ocrTitle(title, ctx);
      out.push({...title, text});
      done += 1;
      log(TAG, `Recognized ${done}/${total}: "${text}"`);
      if (typeof onProgress === 'function') onProgress(done, total, text);
    }
  }

  if (startPage && startPage !== ctx.currentOcrPage) {
    await jumpToPageIfAvailable(startPage);
  }

  return out;
}
