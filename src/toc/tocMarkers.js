/**
 * Shared detection for IndexBot-owned note elements.
 */

export const LINK_SENTINEL = '→<!--indexbot-toc-->';
export const JUMP_SHOW = '→';
export const TOC_HEADER = 'Table of Contents';
export const SNAPBACK_SENTINEL = '←<!--indexbot-snapback-->';
export const SNAPBACK_SHOW = '← ToC';

const TYPE_TEXT = 500;
const TYPE_LINK = 600;
const TYPE_STROKE = 0;
const TYPE_TITLE = 100;
const TYPE_PICTURE = 200;
const TYPE_GEO = 700;
const TYPE_FIVE_STAR = 800;

export function textBoxFirstLine(el) {
  const content = el?.textBox?.textContentFull || '';
  return content.split(/\r?\n/)[0] || '';
}

export function textBoxRect(el) {
  const r = el?.textBox?.textRect;
  if (r && typeof r.left === 'number') return r;
  return null;
}

export function linkRect(el) {
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

export function rectsOverlap(a, b, pad = 24) {
  if (!a || !b) return false;
  return !(
    a.right < b.left - pad ||
    a.left > b.right + pad ||
    a.bottom < b.top - pad ||
    a.top > b.bottom + pad
  );
}

export function clusterBounds(rects) {
  if (!rects.length) return null;
  return {
    left: Math.min(...rects.map(r => r.left)),
    top: Math.min(...rects.map(r => r.top)),
    right: Math.max(...rects.map(r => r.right)),
    bottom: Math.max(...rects.map(r => r.bottom)),
  };
}

export function isIndexBotTocLink(el) {
  if (el?.type !== TYPE_LINK) return false;
  const full = el.link?.fullText || '';
  return full.includes('indexbot-toc') || full.includes('<!--indexbot-toc-->');
}

export function isIndexBotSnapBackLink(el) {
  if (el?.type !== TYPE_LINK) return false;
  const full = el.link?.fullText || '';
  return full.includes('indexbot-snapback') || full.includes('<!--indexbot-snapback-->');
}

function isUserContentElement(el) {
  const t = el?.type;
  return (
    t === TYPE_STROKE ||
    t === TYPE_TITLE ||
    t === TYPE_TEXT ||
    t === TYPE_PICTURE ||
    t === TYPE_LINK ||
    t === TYPE_GEO ||
    t === TYPE_FIVE_STAR
  );
}

/**
 * True if element is IndexBot ToC or snap-back (ignored for blank-page check).
 */
export function isIndexBotOwnedElement(el) {
  if (isIndexBotTocLink(el) || isIndexBotSnapBackLink(el)) return true;
  if (el?.type === TYPE_TEXT) {
    const first = textBoxFirstLine(el).trim();
    if (first === TOC_HEADER) return true;
    const content = el.textBox?.textContentFull || '';
    if (content.includes('indexbot-toc')) return true;
  }
  return false;
}

/**
 * After removing IndexBot-owned elements, page has no user content.
 */
export function isPageBlankAfterIndexBot(elements) {
  for (const el of elements || []) {
    if (isIndexBotOwnedElement(el)) continue;
    if (isUserContentElement(el)) return false;
  }
  return true;
}

/**
 * Detect IndexBot ToC on a page from element list (link sentinel or header + cluster).
 */
export function pageHasIndexBotToc(elements) {
  if (!Array.isArray(elements) || elements.length === 0) return false;

  const linkRects = [];
  for (const el of elements) {
    if (isIndexBotTocLink(el)) {
      const r = linkRect(el);
      if (r) linkRects.push(r);
    }
  }
  if (linkRects.length > 0) return true;

  const cluster = clusterBounds(linkRects);
  for (const el of elements) {
    if (el?.type === TYPE_TEXT) {
      if (textBoxFirstLine(el).trim() === TOC_HEADER) return true;
      const r = textBoxRect(el);
      if (cluster && r && rectsOverlap(r, cluster)) return true;
    }
  }
  return false;
}
