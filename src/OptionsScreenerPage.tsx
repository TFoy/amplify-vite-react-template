import { useEffect, useMemo, useRef, useState } from "react";
import type { RequestedOptionType, RequestedStrikeRange } from "./OptionsAprPage";
import { DEFAULT_SCREENER_SETTINGS, type ScreenerSettings } from "./optionsScreenerSettings";
import { parseTickers, promoteSort, scanOptions, selectRows, validTicker, type Progress, type RequestJson, type ScreenerRow, type SortColumn, type SortRule } from "./optionsScreener";

const columns: { key: SortColumn; label: string }[] = [
  { key: "ticker", label: "Ticker" }, { key: "type", label: "Type" },
  { key: "expiration", label: "Expiration date" }, { key: "strike", label: "Strike price" },
  { key: "currentPrice", label: "Current price" }, { key: "distance", label: "Distance" },
  { key: "apr", label: "APR" }, { key: "bidApr", label: "Bid APR" }, { key: "probabilityWorthless", label: "Exp w/o exercise" },
  { key: "midpoint", label: "Midpoint premium" },
  { key: "flagCount", label: "Flags" },
];
const percent = (value: number | null) => value === null ? "—" : `${(value * 100).toFixed(2)}%`;
const currency = (value: number | null) => value === null ? "—" : value.toLocaleString(undefined, { style: "currency", currency: "USD" });

