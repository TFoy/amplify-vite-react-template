import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Chart } from "chart.js/auto";
import { useAuthenticator } from "@aws-amplify/ui-react";
import outputs from "../amplify_outputs.json";
import { getAuthHeaders } from "./auth";
import { loadLastTicker, saveLastTicker } from "./userPreferences";

type TermSkewPoint = {
  expirationDate: string;
  underlyingPrice: number;
  callCount: number;
  putCount: number;
  tenPercentOtmSkew: number | null;
  averageOtmSkew: number | null;
  atTheMoneySkew: number | null;
};

type YahooOptionsTermSkewResponse = {
  symbol: string;
  data: {
    underlyingPrice: number | null;
    expirationDates: string[];
    requestedExpirations: number;
    yahooDelayMs: number;
    points: TermSkewPoint[];
  };
};

type AmplifyCustomOutputs = {
  custom?: {
    yahoo_options_skew?: { api_url?: string };
    schwab?: { api_url?: string };
    tasty?: { api_url?: string };
    tasty_rest?: { api_url?: string };
    finnhub?: { api_url?: string };
    alphavantage?: { api_url?: string };
    massive?: { api_url?: string };
    stock_analyzer?: { api_url?: string };
  };
};

const DEFAULT_MAX_EXPIRATIONS = 12;
const DEFAULT_DELAY_MS = 800;
const MAX_EXPIRATIONS_OPTIONS = [6, 12, 18] as const;

function formatCurrency(value: number | null) {
  if (value === null) {
    return "--";
  }

  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatSkew(value: number | null) {
  if (value === null) {
    return "--";
  }

  const percentagePoints = value * 100;
  const sign = percentagePoints > 0 ? "+" : "";
  return `${sign}${percentagePoints.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} pts`;
}

function getSkewTone(value: number | null) {
  if (value === null) {
    return "No data";
  }

  if (value > 0.02) {
    return "Put IV premium";
  }

  if (value < -0.02) {
    return "Call IV premium";
  }

  return "Balanced";
}

function getLatestPoint(points: TermSkewPoint[]) {
  return points.length > 0 ? points[points.length - 1] : null;
}

function toChartValue(value: number | null) {
  return value === null ? null : value * 100;
}

function normalizeTicker(value: string | null) {
  return value?.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, "") ?? "";
}

function getUrlTicker() {
  const searchParams = new URLSearchParams(window.location.search);
  const queryTicker = normalizeTicker(searchParams.get("symbol") ?? searchParams.get("ticker"));
  if (queryTicker) {
    return queryTicker;
  }

  const pathMatch = window.location.pathname.match(/^\/yahoo-options-skew\/([^/]+)$/);
  return normalizeTicker(pathMatch?.[1] ? decodeURIComponent(pathMatch[1]) : null);
}

function getUrlMaxExpirations() {
  const searchParams = new URLSearchParams(window.location.search);
  const rawValue = searchParams.get("maxExpirations") ?? searchParams.get("expirations");
  const parsedValue = rawValue ? Number.parseInt(rawValue, 10) : DEFAULT_MAX_EXPIRATIONS;

  return MAX_EXPIRATIONS_OPTIONS.includes(parsedValue as (typeof MAX_EXPIRATIONS_OPTIONS)[number])
    ? parsedValue
    : DEFAULT_MAX_EXPIRATIONS;
}

function updateSkewUrl(symbol: string, maxExpirations: number) {
  const searchParams = new URLSearchParams();
  if (maxExpirations !== DEFAULT_MAX_EXPIRATIONS) {
    searchParams.set("maxExpirations", String(maxExpirations));
  }

  const query = searchParams.toString();
  const nextUrl = `/yahoo-options-skew/${encodeURIComponent(symbol)}${query ? `?${query}` : ""}`;
  window.history.replaceState(null, "", nextUrl);
}

