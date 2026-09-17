import type { ChainResult, RequestedOptionType, RequestedStrikeRange } from "./OptionsAprPage";
import { excludeAprOutliers } from "./optionsAprOutliers";

export type ScreenerRow = {
  ticker: string;
  contractSymbol: string;
  type: "call" | "put";
  expiration: string;
  strike: number;
  apr: number | null;
  probabilityWorthless: number | null;
  exercise: number | null;
  midpoint: number | null;
  isOutlier: boolean;
};
export type SortColumn = "ticker" | "type" | "expiration" | "strike" | "apr" | "exercise" | "midpoint";
export type Progress = { total: number; processed: number; retrieved: number; ticker: string; expiration: string; chain: number; chains: number };
export type RequestJson = <T>(path: string, signal: AbortSignal) => Promise<T>;

export function parseTickers(text: string) {
  return [...new Set(text.toUpperCase().split(/[\s,;]+/).filter(Boolean))];
}

export function validTicker(ticker: string) {
  return /^[A-Z0-9^][A-Z0-9.^=-]{0,19}$/.test(ticker);
}

export function chainRows(ticker: string, chain: ChainResult): ScreenerRow[] {
  const finite = (value: number | null) => value !== null && Number.isFinite(value) ? value : null;
  const outliers = new Set<string>();
  for (const type of ["call", "put"] as const) {
    const points = (type === "call" ? chain.calls : chain.puts)
      .filter((option) => finite(option.simpleApr) !== null)
      .map((option) => ({ x: option.strike, y: option.simpleApr!, contractSymbol: option.contractSymbol }));
    const retained = new Set(excludeAprOutliers(points, type, chain.underlyingPrice));
    points.filter((point) => !retained.has(point)).forEach((point) => outliers.add(point.contractSymbol));
  }
  return [...chain.calls, ...chain.puts].map((option) => {
    const probability = finite(option.probabilityExpiresWorthless);
    const probabilityWorthless = probability !== null && probability >= 0 && probability <= 1 ? probability : null;
    return {
      ticker, contractSymbol: option.contractSymbol, type: option.optionType,
      expiration: chain.expirationDate, strike: option.strike,
      apr: finite(option.simpleApr), probabilityWorthless,
      exercise: probabilityWorthless === null ? null : 1 - probabilityWorthless,
      midpoint: finite(option.midpoint),
      isOutlier: outliers.has(option.contractSymbol),
    };
  });
}

export function selectRows(rows: ScreenerRow[], minimumApr: number, minimumProbability: number, column: SortColumn, descending: boolean, excludeOutliers = false) {
  return rows.filter((row) => (!excludeOutliers || !row.isOutlier) && row.apr !== null && row.probabilityWorthless !== null &&
    row.apr * 100 >= minimumApr && row.probabilityWorthless * 100 >= minimumProbability)
    .sort((a, b) => {
      const left = a[column];
      const right = b[column];
      if (left === null) return right === null ? 0 : 1;
      if (right === null) return -1;
      const comparison = typeof left === "number" && typeof right === "number"
        ? left - right : String(left).localeCompare(String(right));
      return (descending ? -comparison : comparison) || a.contractSymbol.localeCompare(b.contractSymbol);
    });
}

export function waitForYahoo(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createScreenerRequest(baseUrl: string, headers: () => Promise<HeadersInit>): RequestJson {
  return async <T>(path: string, signal: AbortSignal): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
        headers: await headers(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      });
      // The existing cloud handler wraps Yahoo errors in HTTP 500 responses.
      // Recognize its rate-limit message as well as explicit gateway statuses.
      const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
      const rateLimited = response.status === 500 && /429|too many requests/i.test(body?.error ?? "");
      if (([429, 502, 503, 504].includes(response.status) || rateLimited) && attempt < 3) {
        const retryAfter = response.headers.get("Retry-After");
        const seconds = retryAfter === null ? NaN : Number(retryAfter);
        const retryMs = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
        await waitForYahoo(Math.max(2000 * 2 ** attempt, Number.isFinite(retryMs) ? retryMs : 0), signal);
        continue;
      }
      if (!response.ok || body?.error) throw new Error(body?.error ?? `Request failed (${response.status}).`);
      if (body === null) throw new Error("The API returned an invalid JSON response.");
      return body;
    }
  };
}

// Each expiration is a separate request, avoiding a long-running cloud request.
export async function scanOptions(input: {
  tickers: readonly string[];
  request: RequestJson;
  signal: AbortSignal;
  onProgress: (progress: Progress) => void;
  onRows: (rows: ScreenerRow[]) => void;
  onError: (message: string) => void;
  wait?: typeof waitForYahoo;
  firstExpirations?: number;
  optionType?: RequestedOptionType;
  strikeRange?: RequestedStrikeRange;
}) {
  const { tickers, request, signal, onProgress, onRows, onError, wait = waitForYahoo,
    firstExpirations, optionType = "both", strikeRange = "all" } = input;
  if (firstExpirations !== undefined && (!Number.isSafeInteger(firstExpirations) || firstExpirations < 1)) {
    throw new Error("The expiration limit must be a positive whole number.");
  }
  const progress: Progress = { total: tickers.length, processed: 0, retrieved: 0, ticker: "", expiration: "", chain: 0, chains: 0 };
  let first = true;
  const pacedRequest = async <T>(path: string) => {
    signal.throwIfAborted();
    if (!first) await wait(800, signal);
    first = false;
    return request<T>(path, signal);
  };
  const reportError = (context: string, error: unknown) => {
    signal.throwIfAborted();
    onError(`${context}: ${error instanceof Error ? error.message : String(error)}`);
  };
  for (const ticker of tickers) {
    signal.throwIfAborted();
    Object.assign(progress, { ticker, expiration: "", chain: 0, chains: 0 });
    onProgress({ ...progress });
    let complete = true;
    try {
      const metadata = await pacedRequest<{ expirationDates: string[] }>(`/yahoo-options-apr/expirations?symbol=${encodeURIComponent(ticker)}`);
      const expirations = [...new Set(metadata.expirationDates)].sort().slice(0, firstExpirations);
      progress.chains = expirations.length;
      if (!expirations.length) { complete = false; onError(`${ticker}: No option expirations available.`); }
      for (const expiration of expirations) {
        progress.expiration = expiration;
        onProgress({ ...progress });
        try {
          const params = new URLSearchParams({ symbol: ticker, expiration, optionType, strikeRange });
          const result = await pacedRequest<{ data: ChainResult }>(`/yahoo-options-apr/chain?${params}`);
          signal.throwIfAborted();
          onRows(chainRows(ticker, result.data));
        } catch (error) { complete = false; reportError(`${ticker} ${expiration}`, error); }
        progress.chain++;
        onProgress({ ...progress });
      }
    } catch (error) { complete = false; reportError(ticker, error); }
    progress.processed++;
    if (complete) progress.retrieved++;
    onProgress({ ...progress });
  }
  return progress;
}
