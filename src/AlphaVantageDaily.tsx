import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import outputs from "../amplify_outputs.json";
import { getAuthHeaders } from "./auth";
import { loadLastTicker, saveLastTicker } from "./userPreferences";

type AlphaVantageDailyPoint = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
};

type AlphaVantageDailySeries = {
  symbol: string;
  points: Array<{
    date: string;
    values: AlphaVantageDailyPoint;
  }>;
  fetchedAt: string;
};

function parseDailySeries(data: unknown): AlphaVantageDailySeries["points"] {
  if (typeof data !== "object" || data === null) {
    return [];
  }

  const root = data as Record<string, unknown>;
  const series = root["Time Series (Daily)"];
  if (typeof series !== "object" || series === null) {
    return [];
  }

  return Object.entries(series as Record<string, Record<string, string>>)
    .map(([date, values]) => ({
      date,
      values: {
        open: Number(values["1. open"]),
        high: Number(values["2. high"]),
        low: Number(values["3. low"]),
        close: Number(values["4. close"]),
        volume:
          typeof values["5. volume"] === "string" ? Number(values["5. volume"]) : null,
      },
    }))
    .filter(
      (entry) =>
        Number.isFinite(entry.values.open) &&
        Number.isFinite(entry.values.high) &&
        Number.isFinite(entry.values.low) &&
        Number.isFinite(entry.values.close),
    )
    .sort((left, right) => left.date.localeCompare(right.date));
}

function formatPrice(value: number | null) {
  if (value === null) {
    return "--";
  }

  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return date.toLocaleString();
}

function drawCandles(
  canvas: HTMLCanvasElement,
  points: AlphaVantageDailySeries["points"],
) {
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 900;
  const height = canvas.clientHeight || 360;

  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);

  if (points.length === 0) {
    context.fillStyle = "#555";
    context.font = "14px sans-serif";
    context.fillText("No daily data available.", 20, 24);
    return;
  }

  const padding = {
    top: 20,
    right: 16,
    bottom: 28,
    left: 64,
  };

  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const high = Math.max(...points.map((point) => point.values.high));
  const low = Math.min(...points.map((point) => point.values.low));
  const priceRange = Math.max(high - low, 0.01);
  const stepX = chartWidth / Math.max(points.length, 1);
  const candleWidth = Math.max(Math.min(stepX * 0.6, 14), 3);

  const toY = (price: number) =>
    padding.top + ((high - price) / priceRange) * chartHeight;

  context.strokeStyle = "rgba(28, 20, 64, 0.14)";
  context.lineWidth = 1;
  context.font = "12px sans-serif";
  context.fillStyle = "#333";

  for (let index = 0; index < 5; index += 1) {
    const ratio = index / 4;
    const y = padding.top + ratio * chartHeight;
    const price = high - ratio * priceRange;

    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();

    context.fillText(formatPrice(price), 8, y + 4);
  }

  context.strokeStyle = "#1c1440";
  context.lineWidth = 1;

  points.forEach((point, index) => {
    const centerX = padding.left + stepX * index + stepX / 2;
    const openY = toY(point.values.open);
    const closeY = toY(point.values.close);
    const highY = toY(point.values.high);
    const lowY = toY(point.values.low);
    const isUpDay = point.values.close >= point.values.open;
    const candleTop = Math.min(openY, closeY);
    const candleHeight = Math.max(Math.abs(closeY - openY), 1);

    context.strokeStyle = isUpDay ? "#1f7a1f" : "#b42318";
    context.fillStyle = isUpDay ? "#1f7a1f" : "#b42318";

    context.beginPath();
    context.moveTo(centerX, highY);
    context.lineTo(centerX, lowY);
    context.stroke();

    context.fillRect(
      centerX - candleWidth / 2,
      candleTop,
      candleWidth,
      candleHeight,
    );
  });

  const labelStep = Math.max(Math.ceil(points.length / 6), 1);
  context.fillStyle = "#333";
  context.textAlign = "center";

  points.forEach((point, index) => {
    if (index % labelStep !== 0 && index !== points.length - 1) {
      return;
    }

    const centerX = padding.left + stepX * index + stepX / 2;
    context.fillText(point.date, centerX, height - 8);
  });

  context.textAlign = "start";
}

