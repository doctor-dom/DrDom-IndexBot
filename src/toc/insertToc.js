/**
 * Strip previous IndexBot ToC and insert per-row text + tappable leader links.
 *
 * Layout modes: outline, compact, numbered, flat (no page numbers).
 * Title in editable text box; leader dots + → share one insertTextLink rect.
 */

import {PluginCommAPI, PluginFileAPI, PluginNoteAPI} from 'sn-plugin-lib';
import {log} from '../utils/debug';
import {toFilePageIndex, toHostPageIndex} from '../utils/pageIndex';
import {normalizeLayout} from './layoutModes';
import {
  isIndexBotTocLink,
  LINK_SENTINEL,
  JUMP_SHOW,
  TOC_HEADER,
  INDEXBOT_USERDATA_TOC_HEADER,
  INDEXBOT_USERDATA_TOC_ROW,
  INDEXBOT_USERDATA_TOC_LINK,
  isIndexBotTocUserData,
  textBoxFirstLine,
  textBoxRect,
  linkRect,
  rectsOverlap,
  clusterBounds,
} from './tocMarkers';

export {LINK_SENTINEL, JUMP_SHOW, TOC_HEADER};

const TAG = 'Insert';

const TYPE_TEXT = 500;
const TYPE_LINK = 600;

const GUTTER = 32;

/** Page inset for TOC block (~5% width, min 80px). */
export function tocMargin(pageSize) {
  const w = pageSize?.width ?? 1404;
  return Math.max(80, Math.round(w * 0.05));
}

/** Horizontally center the ToC block (one or two columns) on the page. */
export function tocBlockOrigin(pageSize, blockW, columns = 1) {
  const pageW = pageSize?.width ?? 1404;
  const cols = Math.max(1, Number(columns) || 1);
  const totalW = blockW * cols + (cols > 1 ? GUTTER : 0);
  const minLeft = tocMargin(pageSize);
  const centered = Math.round((pageW - totalW) / 2);
  return Math.max(minLeft, centered);
}
const LINK_COL_W = 44;
const LINE_FACTOR = 1.2;
const CHAR_FACTOR = 0.55;
const BLOCK_MIN_FRAC = 0.4;
const BLOCK_MAX_FRAC = 0.88;
const FONT_SCALE_SHRINK = 0.75;
const INDENT_PX = 16;
const MIN_DOTS = 2;
const MAX_DOTS = 12;

const OUTLINE_BULLETS = ['', '• ', '◦ ', '- '];

const FONTS_BASE = {
  header: 36,
  h1: 28,
  h2: 26,
  h3: 24,
  h4: 22,
};

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

function lineHeight(fontSize) {
  return Math.ceil(fontSize * LINE_FACTOR);
}

function displayLevel(heading, layout) {
  if (layout === 'flat') return 0;
  return Math.max(0, Number(heading?.indentLevel) || 0);
}

function fontForHeading(heading, fonts, layout) {
  const level = displayLevel(heading, layout);
  if (level <= 0) return fonts.h1;
  if (level === 1) return fonts.h2;
  if (level === 2) return fonts.h3;
  return fonts.h4;
}

function scaleFonts(base, factor) {
  return {
    header: Math.max(18, Math.round(base.header * factor)),
    h1: Math.max(16, Math.round(base.h1 * factor)),
    h2: Math.max(14, Math.round(base.h2 * factor)),
    h3: Math.max(12, Math.round(base.h3 * factor)),
    h4: Math.max(12, Math.round(base.h4 * factor)),
  };
}

function spaceIndent(level) {
  return '  '.repeat(Math.max(0, Number(level) || 0));
}

function createNumberingState() {
  const counters = [0, 0, 0, 0];
  return {
    next(level) {
      const depth = Math.min(3, Math.max(0, level));
      counters[depth] += 1;
      for (let i = depth + 1; i < counters.length; i++) counters[i] = 0;
      return counters.slice(0, depth + 1).join('.') + '.';
    },
  };
}

function buildTitlePrefix(heading, layout, numbering) {
  const level = displayLevel(heading, layout);
  const spaces = layout === 'flat' ? '' : spaceIndent(level);

  if (layout === 'outline') {
    const bullet = OUTLINE_BULLETS[level] || '';
    return `${spaces}${bullet}`;
  }
  if (layout === 'numbered') {
    return `${spaces}${numbering.next(level)} `;
  }
  if (layout === 'compact') {
    return spaces;
  }
  return '';
}

