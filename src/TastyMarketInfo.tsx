import { FormEvent, useEffect, useMemo, useState } from "react";
import outputs from "../amplify_outputs.json";

type TastyMarketInfoResponse = {
  symbol: string;
  data: unknown;
  fetchedAt: string;
};

type QuoteCardData = {
  symbol: string;
  price: number | null;
  bid: number | null;
  ask: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number | null;
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

    if (typeof value === "string") {
      const parsed = Number(value);
      if (!Number.isNaN(parsed)) {
        return parsed;
      }
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

function buildQuoteCardData(result: TastyMarketInfoResponse): QuoteCardData {
  const quoteSource = extractQuoteSource(result.data, result.symbol);

  return {
    symbol: result.symbol,
    price: pickNumber(quoteSource, ["last", "lastPrice", "mark", "close"]),
    bid: pickNumber(quoteSource, ["bid", "bidPrice"]),
    ask: pickNumber(quoteSource, ["ask", "askPrice"]),
    change: pickNumber(quoteSource, ["change", "netChange"]),
    changePercent: pickNumber(quoteSource, ["changePercent", "netPercentChange"]),
    volume: pickNumber(quoteSource, ["volume", "totalVolume", "volumeToday"]),
  };
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

function formatChange(value: number | null, percent: number | null) {
  if (value === null) {
    return "--";
  }

  const sign = value > 0 ? "+" : "";
  const percentText =
    percent === null
      ? ""
      : ` (${sign}${percent.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}%)`;

  return `${sign}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}${percentText}`;
}

function formatVolume(value: number | null) {
  if (value === null) {
    return "--";
  }

  return value.toLocaleString();
}

function getChangeColor(value: number | null) {
  if (value === null || value === 0) {
    return "#333";
  }

  return value > 0 ? "#1f7a1f" : "#b42318";
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }

  return date.toLocaleString();
}

function TastyMarketInfo() {
  const [symbol, setSymbol] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState("Checking TastyTrade REST connection...");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<TastyMarketInfoResponse | null>(null);

  const apiBaseUrl = useMemo(() => {
    const configUrl =
      (outputs as { custom?: { tasty_rest?: { api_url?: string } } }).custom?.tasty_rest?.api_url ??
      import.meta.env.VITE_TASTY_API_URL;

    return configUrl?.replace(/\/$/, "") ?? "";
  }, []);

  const statusUrl = apiBaseUrl ? `${apiBaseUrl}/tasty-rest/status` : "";

  async function parseApiResponse(response: Response) {
    const text = await response.text();

    try {
      return JSON.parse(text) as {
        error?: string;
        details?: unknown;
        symbol?: string;
        data?: unknown;
        connected?: boolean;
        reason?: string;
        detail?: string;
      };
    } catch {
      return {
        error: text || `Request failed with status ${response.status}.`,
      };
    }
  }

  function waitForPopupResult(popup: Window) {
    return new Promise<boolean>((resolve) => {
      let finished = false;

      const cleanup = (connected: boolean) => {
        if (finished) {
          return;
        }

        finished = true;
        window.removeEventListener("message", onMessage);
        window.clearInterval(intervalId);
        resolve(connected);
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
          setConnectionStatus("TastyTrade REST connection ready.");
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
    async function checkConnectionStatus() {
      if (!apiBaseUrl || !statusUrl) {
        setConnectionStatus("Tasty REST API URL is not configured.");
        setIsConnecting(false);
        return;
      }

      try {
        const response = await fetch(statusUrl);
        const payload = await parseApiResponse(response);

        if (response.ok && payload.connected === true) {
          setConnectionStatus("TastyTrade REST connection ready.");
          setIsConnecting(false);
          return;
        }

        if (payload.reason === "not_connected") {
          await startOAuthPopupFlow();
          return;
        }

        setConnectionStatus(
          payload.detail
            ? `TastyTrade REST problem: ${payload.detail}`
            : "TastyTrade authorization is required.",
        );
      } catch {
        setConnectionStatus("Unable to verify TastyTrade REST connection.");
      } finally {
        setIsConnecting(false);
      }
    }

    void checkConnectionStatus();
  }, [apiBaseUrl, statusUrl]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedSymbol = symbol.trim().toUpperCase();
    if (!trimmedSymbol) {
      setError("Please enter a ticker symbol.");
      return;
    }

    if (!apiBaseUrl) {
      setError("Tasty REST API URL is not configured in outputs or VITE_TASTY_API_URL.");
      return;
    }

    setError(null);
    setResult(null);
    setIsLoading(true);

    try {
      const response = await fetch(
        `${apiBaseUrl}/tasty-rest/market-info?symbol=${encodeURIComponent(trimmedSymbol)}`,
      );
      const payload = await parseApiResponse(response);

      if (response.status === 401) {
        const connected = await startOAuthPopupFlow();
        if (!connected) {
          throw new Error("TastyTrade sign-in did not complete.");
        }

        const retryResponse = await fetch(
          `${apiBaseUrl}/tasty-rest/market-info?symbol=${encodeURIComponent(trimmedSymbol)}`,
        );
        const retryPayload = await parseApiResponse(retryResponse);
        if (!retryResponse.ok) {
          throw new Error(
            retryPayload.details
              ? `${retryPayload.error ?? "Unable to retrieve market data."} ${typeof retryPayload.details === "string" ? retryPayload.details : JSON.stringify(retryPayload.details)}`
              : (retryPayload.error ?? "Unable to retrieve market data."),
          );
        }

        setResult({
          symbol: retryPayload.symbol ?? trimmedSymbol,
          data: retryPayload.data,
          fetchedAt: new Date().toISOString(),
        });
        return;
      }

      if (!response.ok) {
        throw new Error(
          payload.details
            ? `${payload.error ?? "Unable to retrieve market data."} ${typeof payload.details === "string" ? payload.details : JSON.stringify(payload.details)}`
            : (payload.error ?? "Unable to retrieve market data."),
        );
      }

      setResult({
        symbol: payload.symbol ?? trimmedSymbol,
        data: payload.data,
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

  return (
    <main>
      <a href="/">Back to landing page</a>
      <h1>Tasty Market Info</h1>
      <p>TastyTrade REST market data lookup using the Open API market-data endpoint.</p>
      <p>{connectionStatus}</p>
      <form onSubmit={handleSubmit}>
        <input
          aria-label="Ticker symbol"
          disabled={isConnecting}
          onChange={(event) => setSymbol(event.target.value)}
          placeholder="Ticker (e.g., AAPL)"
          type="text"
          value={symbol}
        />
        <button disabled={isLoading || isConnecting} type="submit">
          {isLoading ? "Loading..." : "Submit"}
        </button>
      </form>
      {error ? <p>{error}</p> : null}
      {result ? (
        <section>
          {(() => {
            const quote = buildQuoteCardData(result);

            return (
              <>
                <h2>{quote.symbol}</h2>
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
                  <strong>Price</strong>
                  <span>{formatPrice(quote.price)}</span>
                  <strong>Bid / Ask</strong>
                  <span>
                    {formatPrice(quote.bid)} / {formatPrice(quote.ask)}
                  </span>
                  <strong>Change</strong>
                  <span style={{ color: getChangeColor(quote.change), fontWeight: 700 }}>
                    {formatChange(quote.change, quote.changePercent)}
                  </span>
                  <strong>Volume</strong>
                  <span>{formatVolume(quote.volume)}</span>
                  <strong>Retrieved</strong>
                  <span>{formatTimestamp(result.fetchedAt)}</span>
                </div>
              </>
            );
          })()}
        </section>
      ) : null}
    </main>
  );
}

export default TastyMarketInfo;
