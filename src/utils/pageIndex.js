/**
 * Host page numbers are 1-indexed (Comm/Note APIs, jump links, UI).
 * PluginFileAPI page args are 0-indexed (first page = 0).
 */

export function toHostPageIndex(pageNum) {
  const n = Number(pageNum);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

/** File API page index from host page (page 1 → 0). */
export function toFilePageIndex(hostPage) {
  const host = toHostPageIndex(hostPage);
  return Math.max(0, host - 1);
}

/** Host page from file API index (0 → page 1). */
export function filePageToHost(filePage) {
  const n = Number(filePage);
  if (!Number.isFinite(n) || n < 0) return 1;
  return Math.floor(n) + 1;
}

/** File page indices 0 .. pageCount-1 (pageCount = host total pages). */
export function filePageIndices(pageCount) {
  const n = Math.max(0, Math.floor(Number(pageCount) || 0));
  const out = [];
  for (let p = 0; p < n; p++) out.push(p);
  return out;
}
