export const SCREENER_COLUMNS = [
  { key: "ticker", label: "Ticker" }, { key: "type", label: "Type" },
  { key: "expiration", label: "Expiration date" }, { key: "strike", label: "Strike price" },
  { key: "currentPrice", label: "Current price" }, { key: "distance", label: "Distance" },
  { key: "apr", label: "APR" }, { key: "bidApr", label: "Bid APR" },
  { key: "probabilityWorthless", label: "Exp w/o exercise" },
  { key: "midpoint", label: "Midpoint premium" }, { key: "flagCount", label: "Flags" },
] as const;
export type SortColumn = typeof SCREENER_COLUMNS[number]["key"];
export const DEFAULT_COLUMN_ORDER: SortColumn[] = SCREENER_COLUMNS.map((column) => column.key);

export function normalizeColumnOrder(value: unknown): SortColumn[] {
  const known = new Set<string>(DEFAULT_COLUMN_ORDER);
  const saved = Array.isArray(value) ? value.filter((key): key is SortColumn => typeof key === "string" && known.has(key)) : [];
  return [...new Set([...saved, ...DEFAULT_COLUMN_ORDER])];
}

export function moveColumn(order: readonly SortColumn[], source: SortColumn, target: SortColumn): SortColumn[] {
  const from = order.indexOf(source);
  const to = order.indexOf(target);
  const next = [...order];
  if (from < 0 || to < 0 || from === to) return next;
  next.splice(from, 1);
  next.splice(to, 0, source);
  return next;
}