function YahooOptionsSkewPage() {
  const { user } = useAuthenticator((context) => [context.user]);
  const initialUrlTicker = useMemo(getUrlTicker, []);
  const [symbol, setSymbol] = useState(initialUrlTicker);
  const [maxExpirations, setMaxExpirations] = useState(getUrlMaxExpirations);
  const [connectionStatus, setConnectionStatus] = useState("Checking Yahoo Finance access...");
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<YahooOptionsTermSkewResponse | null>(null);
  const chartRef = useRef<Chart<"line"> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hasLoadedUrlTickerRef = useRef(false);

  const hasYahooOutput = useMemo(
    () => Boolean((outputs as AmplifyCustomOutputs).custom?.yahoo_options_skew?.api_url),
    [],
  );

  const apiBaseUrl = useMemo(() => {
    const customOutputs = (outputs as AmplifyCustomOutputs).custom;
    const configUrl =
      customOutputs?.yahoo_options_skew?.api_url ??
      customOutputs?.schwab?.api_url ??
      customOutputs?.tasty?.api_url ??
      customOutputs?.tasty_rest?.api_url ??
      customOutputs?.finnhub?.api_url ??
      customOutputs?.alphavantage?.api_url ??
      customOutputs?.massive?.api_url ??
      customOutputs?.stock_analyzer?.api_url ??
      import.meta.env.VITE_YAHOO_OPTIONS_SKEW_API_URL;

    return configUrl?.replace(/\/$/, "") ?? "";
  }, []);

  const statusUrl = apiBaseUrl ? `${apiBaseUrl}/yahoo-options-skew/status` : "";

  useEffect(() => {
    if (!user) {
      setSymbol("");
      setConnectionStatus("Sign in to calculate options skew.");
      setIsCheckingStatus(false);
      return;
    }

    void loadLastTicker("yahoo-options-skew").then((savedTicker) => {
      if (!initialUrlTicker && savedTicker) {
        setSymbol(savedTicker);
      }
    });
  }, [initialUrlTicker, user]);

  useEffect(() => {
    async function checkStatus() {
      if (!user) {
        return;
      }

      if (!apiBaseUrl || !statusUrl) {
        setConnectionStatus("Yahoo options skew API URL is not configured.");
        setIsCheckingStatus(false);
        return;
      }

      try {
        const response = await fetch(statusUrl, {
          headers: await getAuthHeaders(),
        });
        const payload = (await response.json()) as {
          connected?: boolean;
          detail?: string;
          error?: string;
        };

        if (response.ok && payload.connected) {
          setConnectionStatus("Yahoo Finance option chain ready.");
        } else {
          setConnectionStatus(payload.detail ?? payload.error ?? "Yahoo Finance is unavailable.");
        }
      } catch {
        setConnectionStatus(
          hasYahooOutput
            ? "Unable to verify Yahoo Finance access."
            : "Yahoo options skew backend route is not in amplify_outputs.json yet. Deploy the updated Amplify backend.",
        );
      } finally {
        setIsCheckingStatus(false);
      }
    }

    void checkStatus();
  }, [apiBaseUrl, hasYahooOutput, statusUrl, user]);

  useEffect(() => {
    const context = canvasRef.current?.getContext("2d");
    if (!context) {
      return;
    }

    chartRef.current = new Chart(context, {
      type: "line",
      data: {
        labels: [],
        datasets: [
          {
            label: "10% OTM skew",
            data: [],
            borderColor: "#2f655f",
            backgroundColor: "rgba(47, 101, 95, 0.14)",
            tension: 0.28,
            spanGaps: true,
          },
          {
            label: "Average OTM skew",
            data: [],
            borderColor: "#8f5a20",
            backgroundColor: "rgba(143, 90, 32, 0.14)",
            borderDash: [6, 4],
            tension: 0.28,
            spanGaps: true,
          },
          {
            label: "ATM skew",
            data: [],
            borderColor: "#314f86",
            backgroundColor: "rgba(49, 79, 134, 0.14)",
            borderDash: [2, 4],
            tension: 0.28,
            spanGaps: true,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          intersect: false,
          mode: "index",
        },
        plugins: {
          legend: {
            position: "bottom",
          },
          tooltip: {
            callbacks: {
              label(context) {
                const value = typeof context.parsed.y === "number" ? context.parsed.y : null;
                return `${context.dataset.label}: ${
                  value === null ? "--" : `${value.toFixed(2)} pts`
                }`;
              },
            },
          },
        },
        scales: {
          y: {
            title: {
              display: true,
              text: "Put IV minus call IV, percentage points",
            },
            ticks: {
              callback(value) {
                return `${Number(value).toFixed(1)} pts`;
              },
            },
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

    const points = result?.data.points ?? [];
    chart.data.labels = points.map((point) => point.expirationDate);
    chart.data.datasets[0].data = points.map((point) => toChartValue(point.tenPercentOtmSkew));
    chart.data.datasets[1].data = points.map((point) => toChartValue(point.averageOtmSkew));
    chart.data.datasets[2].data = points.map((point) => toChartValue(point.atTheMoneySkew));
    chart.update();
  }, [result]);

  async function loadTermSkew(trimmedSymbol: string, expirationCount: number) {
    if (!trimmedSymbol) {
      setError("Please enter a ticker symbol.");
      return;
    }

    if (!apiBaseUrl) {
      setError("Yahoo options skew API URL is not configured.");
      return;
    }

    if (!user) {
      setError("Sign in to calculate options skew.");
      return;
    }

    setError(null);
    setResult(null);
    setIsLoading(true);
    await saveLastTicker("yahoo-options-skew", trimmedSymbol);
    updateSkewUrl(trimmedSymbol, expirationCount);

    try {
      const searchParams = new URLSearchParams({
        symbol: trimmedSymbol,
        maxExpirations: String(expirationCount),
        delayMs: String(DEFAULT_DELAY_MS),
      });

      const response = await fetch(`${apiBaseUrl}/yahoo-options-skew/term-skew?${searchParams}`, {
        headers: await getAuthHeaders(),
      });
      const payload = (await response.json()) as YahooOptionsTermSkewResponse & {
        error?: string;
      };

      if (!response.ok || !payload.data) {
        throw new Error(
          payload.error ??
            (hasYahooOutput
              ? "Unable to calculate options skew."
              : "Yahoo options skew backend route has not been deployed yet."),
        );
      }

      setResult(payload);
    } catch (submitError) {
      setError(
        submitError instanceof Error && submitError.message !== "Failed to fetch"
          ? submitError.message
          : hasYahooOutput
            ? "Unable to reach the Yahoo options skew API."
            : "Yahoo options skew backend route has not been deployed yet.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (hasLoadedUrlTickerRef.current || !initialUrlTicker || !user || !apiBaseUrl) {
      return;
    }

    hasLoadedUrlTickerRef.current = true;
    void loadTermSkew(initialUrlTicker, maxExpirations);
  }, [apiBaseUrl, initialUrlTicker, maxExpirations, user]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await loadTermSkew(normalizeTicker(symbol), maxExpirations);
  }

  const latestPoint = getLatestPoint(result?.data.points ?? []);
  const primarySkew = latestPoint?.tenPercentOtmSkew ?? null;

  return (
    <main className="skew-page">
      <a href="/">Back to landing page</a>
      <section className="skew-hero">
        <div>
          <p className="skew-kicker">Yahoo Finance Options</p>
          <h1>Skew Term Structure</h1>
          <p className="skew-intro">
            Chart put IV minus call IV across option expirations for a ticker symbol.
          </p>
        </div>
        <form className="skew-form skew-form-term" onSubmit={handleSubmit}>
          <input
            aria-label="Ticker symbol"
            disabled={isCheckingStatus}
            onChange={(event) => setSymbol(event.target.value)}
            placeholder="Ticker (e.g., SPY)"
            type="text"
            value={symbol}
          />
          <select
            aria-label="Maximum expirations"
            disabled={isCheckingStatus || isLoading}
            onChange={(event) => setMaxExpirations(Number(event.target.value))}
            value={maxExpirations}
          >
            {MAX_EXPIRATIONS_OPTIONS.map((expirationCount) => (
              <option key={expirationCount} value={expirationCount}>
                {expirationCount} expirations
              </option>
            ))}
          </select>
          <button disabled={isLoading || isCheckingStatus} type="submit">
            {isLoading ? "Charting..." : "Chart Skew"}
          </button>
        </form>
      </section>
      <p className="skew-status">{connectionStatus}</p>
      {error ? <p className="skew-error">{error}</p> : null}
      <section className="skew-panel">
        <div className="skew-panel-header">
          <div>
            <h2>Skew vs. Expiration</h2>
            <p>
              Yahoo requests are made one at a time with an {DEFAULT_DELAY_MS} ms delay between
              expiration calls.
            </p>
          </div>
          {result ? (
            <div className="skew-value">
              <strong>{formatSkew(primarySkew)}</strong>
              <span>{getSkewTone(primarySkew)}</span>
            </div>
          ) : null}
        </div>
        <div className="skew-chart-wrap">
          <canvas ref={canvasRef} />
        </div>
      </section>
      {result ? (
        <>
          <section className="skew-summary-grid">
            <article>
              <span>Symbol</span>
              <strong>{result.symbol}</strong>
            </article>
            <article>
              <span>Underlying</span>
              <strong>{formatCurrency(result.data.underlyingPrice)}</strong>
            </article>
            <article>
              <span>Expirations</span>
              <strong>
                {result.data.points.length} / {result.data.expirationDates.length}
              </strong>
            </article>
            <article>
              <span>Throttle</span>
              <strong>{result.data.yahooDelayMs} ms</strong>
            </article>
          </section>
          <section className="skew-panel">
            <h2>Expiration Detail</h2>
            <div className="skew-table-wrap">
              <table className="skew-table">
                <thead>
                  <tr>
                    <th>Expiration</th>
                    <th>10% OTM</th>
                    <th>Average OTM</th>
                    <th>ATM</th>
                    <th>Contracts</th>
                  </tr>
                </thead>
                <tbody>
                  {result.data.points.map((point) => (
                    <tr key={point.expirationDate}>
                      <td>{point.expirationDate}</td>
                      <td>{formatSkew(point.tenPercentOtmSkew)}</td>
                      <td>{formatSkew(point.averageOtmSkew)}</td>
                      <td>{formatSkew(point.atTheMoneySkew)}</td>
                      <td>
                        {point.putCount} puts / {point.callCount} calls
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </main>
  );
}

export default YahooOptionsSkewPage;
