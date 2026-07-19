import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Chart } from "chart.js/auto";
import { useAuthenticator } from "@aws-amplify/ui-react";
import outputs from "../amplify_outputs.json";
import { getAuthHeaders } from "./auth";
import { loadLastTicker, saveLastTicker } from "./userPreferences";

type OptionRow = {
  contractSymbol: string;
  optionType: "call" | "put";
  strike: number;
  bid: number | null;
  ask: number | null;
  midpoint: number | null;
  simpleApr: number | null;
  impliedVolatility: number | null;
  probabilityExpiresWorthless: number | null;
};

type ChainResult = {
  underlyingPrice: number;
  expirationDate: string;
  daysToExpiration: number;
  calls: OptionRow[];
  puts: OptionRow[];
};

type ExpirationsResponse = {
  symbol: string;
  underlyingPrice: number | null;
  expirationDates: string[];
  error?: string;
};

type ChainResponse = {
  symbol: string;
  data: ChainResult;
  error?: string;
};

type AmplifyCustomOutputs = {
  custom?: {
    yahoo_options_skew?: { api_url?: string };
    schwab?: { api_url?: string };
  };
};

type ChartPoint = {
  x: number;
  y: number;
  expirationDate: string;
  optionType: "call" | "put";
  strike: number;
  probabilityExpiresWorthless: number | null;
};

const CHART_COLORS = [
  "#2563eb",
  "#dc2626",
  "#059669",
  "#9333ea",
  "#d97706",
  "#0891b2",
  "#4f46e5",
  "#be185d",
];

function normalizeTicker(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9.^=-]/g, "");
}

