/**
 * Strip previous IndexBot ToC and insert per-row text + tappable leader links.
 *
 * Layout modes: outline, compact, numbered, flat (no page numbers).
 * Title in editable text box; leader dots + → share one insertTextLink rect.
 */

import {PluginCommAPI, PluginFileAPI, PluginNoteAPI} from 'sn-plugin-lib';
import {log} from '../utils/debug';
import {toHostPageIndex} from '../utils/pageIndex';
import {normalizeLayout} from './layoutModes';

const TAG = 'Insert';

/** Hidden identity in link fullText only — never shown in text boxes. */
export const LINK_SENTINEL = '→<!--indexbot-toc-->';
export const JUMP_SHOW = '→';
export const TOC_HEADER = 'Table of Contents';

const TYPE_TEXT = 500;
const TYPE_LINK = 600;

const MARGIN = 48;
const GUTTER = 32;
const LINK_COL_W = 44;
const LINE_FACTOR = 1.4;
const CHAR_FACTOR = 0.55;
const BLOCK_MIN_FRAC = 0.4;
const BLOCK_MAX_FRAC = 0.55;
const FONT_SCALE_SHRINK = 0.75;
const INDENT_PX = 24;

const OUTLINE_BULLETS = ['', '• ', '◦ ', '- '];

