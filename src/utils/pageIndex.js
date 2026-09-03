/**
 * Host page numbers are 1-indexed as of the 2026 plugin SDK release.
 * A raw 0 is treated as missing / legacy first-page.
 */

export function toHostPageIndex(pageNum) {
  const n = Number(pageNum);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}
