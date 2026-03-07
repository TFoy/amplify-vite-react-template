import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import outputs from "../amplify_outputs.json";
import { getAuthHeaders } from "./auth";
import { loadLastTicker, saveLastTicker } from "./userPreferences";

type MassiveDividendPoint = {
  date: string;
  cashAmount: number;
  payDate: string | null;
  frequency: string | number | null;
  dividendType: string | null;
  distributionType: string | null;
};

type MassiveDividendSeries = {
  symbol: string;
  points: MassiveDividendPoint[];
  fetchedAt: string;
};

function parseDividendSeries(data: unknown): MassiveDividendPoint[] {
  if (typeof data !== "object" || data === null) {
    return [];
  }

  const root = data as { results?: unknown };
  if (!Array.isArray(root.results)) {
    return [];
  }

  return root.results
    .map((entry) => {
      const row = entry as Record<string, unknown>;
      const dateValue =
        typeof row.ex_dividend_date === "string" ? row.ex_dividend_date : "";
      const cashAmount =
        typeof row.cash_amount === "number" ? row.cash_amount : Number.NaN;

      return {
        date: dateValue,
        cashAmount,
        payDate: typeof row.pay_date === "string" ? row.pay_date : null,
        frequency:
          typeof row.frequency === "string" || typeof row.frequency === "number"
            ? row.frequency
            : null,
        dividendType:
          typeof row.dividend_type === "string" ? row.dividend_type : null,
        distributionType:
          typeof row.distribution_type === "string" ? row.distribution_type : null,
      };
    })
    .filter((point) => point.date && Number.isFinite(point.cashAmount))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function formatCashAmount(value: number | null) {
  if (value === null) {
    return "--";
  }

  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return date.toLocaleString();
}

function drawDividendBars(canvas: HTMLCanvasElement, points: MassiveDividendPoint[]) {
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
    context.fillText("No dividend history available.", 20, 24);
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
  const high = Math.max(...points.map((point) => point.cashAmount), 0.01);
  const stepX = chartWidth / Math.max(points.length, 1);
  const barWidth = Math.max(Math.min(stepX * 0.65, 14), 3);

  const toY = (cashAmount: number) =>
    padding.top + ((high - cashAmount) / high) * chartHeight;

  context.strokeStyle = "rgba(28, 20, 64, 0.14)";
  context.lineWidth = 1;
  context.font = "12px sans-serif";
  context.fillStyle = "#333";

  for (let index = 0; index < 5; index += 1) {
    const ratio = index / 4;
    const y = padding.top + ratio * chartHeight;
    const amount = high - ratio * high;

    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();

    context.fillText(formatCashAmount(amount), 8, y + 4);
  }

  context.fillStyle = "#1c1440";

  points.forEach((point, index) => {
    const centerX = padding.left + stepX * index + stepX / 2;
    const y = toY(point.cashAmount);
    const barHeight = padding.top + chartHeight - y;

    context.fillRect(centerX - barWidth / 2, y, barWidth, barHeight);
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

function MassiveDividends() {
  const { user } = useAuthenticator((context) => [context.user]);
  const [symbol, setSymbol] = useState("");
  const [limit, setLimit] = useState("100");
  const [isLoading, setIsLoading] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState(
    "Checking Massive configuration...",
  );
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<MassiveDividendSeries | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const apiBaseUrl = useMemo(() => {
    const configUrl =
      (outputs as { custom?: { massive?: { api_url?: string } } }).custom?.massive
        ?.api_url ?? import.meta.env.VITE_MASSIVE_API_URL;

    return configUrl?.replace(/\/$/, "") ?? "";
  }, []);

  const statusUrl = apiBaseUrl ? `${apiBaseUrl}/massive/status` : "";

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    drawDividendBars(canvas, result?.points ?? []);

    const handleResize = () => {
      drawDividendBars(canvas, result?.points ?? []);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [result]);

  useEffect(() => {
    if (!user) {
      setSymbol("");
      setConnectionStatus("Sign in to use Massive.");
      setIsCheckingStatus(false);
      return;
    }

    void loadLastTicker("massive-dividends").then((savedTicker) => {
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
        setConnectionStatus("Massive API URL is not configured.");
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
          setConnectionStatus("Massive ready.");
        } else {
          setConnectionStatus(
            payload.detail ?? payload.error ?? "Massive is not configured.",
          );
        }
      } catch {
        setConnectionStatus("Unable to verify Massive configuration.");
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
      setError("Massive API URL is not configured in outputs or VITE_MASSIVE_API_URL.");
      return;
    }

    if (!user) {
      setError("Sign in to use Massive.");
      return;
    }

    const parsedLimit = Number(limit);
    const normalizedLimit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.trunc(parsedLimit), 1000)
        : 100;

    setError(null);
    setResult(null);
    setIsLoading(true);
    await saveLastTicker("massive-dividends", trimmedSymbol);

    try {
      const response = await fetch(
        `${apiBaseUrl}/massive/dividends?symbol=${encodeURIComponent(trimmedSymbol)}&limit=${normalizedLimit}`,
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
            ? `${payload.error ?? "Unable to retrieve dividend history."} ${typeof payload.details === "string" ? payload.details : JSON.stringify(payload.details)}`
            : (payload.error ?? "Unable to retrieve dividend history."),
        );
      }

      setResult({
        symbol: payload.symbol ?? trimmedSymbol,
        points: parseDividendSeries(payload.data),
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
      <h1>Massive Historical Dividends</h1>
      <p>Graph Massive dividend history by ex-dividend date for a ticker symbol.</p>
      <p>{connectionStatus}</p>
      <form onSubmit={handleSubmit}>
        <input
          aria-label="Ticker symbol"
          disabled={isCheckingStatus}
          onChange={(event) => setSymbol(event.target.value)}
          placeholder="Ticker (e.g., NLCP)"
          type="text"
          value={symbol}
        />
        <input
          aria-label="Result limit"
          disabled={isCheckingStatus}
          min={1}
          onChange={(event) => setLimit(event.target.value)}
          placeholder="Limit (e.g., 100)"
          type="number"
          value={limit}
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
              <strong>Latest Ex-Dividend Date</strong>
              <span>{latestPoint.date}</span>
              <strong>Cash Amount</strong>
              <span>{formatCashAmount(latestPoint.cashAmount)}</span>
              <strong>Pay Date</strong>
              <span>{latestPoint.payDate ?? "--"}</span>
              <strong>Frequency</strong>
              <span>{latestPoint.frequency ?? "--"}</span>
              <strong>Dividend Type</strong>
              <span>{latestPoint.dividendType ?? latestPoint.distributionType ?? "--"}</span>
              <strong>Retrieved</strong>
              <span>{formatTimestamp(result.fetchedAt)}</span>
            </div>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

export default MassiveDividends;