function AlphaVantageDaily() {
  const { user } = useAuthenticator((context) => [context.user]);
  const [symbol, setSymbol] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState(
    "Checking Alpha Vantage configuration...",
  );
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AlphaVantageDailySeries | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const apiBaseUrl = useMemo(() => {
    const configUrl =
      (outputs as { custom?: { alphavantage?: { api_url?: string } } }).custom?.alphavantage
        ?.api_url ?? import.meta.env.VITE_ALPHAVANTAGE_API_URL;

    return configUrl?.replace(/\/$/, "") ?? "";
  }, []);

  const statusUrl = apiBaseUrl ? `${apiBaseUrl}/alphavantage/status` : "";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    drawCandles(canvas, result?.points ?? []);

    const handleResize = () => {
      drawCandles(canvas, result?.points ?? []);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [result]);

  useEffect(() => {
    if (!user) {
      setSymbol("");
      setConnectionStatus("Sign in to use Alpha Vantage.");
      setIsCheckingStatus(false);
      return;
    }

    void loadLastTicker("alphavantage-daily").then((savedTicker) => {
      if (savedTicker) {
        setSymbol(savedTicker);
      }
    });
  }, [user]);

  useEffect(() => {
    async function checkStatus() {
      if (!user) {
        return;
      }

      if (!apiBaseUrl || !statusUrl) {
        setConnectionStatus("Alpha Vantage API URL is not configured.");
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
          setConnectionStatus("Alpha Vantage ready.");
        } else {
          setConnectionStatus(
            payload.detail ?? payload.error ?? "Alpha Vantage is not configured.",
          );
        }
      } catch {
        setConnectionStatus("Unable to verify Alpha Vantage configuration.");
      } finally {
        setIsCheckingStatus(false);
      }
    }

    void checkStatus();
  }, [apiBaseUrl, statusUrl, user]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedSymbol = symbol.trim().toUpperCase();
    if (!trimmedSymbol) {
      setError("Please enter a ticker symbol.");
      return;
    }

    if (!apiBaseUrl) {
      setError(
        "Alpha Vantage API URL is not configured in outputs or VITE_ALPHAVANTAGE_API_URL.",
      );
      return;
    }

    if (!user) {
      setError("Sign in to use Alpha Vantage.");
      return;
    }

    setError(null);
    setResult(null);
    setIsLoading(true);
    await saveLastTicker("alphavantage-daily", trimmedSymbol);

    try {
      const response = await fetch(
        `${apiBaseUrl}/alphavantage/daily?symbol=${encodeURIComponent(trimmedSymbol)}`,
        {
          headers: await getAuthHeaders(),
        },
      );
      const payload = (await response.json()) as {
        error?: string;
        details?: unknown;
        symbol?: string;
        data?: unknown;
      };

      if (!response.ok || !payload.data) {
        throw new Error(
          payload.details
            ? `${payload.error ?? "Unable to retrieve daily series."} ${typeof payload.details === "string" ? payload.details : JSON.stringify(payload.details)}`
            : (payload.error ?? "Unable to retrieve daily series."),
        );
      }

      setResult({
        symbol: payload.symbol ?? trimmedSymbol,
        points: parseDailySeries(payload.data),
        fetchedAt: new Date().toISOString(),
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
    <main>
      <a href="/">Back to landing page</a>
      <h1>Alpha Vantage Daily</h1>
      <p>Graph Alpha Vantage TIME_SERIES_DAILY as daily candles for a ticker symbol.</p>
      <p>{connectionStatus}</p>
      <form onSubmit={handleSubmit}>
        <input
          aria-label="Ticker symbol"
          disabled={isCheckingStatus}
          onChange={(event) => setSymbol(event.target.value)}
          placeholder="Ticker (e.g., AAPL)"
          type="text"
          value={symbol}
        />
        <button disabled={isLoading || isCheckingStatus} type="submit">
          {isLoading ? "Loading..." : "Submit"}
        </button>
      </form>
      {error ? <p>{error}</p> : null}
      {result ? (
        <section>
          <h2>{result.symbol}</h2>
          <div style={{ height: "360px", marginBottom: "16px" }}>
            <canvas
              ref={canvasRef}
              style={{ width: "100%", height: "100%", display: "block" }}
            />
          </div>
          {latestPoint ? (
            <div
              style={{
                background: "white",
                borderRadius: "10px",
                border: "1px solid #222",
                padding: "12px",
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: "8px 16px",
                textAlign: "left",
              }}
            >
              <strong>Latest Trading Day</strong>
              <span>{latestPoint.date}</span>
              <strong>Open</strong>
              <span>{formatPrice(latestPoint.values.open)}</span>
              <strong>High</strong>
              <span>{formatPrice(latestPoint.values.high)}</span>
              <strong>Low</strong>
              <span>{formatPrice(latestPoint.values.low)}</span>
              <strong>Close</strong>
              <span>{formatPrice(latestPoint.values.close)}</span>
              <strong>Retrieved</strong>
              <span>{formatTimestamp(result.fetchedAt)}</span>
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

export default AlphaVantageDaily;