function cleanTitle(text) {
  return String(text || 'Untitled')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\r\n]+/g, ' ');
}

function truncateToWidth(text, fontSize, maxWidth) {
  let s = cleanTitle(text);
  if (estimateTextWidth(s, fontSize) <= maxWidth) return s;
  while (s.length > 1 && estimateTextWidth(`${s}…`, fontSize) > maxWidth) {
    s = s.slice(0, -1);
  }
  return `${s}…`;
}

function rowLeftOffset(baseLeft, heading, layout) {
  if (layout === 'flat') return baseLeft;
  const level = displayLevel(heading, layout);
  return baseLeft + level * INDENT_PX;
}

function buildRowParts(heading, fonts, layout, numbering, rowLeft, linkRight) {
  const fs = fontForHeading(heading, fonts, layout);
  const level = displayLevel(heading, layout);
  const prefix = buildTitlePrefix(heading, layout, numbering);
  const prefixW = estimateTextWidth(prefix, fs);

  const leaderReserve = Math.max(
    estimateTextWidth(`${'.'.repeat(MAX_DOTS)} ${JUMP_SHOW}`, fs),
    LINK_COL_W,
  );
  const linkLeft = Math.max(rowLeft + fs * 2, linkRight - leaderReserve);
  const titleMaxW = Math.max(fs * 2, linkLeft - rowLeft - 4 - prefixW);
  const title = truncateToWidth(heading.text, fs, titleMaxW);
  const titleText = `${prefix}${title}`;
  const titleW = estimateTextWidth(titleText, fs);

  const leaderBudget = Math.max(fs, linkRight - rowLeft - titleW);
  const dotW = estimateTextWidth('.', fs) || fs * CHAR_FACTOR;
  let dots = Math.floor(leaderBudget / dotW);
  dots = Math.max(MIN_DOTS, Math.min(MAX_DOTS, dots));
  const leaderText = `${'.'.repeat(dots)} ${JUMP_SHOW}`;

  const textBold = layout === 'outline' && level === 0 ? 1 : 0;

  return {
    titleText,
    leaderText,
    fontSize: fs,
    height: lineHeight(fs),
    textBold,
    titleRight: linkLeft - 4,
    linkLeft,
  };
}

function samplePrefixForWidth(heading, layout, numbering) {
  return buildTitlePrefix(heading, layout, numbering);
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

function applyTextBox(el, filePage, text, rect, fontSize, textBold, userDataTag) {
  const fp = Math.max(0, Math.floor(Number(filePage) || 0));
  el.type = TYPE_TEXT;
  el.pageNum = fp;
  el.layerNum = 0;
  el.textBox = {
    fontSize,
    textContentFull: text,
    textRect: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      right: Math.round(rect.right),
      bottom: Math.round(rect.bottom),
    },
    textAlign: 0,
    textBold: textBold ? 1 : 0,
    textItalics: 0,
    textFrameWidthType: 0,
    textFrameStyle: 0,
    textEditable: 0,
  };
  if (userDataTag) {
    el.userData = userDataTag;
  }
  return el;
}

function applyLink(
  el,
  filePage,
  notePath,
  destHostPage,
  rect,
  fontSize,
  fullText,
  showText,
  userDataTag = INDEXBOT_USERDATA_TOC_LINK,
) {
  const fp = Math.max(0, Math.floor(Number(filePage) || 0));
  el.type = TYPE_LINK;
  el.pageNum = fp;
  el.layerNum = 0;
  if (userDataTag) {
    el.userData = userDataTag;
  }
  const w = Math.round(rect.right - rect.left);
  const h = Math.round(rect.bottom - rect.top);
  if (w <= 0 || h <= 0) {
    throw new Error('ToC link rect has zero area');
  }
  el.link = {
    category: 0,
    X: Math.round(rect.left),
    Y: Math.round(rect.top),
    width: w,
    height: h,
    page: fp,
    style: 0,
    linkType: 0,
    destPath: notePath,
    destPage: toHostPageIndex(destHostPage),
    fontSize,
    fullText,
    showText,
    italic: 0,
  };
  return el;
}

function assertRowGeometry(rowLeft, linkRight, row, headingLabel) {
  if (!String(row?.titleText || '').trim()) {
    throw new Error(`Empty ToC row for "${headingLabel || 'heading'}"`);
  }
  if (row.titleRight <= rowLeft) {
    throw new Error(`Invalid title box for "${headingLabel || 'heading'}"`);
  }
  if (row.linkLeft >= linkRight || row.linkLeft < rowLeft) {
    throw new Error(`Invalid link box for "${headingLabel || 'heading'}"`);
  }
}

