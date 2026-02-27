import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { Chart } from "chart.js/auto";
import outputs from "../amplify_outputs.json";

type TastyChartResponse = {
  symbol: string;
  data: unknown;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }

  return null;
}

function pickNumber(source: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number") {
      return value;
    }
  }

  return null;
}

function extractQuoteSource(data: unknown, symbol: string) {
  const root = asRecord(data) ?? {};
  const rootData = asRecord(root.data) ?? root;
  const items = Array.isArray(rootData.items) ? rootData.items : null;

  if (items && items.length > 0) {
    const symbolUpper = symbol.toUpperCase();
    for (const item of items) {
      const itemRecord = asRecord(item);
      if (!itemRecord) {
        continue;
      }

      const candidateSymbol =
        (typeof itemRecord.symbol === "string" && itemRecord.symbol) ||
        (typeof itemRecord["streamer-symbol"] === "string" && itemRecord["streamer-symbol"]) ||
        "";

      if (candidateSymbol.toUpperCase() === symbolUpper) {
        return itemRecord;
      }
    }

    const firstItem = asRecord(items[0]);
    if (firstItem) {
      return firstItem;
    }
  }

  const symbolNode = asRecord(rootData[symbol]) ?? asRecord(rootData[symbol.toUpperCase()]);
  if (symbolNode) {
    return symbolNode;
  }

  return rootData;
}