function formatCurrency(value: number | null) {
  return value === null
    ? "--"
    : value.toLocaleString(undefined, {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
}

function formatPercent(value: number | null) {
  return value === null ? "--" : `${(value * 100).toFixed(2)}%`;
}

function OptionsAprPage() {
  const { user } = useAuthenticator((context) => [context.user]);
  const [symbol, setSymbol] = useState("");
  const [loadedSymbol, setLoadedSymbol] = useState("");
  const [underlyingPrice, setUnderlyingPrice] = useState<number | null>(null);
  const [expirationDates, setExpirationDates] = useState<string[]>([]);
  const [selectedExpirations, setSelectedExpirations] = useState<string[]>([]);
  const [chains, setChains] = useState<ChainResult[]>([]);
  const [hiddenSeries, setHiddenSeries] = useState<string[]>([]);
  const [isLoadingExpirations, setIsLoadingExpirations] = useState(false);
  const [isLoadingChains, setIsLoadingChains] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart<"line"> | null>(null);

  const apiBaseUrl = useMemo(() => {
    const custom = (outputs as AmplifyCustomOutputs).custom;
    return (custom?.yahoo_options_skew?.api_url ?? custom?.schwab?.api_url ?? "").replace(
      /\/$/,
      "",
    );
  }, []);

  useEffect(() => {
    if (!user) {
      setSymbol("");
      return;
    }
    void loadLastTicker("options-apr").then((ticker) => setSymbol(ticker ?? ""));
  }, [user]);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) {
      return;
    }

    chartRef.current = new Chart(context, {
      type: "line",
      data: { datasets: [] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        parsing: false,
        normalized: true,
        interaction: { intersect: false, mode: "nearest", axis: "xy" },
        plugins: {
          legend: { position: "bottom" },
          tooltip: {
            callbacks: {
              title(items) {
                const point = items[0]?.raw as ChartPoint | undefined;
                return point ? `${point.expirationDate} · ${point.optionType}` : "";
              },
              label(context) {
                const point = context.raw as ChartPoint;
                return [
                  `Strike: ${formatCurrency(point.strike)}`,
                  `Simple APR: ${point.y.toFixed(2)}%`,
                  `Expires without exercise: ${formatPercent(point.probabilityExpiresWorthless)}`,
                ];
              },
            },
          },
        },
        scales: {
          x: {
            type: "linear",
            title: { display: true, text: "Strike price" },
            ticks: { callback: (value) => `$${Number(value).toFixed(0)}` },
          },
          y: {
            title: { display: true, text: "Simple APR" },
            ticks: { callback: (value) => `${Number(value).toFixed(0)}%` },
          },
        },
      },
    });

    return () => {
      chartRef.current?.destroy();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) {
      return;
    }

    chart.data.datasets = chains.flatMap((chain, index) => {
      const color = CHART_COLORS[index % CHART_COLORS.length];
      return (["call", "put"] as const).map((optionType) => {
        const options = optionType === "call" ? chain.calls : chain.puts;
        const data: ChartPoint[] = options
          .filter((option) => option.simpleApr !== null)
          .map((option) => ({
            x: option.strike,
            y: (option.simpleApr ?? 0) * 100,
            expirationDate: chain.expirationDate,
            optionType,
            strike: option.strike,
            probabilityExpiresWorthless: option.probabilityExpiresWorthless,
          }));
        return {
          label: `${chain.expirationDate} ${optionType}`,
          data,
          borderColor: color,
          backgroundColor: color,
          borderDash: optionType === "put" ? [7, 4] : undefined,
          pointRadius: 1.5,
          pointHoverRadius: 5,
          borderWidth: 2,
          tension: 0.08,
          hidden: hiddenSeries.includes(`${chain.expirationDate}:${optionType}`),
        };
      });
    });
    chart.update();
  }, [chains, hiddenSeries]);

  function toggleSeries(seriesKey: string) {
    setHiddenSeries((current) =>
      current.includes(seriesKey)
        ? current.filter((value) => value !== seriesKey)
        : [...current, seriesKey],
    );
  }

  async function fetchJson<T>(url: string): Promise<T> {
    const response = await fetch(url, { headers: await getAuthHeaders() });
    const payload = (await response.json()) as T & { error?: string };
    if (!response.ok) {
      throw new Error(payload.error ?? "Yahoo Finance request failed.");
    }
    return payload;
  }

  async function handleLoadExpirations(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedSymbol = normalizeTicker(symbol);
    if (!user) {
      setError("Sign in to retrieve option chains.");
      return;
    }
    if (!apiBaseUrl) {
      setError("The Yahoo options API URL is not configured.");
      return;
    }
    if (!normalizedSymbol) {
      setError("Enter a ticker symbol.");
      return;
    }

    setIsLoadingExpirations(true);
    setError(null);
    setChains([]);
    setHiddenSeries([]);
    setExpirationDates([]);
    setSelectedExpirations([]);
    try {
      const params = new URLSearchParams({ symbol: normalizedSymbol });
      const result = await fetchJson<ExpirationsResponse>(
        `${apiBaseUrl}/yahoo-options-apr/expirations?${params}`,
      );
      setSymbol(result.symbol);
      setLoadedSymbol(result.symbol);
      setUnderlyingPrice(result.underlyingPrice);
      setExpirationDates(result.expirationDates);
      await saveLastTicker("options-apr", result.symbol);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to retrieve expirations.");
    } finally {
      setIsLoadingExpirations(false);
    }
  }

  function toggleExpiration(expiration: string) {
    setSelectedExpirations((current) =>
      current.includes(expiration)
        ? current.filter((value) => value !== expiration)
        : [...current, expiration].sort(),
    );
  }

  async function loadSelectedChains() {
    if (!loadedSymbol || selectedExpirations.length === 0) {
      setError("Select at least one expiration date.");
      return;
    }

    setIsLoadingChains(true);
    setError(null);
    setChains([]);
    const loadedChains: ChainResult[] = [];
    try {
      for (const [index, expiration] of selectedExpirations.entries()) {
        setProgress(`Retrieving ${index + 1} of ${selectedExpirations.length}: ${expiration}`);
        const params = new URLSearchParams({ symbol: loadedSymbol, expiration });
        const result = await fetchJson<ChainResponse>(
          `${apiBaseUrl}/yahoo-options-apr/chain?${params}`,
        );
        loadedChains.push(result.data);
        setChains([...loadedChains]);
      }
      setUnderlyingPrice(loadedChains[0]?.underlyingPrice ?? underlyingPrice);
      setProgress("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Unable to retrieve option chains.");
    } finally {
      setIsLoadingChains(false);
    }
  }

  return (
    <main className="skew-page options-apr-page">
      <a href="/">Back to landing page</a>
      <section className="skew-hero">
        <div>
          <p className="skew-kicker">Yahoo Finance Options</p>
          <h1>Options APR Explorer</h1>
          <p className="skew-intro">
            Compare covered-call and cash-secured-put premium returns by strike and expiration.
          </p>
        </div>
        <form className="options-apr-symbol-form" onSubmit={handleLoadExpirations}>
          <input
            aria-label="Ticker symbol"
            onChange={(event) => setSymbol(event.target.value)}
            placeholder="Ticker (e.g., MU)"
            type="text"
            value={symbol}
          />
          <button disabled={isLoadingExpirations || isLoadingChains} type="submit">
            {isLoadingExpirations ? "Retrieving..." : "Get Expiration Dates"}
          </button>
        </form>
      </section>

      {error ? <p className="skew-error">{error}</p> : null}
      {expirationDates.length > 0 ? (
        <section className="skew-panel">
          <div className="skew-panel-header">
            <div>
              <h2>Select Expirations</h2>
              <p>{expirationDates.length} dates available for {loadedSymbol}.</p>
            </div>
            <div className="options-apr-selection-actions">
              <button onClick={() => setSelectedExpirations(expirationDates)} type="button">
                Select all
              </button>
              <button onClick={() => setSelectedExpirations([])} type="button">
                Clear
              </button>
            </div>
          </div>
          <div className="options-apr-expirations">
            {expirationDates.map((expiration) => (
              <label key={expiration}>
                <input
                  checked={selectedExpirations.includes(expiration)}
                  onChange={() => toggleExpiration(expiration)}
                  type="checkbox"
                />
                {expiration}
              </label>
            ))}
          </div>
          <button
            disabled={isLoadingChains || selectedExpirations.length === 0}
            onClick={() => void loadSelectedChains()}
            type="button"
          >
            {isLoadingChains ? progress : `Retrieve ${selectedExpirations.length} Option Chain${selectedExpirations.length === 1 ? "" : "s"}`}
          </button>
        </section>
      ) : null}

      <section className="skew-panel">
        <div className="skew-panel-header">
          <div>
            <h2>Simple APR vs. Strike</h2>
            <p>Solid lines are calls; dashed lines are puts. Hover over any point for details.</p>
          </div>
          {underlyingPrice !== null ? (
            <div className="skew-value">
              <span>Underlying</span>
              <strong>{formatCurrency(underlyingPrice)}</strong>
            </div>
          ) : null}
        </div>
        <div className="options-apr-chart-wrap">
          <canvas ref={canvasRef} />
        </div>
        {chains.length > 0 ? (
          <div className="options-apr-series-controls" aria-label="Chart line visibility">
            {chains.flatMap((chain, index) =>
              (["call", "put"] as const).map((optionType) => {
                const seriesKey = `${chain.expirationDate}:${optionType}`;
                const color = CHART_COLORS[index % CHART_COLORS.length];
                return (
                  <label key={seriesKey}>
                    <input
                      checked={!hiddenSeries.includes(seriesKey)}
                      onChange={() => toggleSeries(seriesKey)}
                      type="checkbox"
                    />
                    <span
                      className={`options-apr-series-swatch is-${optionType}`}
                      style={{ borderColor: color }}
                    />
                    {chain.expirationDate} {optionType}
                  </label>
                );
              }),
            )}
          </div>
        ) : null}
        <p className="options-apr-method-note">
          Put APR uses strike as cash collateral. Call APR uses the current share price as covered-call collateral.
          Probability is a Black–Scholes risk-neutral estimate using Yahoo implied volatility and zero interest/dividend rates; it is not a forecast.
        </p>
      </section>

      {chains.map((chain) => (
        <section className="skew-panel" key={chain.expirationDate}>
          <h2>{chain.expirationDate} · {chain.daysToExpiration} days</h2>
          <div className="skew-table-wrap">
            <table className="skew-table options-apr-table">
              <thead>
                <tr>
                  <th>Type</th><th>Strike</th><th>Bid</th><th>Ask</th><th>Midpoint</th>
                  <th>Simple APR</th><th>Expires without exercise</th>
                </tr>
              </thead>
              <tbody>
                {[...chain.calls, ...chain.puts].map((option) => (
                  <tr key={option.contractSymbol}>
                    <td>{option.optionType}</td>
                    <td>{formatCurrency(option.strike)}</td>
                    <td>{formatCurrency(option.bid)}</td>
                    <td>{formatCurrency(option.ask)}</td>
                    <td>{formatCurrency(option.midpoint)}</td>
                    <td>{formatPercent(option.simpleApr)}</td>
                    <td>{formatPercent(option.probabilityExpiresWorthless)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </main>
  );
}

export default OptionsAprPage;