function computeBlockWidth(headings, fonts, pageWidth, layout, margin) {
  const fullW = pageWidth - margin * 2;
  const minW = Math.floor(pageWidth * BLOCK_MIN_FRAC);
  const maxW = Math.min(fullW, Math.floor(pageWidth * BLOCK_MAX_FRAC));
  const numbering = createNumberingState();
  let contentW = estimateTextWidth(TOC_HEADER, fonts.header);

  for (const h of headings) {
    const fs = fontForHeading(h, fonts, layout);
    const prefix = samplePrefixForWidth(h, layout, numbering);
    const title = cleanTitle(h.text);
    const level = displayLevel(h, layout);
    const rowLeft = margin + level * INDENT_PX;
    const w =
      rowLeft -
      margin +
      estimateTextWidth(prefix + title, fs) +
      estimateTextWidth(' .... →', fs) +
      LINK_COL_W;
    if (w > contentW) contentW = w;
  }

  return Math.max(minW, Math.min(maxW, Math.ceil(contentW + 16)));
}

function measureColumnHeight(headings, fonts, layout, includeHeader) {
  let h = 0;
  if (includeHeader) h += lineHeight(fonts.header);
  for (const heading of headings) {
    h += lineHeight(fontForHeading(heading, fonts, layout));
  }
  return h;
}

/**
 * Choose layout: 1-col full fonts → 1-col shrunk → 2-col shrunk → omit.
 */
export function planLayout(headings, pageSize, layoutMode) {
  const layout = normalizeLayout(layoutMode);
  const margin = tocMargin(pageSize);
  const availableH = Math.max(0, pageSize.height - margin * 2);
  const pageW = pageSize.width;

  const tryPlan = (fonts, columns) => {
    if (columns === 1) {
      const height = measureColumnHeight(headings, fonts, layout, true);
      const blockW = computeBlockWidth(headings, fonts, pageW, layout, margin);
      if (height <= availableH) {
        return {
          columns: 1,
          fonts,
          blockW,
          left: headings,
          right: [],
          omitted: 0,
          fits: true,
          layout,
        };
      }
      let used = lineHeight(fonts.header);
      const left = [];
      for (const h of headings) {
        const rowH = lineHeight(fontForHeading(h, fonts, layout));
        if (used + rowH > availableH) break;
        left.push(h);
        used += rowH;
      }
      return {
        columns: 1,
        fonts,
        blockW,
        left,
        right: [],
        omitted: headings.length - left.length,
        fits: left.length === headings.length,
        layout,
      };
    }

    const halfW = Math.floor((pageW - margin * 2 - GUTTER) / 2);
    const colMax = Math.min(Math.floor(pageW * BLOCK_MAX_FRAC), halfW);
    const colMin = Math.min(Math.floor(pageW * BLOCK_MIN_FRAC), colMax);

    const fillColumn = (list, includeHeader) => {
      let used = includeHeader ? lineHeight(fonts.header) : 0;
      const out = [];
      for (const h of list) {
        const rowH = lineHeight(fontForHeading(h, fonts, layout));
        if (used + rowH > availableH) break;
        out.push(h);
        used += rowH;
      }
      return out;
    };

    const left = fillColumn(headings, true);
    const rest = headings.slice(left.length);
    const right = fillColumn(rest, false);
    const omitted = headings.length - left.length - right.length;

    const blockW = Math.max(
      colMin,
      Math.min(
        colMax,
        computeBlockWidth(
          [...left, ...right].slice(0, 8) || headings,
          fonts,
          pageW,
          layout,
          margin,
        ),
      ),
    );

    return {
      columns: 2,
      fonts,
      blockW,
      left,
      right,
      omitted,
      fits: omitted === 0,
      layout,
    };
  };

  let plan = tryPlan(FONTS_BASE, 1);
  if (plan.fits) return plan;

  const shrunk = scaleFonts(FONTS_BASE, FONT_SCALE_SHRINK);
  plan = tryPlan(shrunk, 1);
  if (plan.fits) return plan;

  plan = tryPlan(shrunk, 2);
  return plan;
}

