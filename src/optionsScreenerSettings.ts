import type { RequestedOptionType, RequestedStrikeRange } from "./OptionsAprPage";
import { validTicker } from "./optionsScreener";
import { DEFAULT_COLUMN_ORDER, normalizeColumnOrder, type SortColumn } from "./optionsScreenerColumns";
import { DEFAULT_EXCLUDED_FLAGS, QUOTE_FLAG_LABELS, type QuoteFlagLabel } from "./optionsQuoteQuality";

export type ScreenerSettings = {
  tickers: string[] | null;
  minimumApr: string;
  minimumProbability: string;
  minimumDistance: string;
  maximumDistance: string;
  excludeOutliers: boolean;
  excludedFlags: QuoteFlagLabel[];
  columnOrder: SortColumn[];
  firstExpirations: string;
  optionType: RequestedOptionType;
  strikeRange: RequestedStrikeRange;
};

export const DEFAULT_SCREENER_SETTINGS: ScreenerSettings = {
  tickers: null,
  minimumApr: "25", minimumProbability: "90", minimumDistance: "0", maximumDistance: "", excludeOutliers: true,
  firstExpirations: "", optionType: "both", strikeRange: "otm",
  excludedFlags: DEFAULT_EXCLUDED_FLAGS,
  columnOrder: DEFAULT_COLUMN_ORDER,
};

// Null means no saved screener list yet; an empty array is an intentionally empty list.
export function parseScreenerSettings(json: string | null | undefined): ScreenerSettings {
  let value: Partial<ScreenerSettings>;
  try { value = JSON.parse(json ?? "{}"); } catch { return { ...DEFAULT_SCREENER_SETTINGS }; }
  if (!value || typeof value !== "object") return { ...DEFAULT_SCREENER_SETTINGS };
  const percent = (input: unknown, fallback: string, max = Infinity) =>
    typeof input === "string" && input.trim() !== "" && Number.isFinite(Number(input)) && Number(input) >= 0 && Number(input) <= max ? input : fallback;
  return {
    tickers: Array.isArray(value.tickers) ? [...new Set(value.tickers
      .filter((ticker): ticker is string => typeof ticker === "string")
      .map((ticker) => ticker.trim().toUpperCase()).filter(validTicker))] : null,
    minimumApr: percent(value.minimumApr, "25"),
    minimumProbability: percent(value.minimumProbability, "90", 100),
    minimumDistance: percent(value.minimumDistance, "0"),
    maximumDistance: percent(value.maximumDistance, ""),
    excludeOutliers: typeof value.excludeOutliers === "boolean" ? value.excludeOutliers : true,
    columnOrder: normalizeColumnOrder(value.columnOrder),
    excludedFlags: Array.isArray(value.excludedFlags)
      ? QUOTE_FLAG_LABELS.filter((label) => value.excludedFlags!.includes(label)) : [...DEFAULT_EXCLUDED_FLAGS],
    firstExpirations: typeof value.firstExpirations === "string" &&
      (value.firstExpirations === "" || (Number.isSafeInteger(Number(value.firstExpirations)) && Number(value.firstExpirations) > 0)) ? value.firstExpirations : "",
    optionType: value.optionType === "call" || value.optionType === "put" ? value.optionType : "both",
    strikeRange: value.strikeRange === "all" ? "all" : "otm",
  };
}
