import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Chart } from "chart.js/auto";
import { useAuthenticator } from "@aws-amplify/ui-react";
import outputs from "../amplify_outputs.json";
import { getAuthHeaders } from "./auth";
import { loadLastTicker, saveLastTicker } from "./userPreferences";

type EvaluationPoint = {
  symbol: string;
  timestamp: string;
  currentPrice: number;
  buyScore: number;
  sellScore: number;
};

type EvaluationSeriesResponse = {
  symbol: string;
  points: EvaluationPoint[];
};

function formatPrice(value: number | null) {
  if (value === null) {
    return "--";
  }

  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercent(value: number | null) {
  if (value === null) {
    return "--";
  }

  return `${(value * 100).toLocaleString(undefined, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function getPriceAxisRange(points: EvaluationPoint[]) {
  if (points.length === 0) {
    return {
      min: 0,
      max: 1,
    };
  }

  const prices = points.map((point) => point.currentPrice);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const spread = Math.max(maxPrice - minPrice, Math.max(minPrice * 0.01, 0.25));

  return {
    min: Math.max(0, minPrice - spread * 0.1),
    max: maxPrice + spread * 0.1,
  };
}

function StockAnalyzerEvaluationsPage() {
  const { user } = useAuthenticator((context) => [context.user]);
  const [symbol, setSymbol] = useState("");
  const [symbols, setSymbols] = useState<string[]>([]);
  const [limit, setLimit] = useState("250");
  const [isLoadingSymbols, setIsLoadingSymbols] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EvaluationSeriesResponse | null>(null);
  const chartRef = useRef<Chart<"line"> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const apiBaseUrl = useMemo(() => {
    const configUrl =
      (outputs as { custom?: { schwab?: { api_url?: string } } }).custom?.schwab?.api_url ??
      import.meta.env.VITE_STOCK_ANALYZER_API_URL;

    return configUrl?.replace(/\/$/, "") ?? "";
  }, []);

  useEffect(() => {
    if (!user) {
      setSymbol("");
      setSymbols([]);
      return;
    }

    async function loadSymbols() {
      if (!apiBaseUrl) {
        setError("API URL is not configured in outputs or VITE_STOCK_ANALYZER_API_URL.");
        return;
      }

      setIsLoadingSymbols(true);

      try {
        const [savedTicker, response] = await Promise.all([
          loadLastTicker("stock-analyzer-evaluations"),
          fetch(`${apiBaseUrl}/stock-analyzer/symbols`, {
            headers: await getAuthHeaders(),
          }),
        ]);
        const payload = (await response.json()) as {
          error?: string;
          symbols?: string[];
        };

        if (!response.ok || !Array.isArray(payload.symbols)) {
          throw new Error(payload.error ?? "Unable to retrieve configured symbols.");
        }

        const options = payload.symbols;
        setSymbols(options);

        if (savedTicker && options.includes(savedTicker.toUpperCase())) {
          setSymbol(savedTicker.toUpperCase());
        } else if (options[0]) {
          setSymbol(options[0]);
        } else {
          setSymbol("");
        }
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Unable to load configured symbols.",
        );
      } finally {
        setIsLoadingSymbols(false);
      }
    }

    void loadSymbols();
  }, [apiBaseUrl, user]);

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
            label: "Current Price",
            data: [],
            yAxisID: "yPrice",
            borderColor: "#0f766e",
            backgroundColor: "rgba(15, 118, 110, 0.18)",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
          },
          {
            label: "Buy Score",
            data: [],
            yAxisID: "yScore",
            borderColor: "#2563eb",
            backgroundColor: "rgba(37, 99, 235, 0.18)",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
          },
          {
            label: "Sell Score",
            data: [],
            yAxisID: "yScore",
            borderColor: "#b91c1c",
            backgroundColor: "rgba(185, 28, 28, 0.18)",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.2,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: "index",
          intersect: false,
        },
        plugins: {
          tooltip: {
            callbacks: {
              label(context) {
                const datasetLabel = context.dataset.label ?? "";
                const value = Number(context.parsed.y);

                if (context.dataset.yAxisID === "yScore") {
                  return `${datasetLabel}: ${formatPercent(value)}`;
                }

                return `${datasetLabel}: ${formatPrice(value)}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: {
              maxRotation: 0,
              autoSkip: true,
              maxTicksLimit: 8,
            },
            title: {
              display: true,
              text: "Evaluation Time",
            },
          },
          yPrice: {
            position: "left",
            title: {
              display: true,
              text: "Current Price",
            },
          },
          yScore: {
            position: "right",
            min: 0,
            max: 1,
            grid: {
              drawOnChartArea: false,
            },
            ticks: {
              callback(value) {
                return `${Number(value) * 100}%`;
              },
            },
            title: {
              display: true,
              text: "Buy / Sell Score",
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

    const points = result?.points ?? [];
    const priceRange = getPriceAxisRange(points);

    chart.data.labels = points.map((point) => formatTimestamp(point.timestamp));
    chart.data.datasets[0].data = points.map((point) => point.currentPrice);
    chart.data.datasets[1].data = points.map((point) => point.buyScore);
    chart.data.datasets[2].data = points.map((point) => point.sellScore);
    chart.options.scales = {
      ...chart.options.scales,
      yPrice: {
        ...chart.options.scales?.yPrice,
        min: priceRange.min,
        max: priceRange.max,
      },
    };
    chart.update();
  }, [result]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedSymbol = symbol.trim().toUpperCase();
    if (!trimmedSymbol) {
      setError("Please enter a ticker symbol.");
      return;
    }

    if (!apiBaseUrl) {
      setError("API URL is not configured in outputs or VITE_STOCK_ANALYZER_API_URL.");
      return;
    }

    if (!user) {
      setError("Sign in to use the stock analyzer chart.");
      return;
    }

    setError(null);
    setResult(null);
    setIsLoading(true);
    await saveLastTicker("stock-analyzer-evaluations", trimmedSymbol);

    try {
      const response = await fetch(
        `${apiBaseUrl}/stock-analyzer/evaluations?symbol=${encodeURIComponent(trimmedSymbol)}&limit=${encodeURIComponent(limit)}`,
        {
          headers: await getAuthHeaders(),
        },
      );
      const payload = (await response.json()) as {
        error?: string;
        symbol?: string;
        points?: EvaluationPoint[];
      };

      if (!response.ok || !Array.isArray(payload.points)) {
        throw new Error(payload.error ?? "Unable to retrieve evaluation series.");
      }

      setResult({
        symbol: payload.symbol ?? trimmedSymbol,
        points: payload.points,
      });
    } catch (submitError) {
      setError(
        submitError instanceof Error ? submitError.message : "An unknown error occurred.",
      );
    } finally {
      setIsLoading(false);
    }
  }

  const latestPoint = result?.points[result.points.length - 1] ?? null;

  return (
    <main className="stock-evaluations-page">
      <a href="/">Back to landing page</a>
      <h1>Stock Analyzer Evaluations</h1>
      <p>
        Plot `CurrentPrice`, `BuyScore`, and `SellScore` from the existing
        `stock-analyzer-evaluations` DynamoDB table.
      </p>
      <form className="stock-evaluations-form" onSubmit={handleSubmit}>
        <select
          aria-label="Ticker symbol"
          disabled={isLoadingSymbols || symbols.length === 0}
          onChange={(event) => setSymbol(event.target.value)}
          value={symbol}
        >
          {symbols.length === 0 ? (
            <option value="">
              {isLoadingSymbols ? "Loading symbols..." : "No symbols configured"}
            </option>
          ) : null}
          {symbols.map((ticker) => (
            <option key={ticker} value={ticker}>
              {ticker}
            </option>
          ))}
        </select>
        <input
          aria-label="Point limit"
          inputMode="numeric"
          min="1"
          onChange={(event) => setLimit(event.target.value)}
          placeholder="Point limit"
          type="number"
          value={limit}
        />
        <button disabled={isLoading || isLoadingSymbols || symbols.length === 0} type="submit">
          {isLoading ? "Loading..." : "Plot"}
        </button>
      </form>
      {error ? <p>{error}</p> : null}
      <section className="stock-evaluations-chart-panel">
        <div className="stock-evaluations-chart-wrap">
          <canvas ref={canvasRef} />
        </div>
      </section>
      {latestPoint ? (
        <section className="stock-evaluations-summary">
          <h2>{result?.symbol}</h2>
          <div className="stock-evaluations-summary-grid">
            <strong>Latest Timestamp</strong>
            <span>{formatTimestamp(latestPoint.timestamp)}</span>
            <strong>Current Price</strong>
            <span>{formatPrice(latestPoint.currentPrice)}</span>
            <strong>Buy Score</strong>
            <span>{formatPercent(latestPoint.buyScore)}</span>
            <strong>Sell Score</strong>
            <span>{formatPercent(latestPoint.sellScore)}</span>
            <strong>Points Loaded</strong>
            <span>{result?.points.length ?? 0}</span>
          </div>
        </section>
      ) : null}
    </main>
  );
}

export default StockAnalyzerEvaluationsPage;