async function verifyTocOnPage(notePath, filePage, expectedLinks) {
  const res = await withTimeout(
    PluginFileAPI.getElements(filePage, notePath),
    15000,
    `getElements(verify file=${filePage})`,
  );
  if (!res?.success || !Array.isArray(res.result)) {
    throw new Error(
      `ToC verify failed: could not read page file=${filePage}`,
    );
  }

  let tocLinks = 0;
  let hasHeader = false;
  let headingTexts = 0;

  for (const el of res.result) {
    if (isIndexBotTocLink(el)) {
      tocLinks += 1;
      continue;
    }
    if (el?.type === TYPE_TEXT) {
      const first = textBoxFirstLine(el).trim();
      if (first === TOC_HEADER) {
        hasHeader = true;
      } else if (first && !first.includes('indexbot-toc')) {
        headingTexts += 1;
      }
    }
  }

  log(
    TAG,
    `verify file=${filePage} links=${tocLinks} headingTexts=${headingTexts} header=${hasHeader} expected=${expectedLinks}`,
  );

  if (expectedLinks > 0 && tocLinks === 0) {
    throw new Error(
      `ToC verify failed: 0 jump links on page (expected ${expectedLinks})`,
    );
  }
  if (expectedLinks > 0 && !hasHeader) {
    throw new Error('ToC verify failed: header missing after insert');
  }

  return {tocLinks, hasHeader, headingTexts};
}

async function stripPreviousToc(notePath, tocHostPage) {
  const filePage = toFilePageIndex(tocHostPage);
  const res = await withTimeout(
    PluginFileAPI.getElements(filePage, notePath),
    15000,
    `getElements(strip file=${filePage})`,
  );
  if (!res?.success || !Array.isArray(res.result)) {
    log(TAG, `strip getElements failed: ${JSON.stringify(res?.error)}`);
    return;
  }

  const linkRects = [];
  for (const el of res.result) {
    if (isIndexBotTocLink(el)) {
      const r = linkRect(el);
      if (r) linkRects.push(r);
    }
  }
  const cluster = clusterBounds(linkRects);

  const kept = [];
  let removed = 0;
  for (const el of res.result) {
    if (isIndexBotTocLink(el)) {
      removed += 1;
      continue;
    }
    if (el?.type === TYPE_TEXT) {
      if (isIndexBotTocUserData(el.userData)) {
        removed += 1;
        continue;
      }
      const first = textBoxFirstLine(el).trim();
      if (first === TOC_HEADER) {
        removed += 1;
        continue;
      }
      const content = el.textBox?.textContentFull || '';
      if (content.includes('indexbot-toc')) {
        removed += 1;
        continue;
      }
      const r = textBoxRect(el);
      if (cluster && r && rectsOverlap(r, cluster)) {
        removed += 1;
        continue;
      }
    }
    kept.push(el);
  }

  if (removed === 0) {
    log(TAG, 'No previous IndexBot ToC to remove');
    return;
  }

  log(TAG, `Removing ${removed} IndexBot ToC elements, keeping ${kept.length}`);
  const replace = await withTimeout(
    PluginFileAPI.replaceElements(notePath, filePage, kept),
    20000,
    `replaceElements(file=${filePage})`,
  );
  log(TAG, `replaceElements success=${replace?.success}`);
  if (!replace?.success) {
    throw new Error(
      `Failed to clear previous ToC: ${replace?.error?.message || 'unknown'}`,
    );
  }
}

async function buildColumnElements({
  headings,
  includeHeader,
  fonts,
  left,
  blockW,
  top,
  notePath,
  layout,
  tocFilePage,
  onProgress,
  rowOffset = 0,
  rowTotal = 0,
}) {
  const linkRight = left + blockW;
  const textRight = linkRight - LINK_COL_W - 6;
  let y = top;
  const numbering = createNumberingState();
  const elements = [];

  if (includeHeader) {
    const fs = fonts.header;
    const h = lineHeight(fs);
    const textEl = applyTextBox(
      await createSdkElement(TYPE_TEXT),
      tocFilePage,
      TOC_HEADER,
      {left, top: y, right: textRight, bottom: y + h},
      fs,
      true,
      INDEXBOT_USERDATA_TOC_HEADER,
    );
    elements.push(textEl);
    y += h;
  }

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    if (typeof onProgress === 'function' && rowTotal > 0) {
      onProgress(rowOffset + i + 1, rowTotal);
    }
    const rowLeft = rowLeftOffset(left, heading, layout);
    const row = buildRowParts(
      heading,
      fonts,
      layout,
      numbering,
      rowLeft,
      linkRight,
    );
    assertRowGeometry(rowLeft, linkRight, row, heading.text);

    elements.push(
      applyTextBox(
        await createSdkElement(TYPE_TEXT),
        tocFilePage,
        row.titleText,
        {left: rowLeft, top: y, right: row.titleRight, bottom: y + row.height},
        row.fontSize,
        row.textBold === 1,
        INDEXBOT_USERDATA_TOC_ROW,
      ),
    );
    elements.push(
      applyLink(
        await createSdkElement(TYPE_LINK),
        tocFilePage,
        notePath,
        heading.page,
        {left: row.linkLeft, top: y, right: linkRight, bottom: y + row.height},
        row.fontSize,
        `${row.leaderText}${LINK_SENTINEL}`,
        row.leaderText,
      ),
    );
    y += row.height;
  }

  return elements;
}