export default function OptionsScreenerPage({ defaultTickers, request, local = false, initialSettings = DEFAULT_SCREENER_SETTINGS, onSettingsChange }: {
  defaultTickers: string[]; request: RequestJson; local?: boolean;
  initialSettings?: ScreenerSettings;
  onSettingsChange?: (settings: ScreenerSettings) => void | Promise<void>;
}) {
  const [tickers, setTickers] = useState(defaultTickers);
  const [tickerInput, setTickerInput] = useState("");
  const [settings, setSettings] = useState(initialSettings);
  const { minimumApr, minimumProbability, minimumDistance, maximumDistance, excludeOutliers, firstExpirations, optionType, strikeRange } = settings;
  const [settingsError, setSettingsError] = useState("");
  async function updateSetting<K extends keyof ScreenerSettings>(key: K, value: ScreenerSettings[K]) {
    const next = { ...settings, [key]: value };
    setSettings(next);
    setPage(1);
    try { await onSettingsChange?.(next); setSettingsError(""); }
    catch (error) { setSettingsError(`Unable to save Run settings: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const [rows, setRows] = useState<ScreenerRow[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [inputError, setInputError] = useState("");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [status, setStatus] = useState<"idle" | "running" | "complete" | "cancelled">("idle");
  const [startedAt, setStartedAt] = useState<Date | null>(null);
  const [sort, setSort] = useState<SortRule[]>([{ column: "apr", descending: true }]);
  const [pageSize, setPageSize] = useState(50);
  const [page, setPage] = useState(1);
  const controller = useRef<AbortController | null>(null);
  const running = status === "running";
  useEffect(() => () => controller.current?.abort(), []);

  const maximumDistanceValue = maximumDistance.trim() === "" ? Infinity : Number(maximumDistance);
  const thresholdsValid = minimumApr.trim() !== "" && Number.isFinite(Number(minimumApr)) && Number(minimumApr) >= 0 &&
    minimumProbability.trim() !== "" && Number.isFinite(Number(minimumProbability)) && Number(minimumProbability) >= 0 && Number(minimumProbability) <= 100 &&
    minimumDistance.trim() !== "" && Number.isFinite(Number(minimumDistance)) && Number(minimumDistance) >= 0 &&
    (maximumDistance.trim() === "" || (Number.isFinite(maximumDistanceValue) && maximumDistanceValue >= Number(minimumDistance)));
  const expirationLimit = firstExpirations.trim() === "" ? undefined : Number(firstExpirations);
  const expirationLimitValid = expirationLimit === undefined || (Number.isSafeInteger(expirationLimit) && expirationLimit >= 1);
  const filtered = useMemo(() => thresholdsValid
    ? selectRows(rows, Number(minimumApr), Number(minimumProbability), sort, excludeOutliers, Number(minimumDistance), maximumDistanceValue)
    : [], [rows, minimumApr, minimumProbability, minimumDistance, maximumDistanceValue, sort, thresholdsValid, excludeOutliers]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount);
  const visibleRows = filtered.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  function addTickers() {
    const added = parseTickers(tickerInput);
    const invalid = added.filter((ticker) => !validTicker(ticker));
    if (invalid.length) { setInputError(`Invalid ticker symbols: ${invalid.join(", ")}`); return; }
    setTickers((current) => [...new Set([...current, ...added])]);
    setTickerInput("");
    setInputError("");
  }

  async function run() {
    if (controller.current || !expirationLimitValid || !tickers.length) return;
    const abortController = new AbortController();
    controller.current = abortController;
    const snapshot = [...tickers];
    setRows([]); setErrors([]); setPage(1); setStatus("running"); setStartedAt(new Date());
    setProgress({ total: snapshot.length, processed: 0, retrieved: 0, ticker: "", expiration: "", chain: 0, chains: 0 });
    try {
      await scanOptions({ tickers: snapshot, request, signal: abortController.signal,
        firstExpirations: expirationLimit, optionType, strikeRange,
        onRows: (added) => setRows((current) => [...current, ...added]),
        onProgress: setProgress, onError: (message) => setErrors((current) => [...current, message]),
      });
      setStatus("complete");
    } catch (error) {
      if (abortController.signal.aborted) setStatus("cancelled");
      else { setErrors((current) => [...current, error instanceof Error ? error.message : String(error)]); setStatus("complete"); }
    } finally { controller.current = null; }
  }

  return <main className="skew-page options-screener">
    <header><a href={local ? "/screener.local.html" : "/"}>{local ? "Local screener" : "Home"}</a>
      <h1>Options APR Screener</h1>
      <p>Compare option APRs across tickers, expirations, and strikes.</p>
    </header>
    <section className="skew-panel">
      <h2>Tickers to scan</h2>
      <p>{local ? "Local Yahoo Finance access · no sign-in required." : "Starts with your Options APR Explorer tickers. Edit this list for the next run."}</p>
      <form className="screener-add" onSubmit={(event) => { event.preventDefault(); addTickers(); }}>
        <label>Ticker symbols<input value={tickerInput} disabled={running} onChange={(event) => setTickerInput(event.target.value)} placeholder="INTC, AMZN, GOOGL" /></label>
        <button type="submit" disabled={running || !tickerInput.trim()}>Add tickers</button>
        <button type="button" disabled={running} onClick={() => { setTickers([...defaultTickers]); setInputError(""); }}>Reset to defaults</button>
        <button type="button" disabled={running || !tickers.length} onClick={() => { setTickers([]); setInputError(""); }}>Clear all</button>
      </form>
      {inputError && <p role="alert" className="skew-error">{inputError}</p>}
      <ul className="screener-tickers">{tickers.map((ticker) => <li key={ticker}>
        <button type="button" disabled={running} aria-label={`Remove ${ticker}`} onClick={() => setTickers((current) => current.filter((value) => value !== ticker))}>×</button>
        {ticker}
      </li>)}</ul>
      {!tickers.length && <p>Add at least one ticker to run the screener.</p>}
      <div className="screener-controls">
        <label>First N expirations per ticker<input type="number" min="1" step="1" placeholder="All" disabled={running} value={firstExpirations} onChange={(event) => void updateSetting("firstExpirations", event.target.value)} /></label>
        <label>Option types<select disabled={running} value={optionType} onChange={(event) => void updateSetting("optionType", event.target.value as RequestedOptionType)}>
          <option value="both">Calls and puts</option><option value="put">Puts only</option><option value="call">Calls only</option>
        </select></label>
        <label>Strike coverage<select disabled={running} value={strikeRange} onChange={(event) => void updateSetting("strikeRange", event.target.value as RequestedStrikeRange)}>
          <option value="otm">OTM/ATM only</option><option value="all">All strikes</option>
        </select></label>
        <label className="screener-exclude-outliers"><input type="checkbox" checked={excludeOutliers} onChange={(event) => void updateSetting("excludeOutliers", event.target.checked)} />Exclude outliers</label>
      </div>
      <div className="screener-controls">
        <button type="button" disabled={running || !tickers.length || !expirationLimitValid || !!tickerInput.trim()} onClick={() => void run()}>Run</button>
        {running && <button type="button" onClick={() => controller.current?.abort()}>Cancel</button>}
      </div>
      {tickerInput.trim() && <p>Add or clear the pending ticker symbols before running.</p>}
      {settingsError && <p role="alert" className="skew-error">{settingsError}</p>}
      {!expirationLimitValid && <p role="alert" className="skew-error">Enter a positive whole number of expirations, or leave blank for all.</p>}
      <p className="options-apr-method-note">Leave the expiration limit blank for all dates, or enter N to retrieve the nearest N dates per ticker. Option types and strike coverage apply to the next run. Exclude outliers hides unusable quotes and OTM 10× APR outliers; wide spreads and activity warnings stay visible. Uncheck it to inspect excluded rows without retrieving again.</p>
      <p className="options-apr-method-note">Requests run sequentially with an 800 ms pause between requests, including between tickers.</p>
    </section>
    {progress && <section className="skew-panel" aria-label="Retrieval progress">
      <progress aria-label="Tickers processed" value={progress.processed} max={progress.total} />
      <div role="status" aria-live="polite">
        <p>{progress.processed} of {progress.total} tickers processed · {progress.retrieved} fully retrieved
          {status === "complete" ? errors.length ? " · Finished with errors; results are incomplete." : " · Complete" : status === "cancelled" ? " · Cancelled; partial results retained." : ""}</p>
        {running && <p>{progress.ticker}: {progress.chains ? `${progress.chain} of ${progress.chains} expiration chains retrieved/attempted · ${progress.expiration}` : "Retrieving expiration dates…"}</p>}
      </div>
      {startedAt && <p>Run started {startedAt.toLocaleString()}. Keep this page open while retrieval runs.</p>}
      {errors.length > 0 && <details open><summary>{errors.length} retrieval error{errors.length === 1 ? "" : "s"}</summary><ul>{errors.map((error, index) => <li key={index}>{error}</li>)}</ul></details>}
    </section>}
    <section className="skew-panel">
      <h2>Results</h2>
      <div className="screener-controls">
        <label>Minimum APR (%)<input type="number" min="0" step="any" value={minimumApr} onChange={(event) => void updateSetting("minimumApr", event.target.value)} /></label>
        <label>Minimum expires without exercise (%)<input type="number" min="0" max="100" step="any" value={minimumProbability} onChange={(event) => void updateSetting("minimumProbability", event.target.value)} /></label>
        <label>Minimum distance (%)<input type="number" min="0" step="any" value={minimumDistance} onChange={(event) => void updateSetting("minimumDistance", event.target.value)} /></label>
        <label>Maximum distance (%)<input type="number" min="0" step="any" placeholder="No limit" value={maximumDistance} onChange={(event) => void updateSetting("maximumDistance", event.target.value)} /></label>
      </div>
      <p className="options-apr-method-note">These filters update the table immediately using retrieved data. Changing them does not make any Yahoo API requests.</p>
      {!thresholdsValid && <p role="alert" className="skew-error">Enter an APR and minimum distance of at least 0, and a probability between 0 and 100. Maximum distance must be at least the minimum, or blank for no limit.</p>}
      <p>{filtered.length.toLocaleString()} matching options out of {rows.length.toLocaleString()} retrieved{running ? " · Results are still arriving." : "."}</p>
      <div className="skew-table-wrap"><table className="skew-table">
        <caption>Sorted by {sort.map((rule) => `${columns.find((column) => column.key === rule.column)?.label} (${rule.descending ? "descending" : "ascending"})`).join(", then ")}. Click a column to make it primary; click the primary column again to reverse it.</caption>
        <thead><tr>{columns.map(({ key, label }) => {
          const priority = sort.findIndex((rule) => rule.column === key);
          const rule = sort[priority];
          return <th key={key} aria-sort={priority === 0 ? rule.descending ? "descending" : "ascending" : undefined}>
            <button type="button" onClick={() => { setSort((current) => promoteSort(current, key)); setPage(1); }}>{label}{rule ? ` ${rule.descending ? "▼" : "▲"} ${priority + 1}` : ""}</button>
          </th>;
        })}</tr></thead>
        <tbody>{visibleRows.map((row) => <tr key={`${row.ticker}:${row.expiration}:${row.type}:${row.contractSymbol}`}>
          <td>{row.ticker}</td><td>{row.type}</td><td>{row.expiration}</td><td>{currency(row.strike)}</td>
          <td>{currency(row.currentPrice)}</td><td>{percent(row.distance)}</td>
          <td>{percent(row.apr)}</td><td>{percent(row.bidApr)}</td><td>{percent(row.probabilityWorthless)}</td><td>{currency(row.midpoint)}</td>
          <td className="screener-flags">{row.flags.length ? <details>
            <summary>{row.flags.map((flag) => flag.label).join("; ")}</summary>
            <ul>{row.flags.map((flag) => <li key={flag.label}><strong>{flag.exclude ? "Excluded when enabled" : "Warning only"}:</strong> {flag.detail}</li>)}</ul>
            <p>Bid {currency(row.bid)} · Ask {currency(row.ask)} · Volume {row.volume ?? "unavailable"} · Open interest {row.openInterest ?? "unavailable"}</p>
            <p>Last trade: {row.lastTradeDate ? new Date(row.lastTradeDate).toLocaleString() : "unavailable"}</p>
          </details> : "—"}</td>
        </tr>)}{!visibleRows.length && <tr><td colSpan={columns.length}>{status === "idle" ? "Choose tickers and click Run to retrieve options." : "No retrieved options match the filters."}</td></tr>}</tbody>
      </table></div>
      <nav className="screener-pagination" aria-label="Results pages">
        <label>Rows per page <select value={pageSize} onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}>{[10, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
        <button type="button" disabled={currentPage === 1} onClick={() => setPage(1)}>First</button>
        <button type="button" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Previous</button>
        <span>Page {currentPage} of {pageCount}</span>
        <button type="button" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>Next</button>
        <button type="button" disabled={currentPage === pageCount} onClick={() => setPage(pageCount)}>Last</button>
      </nav>
      <p className="options-apr-method-note">Flags identify quote problems or activity warnings; click a flag to inspect details. Flags sort by count. Wide spread means over 50% of midpoint, low volume means below 10, low open interest means below 100, and old last trade means over 7 days before the market-data date. Missing activity is not treated as zero. Bid APR uses the displayed bid and the same collateral and annualization as APR; it is not a guaranteed execution price. Minimum APR continues to filter midpoint APR.</p>
      <p className="options-apr-method-note">Current price is the underlying share price returned with each chain at retrieval. Distance is the absolute difference between strike and current price, divided by current price, shown as a percentage.</p>
      <p className="options-apr-method-note">APR uses midpoint premium, annualized against strike collateral for puts and current share price for calls, as in the APR Explorer. This is a premium-selling metric, not an expected return from buying an option. Midpoint premium is per share. Exp w/o exercise is the estimated probability of expiring without exercise, matching the minimum filter; the Black–Scholes estimate does not model early exercise. Options missing APR or probability are omitted from matches.</p>
    </section>
  </main>;
}
