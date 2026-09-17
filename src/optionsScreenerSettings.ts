import type { RequestedOptionType, RequestedStrikeRange } from "./OptionsAprPage";

export type ScreenerSettings = {
  minimumApr: string;
  minimumProbability: string;
  minimumDistance: string;
  excludeOutliers: boolean;
  firstExpirations: string;
  optionType: RequestedOptionType;
  strikeRange: RequestedStrikeRange;
};

export const DEFAULT_SCREENER_SETTINGS: ScreenerSettings = {
  minimumApr: "25", minimumProbability: "90", minimumDistance: "0", excludeOutliers: true,
  firstExpirations: "", optionType: "both", strikeRange: "otm",
};

// Pick only Run settings; ticker lists are never persisted here.
export function parseScreenerSettings(json: string | null | undefined): ScreenerSettings {
  let value: Partial<ScreenerSettings>;
  try { value = JSON.parse(json ?? "{}"); } catch { return { ...DEFAULT_SCREENER_SETTINGS }; }
  if (!value || typeof value !== "object") return { ...DEFAULT_SCREENER_SETTINGS };
  const percent = (input: unknown, fallback: string, max = Infinity) =>
    typeof input === "string" && input.trim() !== "" && Number.isFinite(Number(input)) && Number(input) >= 0 && Number(input) <= max ? input : fallback;
  return {
    minimumApr: percent(value.minimumApr, "25"),
    minimumProbability: percent(value.minimumProbability, "90", 100),
    minimumDistance: percent(value.minimumDistance, "0"),
    excludeOutliers: typeof value.excludeOutliers === "boolean" ? value.excludeOutliers : true,
    firstExpirations: typeof value.firstExpirations === "string" &&
      (value.firstExpirations === "" || (Number.isSafeInteger(Number(value.firstExpirations)) && Number(value.firstExpirations) > 0)) ? value.firstExpirations : "",
    optionType: value.optionType === "call" || value.optionType === "put" ? value.optionType : "both",
    strikeRange: value.strikeRange === "all" ? "all" : "otm",
  };
}