const FONTS_BASE = {
  header: 52,
  h1: 48,
  h2: 42,
  h3: 36,
  h4: 32,
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

function buildRowParts(heading, fonts, layout, numbering, leaderAreaWidth) {
  const fs = fontForHeading(heading, fonts, layout);
  const level = displayLevel(heading, layout);
  const prefix = buildTitlePrefix(heading, layout, numbering);
  const prefixW = estimateTextWidth(prefix, fs);

  const titleBudget = Math.max(
    fs * 3,
    leaderAreaWidth - prefixW - estimateTextWidth(' … →', fs),
  );
  const title = truncateToWidth(heading.text, fs, titleBudget);
  const titleText = `${prefix}${title}`;
  const titleW = estimateTextWidth(titleText, fs);

  const leaderBudget = Math.max(fs * 2, leaderAreaWidth - titleW);
  const dotW = estimateTextWidth('.', fs) || fs * CHAR_FACTOR;
  let dots = Math.floor(leaderBudget / dotW);
  if (dots < 3) dots = 3;
  const leaderText = `${'.'.repeat(dots)} ${JUMP_SHOW}`;

  const textBold = layout === 'outline' && level === 0 ? 1 : 0;

  return {
    titleText,
    leaderText,
    fontSize: fs,
    height: lineHeight(fs),
    textBold,
    titleW,
  };
}

function samplePrefixForWidth(heading, layout, numbering) {
  return buildTitlePrefix(heading, layout, numbering);
}

function isIndexBotLink(el) {
  if (el?.type !== TYPE_LINK) return false;
  const full = el.link?.fullText || '';
  return full.includes('indexbot-toc') || full.includes('<!--indexbot-toc-->');
}

function textBoxFirstLine(el) {
  const content = el?.textBox?.textContentFull || '';
  return content.split(/\r?\n/)[0] || '';
}

function textBoxRect(el) {
  const r = el?.textBox?.textRect;
  if (r && typeof r.left === 'number') return r;
  return null;
}

function linkRect(el) {
  const L = el?.link;
  if (!L) return null;
  if (typeof L.X === 'number' && typeof L.width === 'number') {
    return {
      left: L.X,
      top: L.Y,
      right: L.X + L.width,
      bottom: L.Y + (L.height || 0),
    };
  }
  return null;
}

function rectsOverlap(a, b, pad = 24) {
  if (!a || !b) return false;
  return !(
    a.right < b.left - pad ||
    a.left > b.right + pad ||
    a.bottom < b.top - pad ||
    a.top > b.bottom + pad
  );
}

function clusterBounds(rects) {
  if (!rects.length) return null;
  return {
    left: Math.min(...rects.map(r => r.left)),
    top: Math.min(...rects.map(r => r.top)),
    right: Math.max(...rects.map(r => r.right)),
    bottom: Math.max(...rects.map(r => r.bottom)),
  };
}

function computeBlockWidth(headings, fonts, pageWidth, layout) {
  const minW = Math.floor(pageWidth * BLOCK_MIN_FRAC);
  const maxW = Math.floor(pageWidth * BLOCK_MAX_FRAC);
  const numbering = createNumberingState();
  let contentW = estimateTextWidth(TOC_HEADER, fonts.header);

  for (const h of headings) {
    const fs = fontForHeading(h, fonts, layout);
    const prefix = samplePrefixForWidth(h, layout, numbering);
    const title = cleanTitle(h.text);
    const level = displayLevel(h, layout);
    const rowLeft = MARGIN + level * INDENT_PX;
    const w =
      rowLeft -
      MARGIN +
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
  const availableH = Math.max(0, pageSize.height - MARGIN * 2);
  const pageW = pageSize.width;

  const tryPlan = (fonts, columns) => {
    if (columns === 1) {
      const height = measureColumnHeight(headings, fonts, layout, true);
      const blockW = computeBlockWidth(headings, fonts, pageW, layout);
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

    const halfW = Math.floor((pageW - MARGIN * 2 - GUTTER) / 2);
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

async function stripPreviousToc(notePath, pageNum) {
  const page = toHostPageIndex(pageNum);
  const res = await withTimeout(
    PluginFileAPI.getElements(page, notePath),
    15000,
    'getElements(strip)',
  );
  if (!res?.success || !Array.isArray(res.result)) {
    log(TAG, `strip getElements failed: ${JSON.stringify(res?.error)}`);
    return;
  }

  const linkRects = [];
  for (const el of res.result) {
    if (isIndexBotLink(el)) {
      const r = linkRect(el);
      if (r) linkRects.push(r);
    }
  }
  const cluster = clusterBounds(linkRects);

  const kept = [];
  let removed = 0;
  for (const el of res.result) {
    if (isIndexBotLink(el)) {
      removed += 1;
      continue;
    }
    if (el?.type === TYPE_TEXT) {
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
    PluginFileAPI.replaceElements(notePath, page, kept),
    20000,
    'replaceElements',
  );
  log(TAG, `replaceElements success=${replace?.success}`);
  if (!replace?.success) {
    throw new Error(
      `Failed to clear previous ToC: ${replace?.error?.message || 'unknown'}`,
    );
  }
}

async function insertHeaderRow({left, top, textRight, fonts}) {
  const fs = fonts.header;
  const h = lineHeight(fs);
  const textRes = await PluginNoteAPI.insertText({
    textContentFull: TOC_HEADER,
    textRect: {
      left,
      top,
      right: textRight,
      bottom: top + h,
    },
    fontSize: fs,
    textAlign: 0,
    textBold: 1,
    textItalics: 0,
    textFrameWidthType: 0,
    textFrameStyle: 0,
    textEditable: 0,
  });
  if (textRes && textRes.success === false) {
    throw new Error(
      `insertText header failed: ${textRes?.error?.message || 'unknown'}`,
    );
  }
  return h;
}

async function insertHeadingRow({
  heading,
  fonts,
  baseLeft,
  top,
  blockW,
  notePath,
  layout,
  numbering,
}) {
  const rowLeft = rowLeftOffset(baseLeft, heading, layout);
  const linkRight = baseLeft + blockW;
  const leaderAreaWidth = Math.max(8, linkRight - rowLeft);

  const row = buildRowParts(
    heading,
    fonts,
    layout,
    numbering,
    leaderAreaWidth,
  );

  const titleRight = Math.min(
    linkRight - LINK_COL_W - 4,
    rowLeft + Math.ceil(row.titleW) + 8,
  );
  const linkLeft = Math.max(titleRight, rowLeft + Math.ceil(row.titleW));

  const textRes = await PluginNoteAPI.insertText({
    textContentFull: row.titleText,
    textRect: {
      left: rowLeft,
      top,
      right: titleRight,
      bottom: top + row.height,
    },
    fontSize: row.fontSize,
    textAlign: 0,
    textBold: row.textBold,
    textItalics: 0,
    textFrameWidthType: 0,
    textFrameStyle: 0,
    textEditable: 0,
  });
  if (textRes && textRes.success === false) {
    log(
      TAG,
      `insertText failed for "${heading.text}": ${JSON.stringify(textRes.error)}`,
    );
  }

  const linkRes = await PluginNoteAPI.insertTextLink({
    destPath: notePath,
    destPage: toHostPageIndex(heading.page),
    style: 0,
    linkType: 0,
    rect: {
      left: linkLeft,
      top,
      right: linkRight,
      bottom: top + row.height,
    },
    fontSize: row.fontSize,
    fullText: `${row.leaderText}${LINK_SENTINEL}`,
    showText: row.leaderText,
    isItalic: 0,
  });
  if (linkRes && linkRes.success === false) {
    log(
      TAG,
      `insertTextLink failed for "${heading.text}": ${JSON.stringify(linkRes.error)}`,
    );
  }
  return row.height;
}

async function insertColumn({
  headings,
  includeHeader,
  fonts,
  left,
  blockW,
  top,
  notePath,
  layout,
}) {
  const linkRight = left + blockW;
  const textRight = linkRight - LINK_COL_W - 6;
  let y = top;
  const numbering = createNumberingState();

  if (includeHeader) {
    y += await insertHeaderRow({left, top: y, textRight, fonts});
  }

  for (const heading of headings) {
    y += await insertHeadingRow({
      heading,
      fonts,
      baseLeft: left,
      top: y,
      blockW,
      notePath,
      layout,
      numbering,
    });
  }
}

/**
 * Strip old ToC and insert new layout on the current page.
 */
export async function insertTableOfContents({
  notePath,
  currentPage,
  pageSize,
  headings,
  layout: layoutMode = 'compact',
}) {
  const layout = normalizeLayout(layoutMode);

  await PluginNoteAPI.saveCurrentNote();
  await stripPreviousToc(notePath, currentPage);
  await PluginNoteAPI.saveCurrentNote();

  const plan = planLayout(headings, pageSize, layout);
  log(
    TAG,
    `layout=${layout} columns=${plan.columns} fonts.h1=${plan.fonts.h1} blockW=${plan.blockW} left=${plan.left.length} right=${plan.right.length} omitted=${plan.omitted}`,
  );

  const top = MARGIN;
  const left0 = MARGIN;

  await insertColumn({
    headings: plan.left,
    includeHeader: true,
    fonts: plan.fonts,
    left: left0,
    blockW: plan.blockW,
    top,
    notePath,
    layout,
  });

  if (plan.columns === 2 && plan.right.length > 0) {
    const left1 = left0 + plan.blockW + GUTTER;
    const maxLeft = pageSize.width - MARGIN - plan.blockW;
    await insertColumn({
      headings: plan.right,
      includeHeader: false,
      fonts: plan.fonts,
      left: Math.min(left1, Math.max(left0, maxLeft)),
      blockW: plan.blockW,
      top,
      notePath,
      layout,
    });
  }

  try {
    await PluginCommAPI.reloadFile();
  } catch (e) {
    log(TAG, `reloadFile: ${e.message}`);
  }

  return {
    omitted: plan.omitted,
    columns: plan.columns,
    fontSize: plan.fonts.h1,
    inserted: plan.left.length + plan.right.length,
    layout,
  };
}
