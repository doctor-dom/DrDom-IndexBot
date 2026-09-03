/** @typedef {'outline' | 'compact' | 'numbered' | 'flat'} LayoutMode */

export const LAYOUT_MODES = ['outline', 'compact', 'numbered', 'flat'];

/**
 * @param {unknown} value
 * @returns {LayoutMode}
 */
export function normalizeLayout(value) {
  const v = String(value || 'compact').toLowerCase();
  if (LAYOUT_MODES.includes(v)) return /** @type {LayoutMode} */ (v);
  return 'compact';
}
