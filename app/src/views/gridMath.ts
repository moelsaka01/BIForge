export interface Range {
  first: number;
  /** exclusive */
  end: number;
}

/** Rows to render for a scroll position: the visible rows plus `overscan` rows on each side. */
export function visibleRange(scrollTop: number, viewportHeight: number, rowHeight: number, total: number, overscan = 5): Range {
  if (total <= 0 || rowHeight <= 0) return { first: 0, end: 0 };
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewportHeight) / rowHeight) + overscan);
  return { first: Math.min(first, total), end: Math.max(Math.min(first, total), end) };
}