function extractPrice(result: TastyChartResponse) {
  const quoteSource = extractQuoteSource(result.data, result.symbol);
  const last = pickNumber(quoteSource, ["last", "lastPrice", "price"]);
  const bid = pickNumber(quoteSource, ["bid", "bidPrice"]);
  const ask = pickNumber(quoteSource, ["ask", "askPrice"]);

  if (last !== null) {
    return last;
  }

  if (bid !== null && ask !== null) {
    return (bid + ask) / 2;
  }

  return bid ?? ask;
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

function TastyChart() {
  const [symbol, setSymbol] = useState("");
  const [isConnecting, setIsConnecting] = useState(true);
  const [isStreaming, setIsStreaming] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("Checking TastyTrade connection...");
  const [error, setError] = useState<string | null>(null);
  const [latestPrice, setLatestPrice] = useState<number | null>(null);
  const [latestUpdatedAt, setLatestUpdatedAt] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState("");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const chartRef = useRef<Chart<"line"> | null>(null);
  const intervalRef = useRef<number | null>(null);
  const dataRef = useRef<{ times: string[]; prices: number[] }>({
    times: [],
    prices: [],
  });

  const apiBaseUrl = useMemo(() => {
    const configUrl =
      (outputs as { custom?: { tasty?: { api_url?: string } } }).custom?.tasty?.api_url ??
      import.meta.env.VITE_TASTY_API_URL;

    return configUrl?.replace(/\/$/, "") ?? "";
  }, []);

  const statusUrl = apiBaseUrl ? `${apiBaseUrl}/tasty/status` : "";

  async function parseApiResponse(response: Response) {
    const text = await response.text();

    try {
      return JSON.parse(text) as {
        error?: string;
        contentType?: string;
        details?: unknown;
        symbol?: string;
        data?: unknown;
      };
    } catch {
      return {
        error: text || `Request failed with status ${response.status}.`,
      };
    }
  }

  function resetSeries() {
    dataRef.current = { times: [], prices: [] };
    setLatestPrice(null);
    setLatestUpdatedAt(null);
    const chart = chartRef.current;
    if (!chart) {
      return;
    }

    chart.data.labels = [];
    chart.data.datasets[0].data = [];
    chart.update();
  }

  function pushPoint(time: number, price: number) {
    const maxPoints = 600;
    const times = dataRef.current.times;
    const prices = dataRef.current.prices;
    times.push(new Date(time).toLocaleTimeString());
    prices.push(price);

    while (times.length > maxPoints) {
      times.shift();
      prices.shift();
    }

    const chart = chartRef.current;
    if (chart) {
      chart.data.labels = [...times];
      chart.data.datasets[0].data = [...prices];
      chart.update("none");
    }
  }

  function waitForPopupResult(popup: Window) {
    return new Promise<boolean>((resolve) => {
      let finished = false;

      const cleanup = (result: boolean) => {
        if (finished) {
          return;
        }

        finished = true;
        window.removeEventListener("message", onMessage);
        window.clearInterval(intervalId);
        resolve(result);
      };

      const onMessage = (event: MessageEvent) => {
        if (event.origin !== window.location.origin) {
          return;
        }

        const data = event.data as {
          source?: string;
          status?: string;
          message?: string;
        };

        if (data?.source !== "tasty-oauth") {
          return;
        }

        if (data.status === "success") {
          setConnectionStatus("TastyTrade connected.");
          cleanup(true);
          return;
        }

        if (data.status === "error") {
          setConnectionStatus(data.message ?? "TastyTrade sign-in failed.");
          cleanup(false);
        }
      };

      const intervalId = window.setInterval(() => {
        if (popup.closed) {
          cleanup(false);
        }
      }, 500);

      window.addEventListener("message", onMessage);
    });
  }

  async function startOAuthPopupFlow() {
    setIsConnecting(true);
    setConnectionStatus("Opening TastyTrade sign-in...");

    const popup = window.open("/tasty-auth-popup", "tasty-auth-popup", "width=540,height=760");
    if (!popup) {
      setConnectionStatus("Popup blocked. Please allow popups and try again.");
      setIsConnecting(false);
      return false;
    }

    popup.focus();
    const connected = await waitForPopupResult(popup);
    setIsConnecting(false);

    if (!connected && popup.closed) {
      setConnectionStatus("TastyTrade sign-in was cancelled or did not complete.");
    }

      return connected;
  }

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
            label: "Price",
            data: [],
            borderColor: "#0f766e",
            backgroundColor: "rgba(15, 118, 110, 0.15)",
            tension: 0.15,
            pointRadius: 0,
            borderWidth: 2,
          },
        ],
      },
      options: {
        animation: false,
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            title: {
              display: true,
              text: "Time",
            },
          },
          y: {
            title: {
              display: true,
              text: "Price",
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
    async function checkConnectionStatus() {
      if (!apiBaseUrl || !statusUrl) {
        setConnectionStatus("Tasty API URL is not configured.");
        setIsConnecting(false);
        return;
      }

      try {
        const response = await fetch(statusUrl);
        const payload = (await response.json()) as {
          connected?: boolean;
          reason?: string;
          detail?: string;
        };

        if (!response.ok || payload.connected !== true) {
          if (
            payload.reason === "missing_client_id" ||
            payload.reason === "missing_client_secret" ||
            payload.reason === "missing_session_secret"
          ) {
            setConnectionStatus(
              payload.detail
                ? `TastyTrade connection problem: ${payload.reason} - ${payload.detail}`
                : "TastyTrade OAuth configuration is incomplete in SSM.",
            );
            setIsConnecting(false);
            return;
          }

          await startOAuthPopupFlow();
          return;
        }
      } catch {
        setConnectionStatus("Unable to verify TastyTrade connection.");
        setIsConnecting(false);
        return;
      }

      setConnectionStatus("TastyTrade connected.");
      setIsConnecting(false);
    }

    void checkConnectionStatus();
  }, [apiBaseUrl, statusUrl]);

  useEffect(() => {
    return () => {
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
      }
    };
  }, []);

  async function fetchQuote(trimmedSymbol: string) {
    try {
      const response = await fetch(
        `${apiBaseUrl}/tasty/market-info?symbol=${encodeURIComponent(trimmedSymbol)}`,
      );
      const payload = await parseApiResponse(response);

      if (response.status === 401) {
        throw new Error(
          payload.details
            ? `${payload.error ?? "Unauthorized"} ${typeof payload.details === "string" ? payload.details : JSON.stringify(payload.details)}`
            : (payload.error ?? "Unauthorized"),
        );
      }

      if (!response.ok) {
        throw new Error(
          payload.details
            ? `${payload.error ?? "Unable to retrieve market data."} ${typeof payload.details === "string" ? payload.details : JSON.stringify(payload.details)}`
            : (payload.error ?? "Unable to retrieve market data."),
        );
      }

      const result: TastyChartResponse = {
        symbol: payload.symbol ?? trimmedSymbol,
        data: payload.data,
      };
      const price = extractPrice(result);

      if (price === null) {
        throw new Error("No usable price was found in the TastyTrade quote.");
      }

      const now = new Date().toISOString();
      pushPoint(Date.now(), price);
      setLatestPrice(price);
      setLatestUpdatedAt(now);
      setStreamStatus(`Streaming ${result.symbol} (latest: ${formatPrice(price)})`);
      return true;
    } catch (submitError) {
      const message =
        submitError instanceof Error ? submitError.message : "An unknown error occurred.";
      setError(message);
      setStreamStatus("Stream error or disconnected.");
      setIsStreaming(false);
      if (intervalRef.current !== null) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return false;
    }
  }

  async function startStreaming(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedSymbol = symbol.trim().toUpperCase();
    if (!trimmedSymbol) {
      setError("Please enter a ticker symbol.");
      return;
    }

    if (!apiBaseUrl) {
      setError("Tasty API URL is not configured in outputs or VITE_TASTY_API_URL.");
      return;
    }

    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    resetSeries();
    setError(null);
    setIsStreaming(true);
    setStreamStatus(`Connecting stream for ${trimmedSymbol}...`);

    const firstFetchSucceeded = await fetchQuote(trimmedSymbol);
    if (!firstFetchSucceeded) {
      return;
    }

    intervalRef.current = window.setInterval(() => {
      void fetchQuote(trimmedSymbol);
    }, 3000);
  }

  function stopStreaming() {
    if (intervalRef.current !== null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    setIsStreaming(false);
    setStreamStatus("Stopped.");
  }

  return (
    <main>
      <a href="/">Back to landing page</a>
      <h1>Tasty Chart</h1>
      <p>Connect TastyTrade and chart a ticker over time as quotes arrive.</p>
      <p>{connectionStatus}</p>
      <form onSubmit={startStreaming}>
        <input
          aria-label="Ticker symbol"
          disabled={isConnecting || isStreaming}
          onChange={(event) => setSymbol(event.target.value)}
          placeholder="Ticker (e.g., AAPL)"
          type="text"
          value={symbol}
        />
        {!isStreaming ? (
          <button disabled={isConnecting} type="submit">
            Submit
          </button>
        ) : (
          <button onClick={stopStreaming} type="button">
            Stop
          </button>
        )}
      </form>
      {streamStatus ? <p>{streamStatus}</p> : null}
      {error ? <p>{error}</p> : null}
      <section
        style={{
          marginTop: "16px",
          height: "320px",
          border: "1px solid #222",
          borderRadius: "10px",
          background: "white",
          padding: "12px",
        }}
      >
        <canvas ref={canvasRef} />
      </section>
      <p style={{ marginTop: "12px" }}>
        Latest price: {formatPrice(latestPrice)}
        {latestUpdatedAt ? ` | Retrieved: ${formatTimestamp(latestUpdatedAt)}` : ""}
      </p>
    </main>
  );
}

export default TastyChart;