async function insertColumnViaFile({
  headings,
  includeHeader,
  fonts,
  left,
  blockW,
  top,
  notePath,
  layout,
  tocFilePage,
  bucket,
  onProgress,
  rowOffset = 0,
  rowTotal = 0,
}) {
  const els = await buildColumnElements({
    headings,
    includeHeader,
    fonts,
    left,
    blockW,
    top,
    notePath,
    layout,
    tocFilePage,
    onProgress,
    rowOffset,
    rowTotal,
  });
  bucket.push(...els);
}

/**
 * Strip old ToC and insert new layout on tocPage (default page 1).
 * Always writes through File API so rows persist before reloadFile.
 */
export async function insertTableOfContents({
  notePath,
  tocPage = 1,
  pageSize,
  headings,
  layout: layoutMode = 'compact',
  onProgress,
}) {
  const layout = normalizeLayout(layoutMode);
  const tocHostPg = toHostPageIndex(tocPage);
  const tocFilePage = toFilePageIndex(tocHostPg);

  await PluginNoteAPI.saveCurrentNote();
  await stripPreviousToc(notePath, tocHostPg);
  await PluginNoteAPI.saveCurrentNote();

  const plan = planLayout(headings, pageSize, layout);
  const expectedLinks = plan.left.length + plan.right.length;
  log(
    TAG,
    `layout=${layout} tocHost=${tocHostPg} tocFile=${tocFilePage} fileInsert=1 columns=${plan.columns} blockW=${plan.blockW} singleLineRows=1`,
  );

  if (expectedLinks === 0) {
    throw new Error('No headings to insert into ToC');
  }

  const margin = tocMargin(pageSize);
  const top = margin;
  const left0 = tocBlockOrigin(pageSize, plan.blockW, plan.columns);
  log(TAG, `tocCenter left=${left0} blockW=${plan.blockW} columns=${plan.columns}`);

  const allElements = [];
  await insertColumnViaFile({
    headings: plan.left,
    includeHeader: true,
    fonts: plan.fonts,
    left: left0,
    blockW: plan.blockW,
    top,
    notePath,
    layout,
    tocFilePage,
    bucket: allElements,
    onProgress,
    rowOffset: 0,
    rowTotal: expectedLinks,
  });
  if (plan.columns === 2 && plan.right.length > 0) {
    const left1 = left0 + plan.blockW + GUTTER;
    await insertColumnViaFile({
      headings: plan.right,
      includeHeader: false,
      fonts: plan.fonts,
      left: left1,
      blockW: plan.blockW,
      top,
      notePath,
      layout,
      tocFilePage,
      bucket: allElements,
      onProgress,
      rowOffset: plan.left.length,
      rowTotal: expectedLinks,
    });
  }

  if (allElements.length === 0) {
    throw new Error('No ToC elements built for insert');
  }

  const ins = await withTimeout(
    PluginFileAPI.insertElements(notePath, tocFilePage, allElements),
    30000,
    `insertElements(toc file=${tocFilePage})`,
  );
  if (ins?.success !== true) {
    throw new Error(
      `insertElements ToC failed: ${ins?.error?.message || 'unknown'}`,
    );
  }

  await PluginNoteAPI.saveCurrentNote();

  const verified = await verifyTocOnPage(notePath, tocFilePage, expectedLinks);

  return {
    omitted: plan.omitted,
    columns: plan.columns,
    fontSize: plan.fonts.h1,
    inserted: verified.tocLinks,
    tocLinks: verified.tocLinks,
    layout,
    tocPage: tocHostPg,
  };
}
