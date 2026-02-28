import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import outputs from "../amplify_outputs.json";
import { getAuthHeaders } from "./auth";
import { loadLastTicker, saveLastTicker } from "./userPreferences";

type SchwabMarketInfoResponse = {
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
  }

  return null;
}

function buildQuoteCardData(result: SchwabMarketInfoResponse): QuoteCardData {
  const root = asRecord(result.data) ?? {};
  const symbolNode = asRecord(root[result.symbol]);
  const quoteNode = symbolNode ? asRecord(symbolNode.quote) : null;

  const directSource = symbolNode ?? root;
  const quoteSource = quoteNode ?? directSource;

  return {
    symbol: result.symbol,
    price: pickNumber(quoteSource, ["lastPrice", "mark", "closePrice"]),
    bid: pickNumber(quoteSource, ["bidPrice", "bid"]),
    ask: pickNumber(quoteSource, ["askPrice", "ask"]),
    change: pickNumber(quoteSource, ["netChange", "change"]),
    changePercent: pickNumber(quoteSource, ["netPercentChange", "changePercent"]),
    volume: pickNumber(quoteSource, ["totalVolume", "volume"]),
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

function SchwabMarketInfo() {
  const { user } = useAuthenticator((context) => [context.user]);
  const [symbol, setSymbol] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isConnecting, setIsConnecting] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState("Checking Schwab connection...");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SchwabMarketInfoResponse | null>(null);

  const apiBaseUrl = useMemo(() => {
    const configUrl =
      (outputs as { custom?: { schwab?: { api_url?: string } } }).custom?.schwab?.api_url ??
      import.meta.env.VITE_SCHWAB_API_URL;

    return configUrl?.replace(/\/$/, "") ?? "";
  }, []);

  const authorizeUrl = apiBaseUrl ? `${apiBaseUrl}/schwab/authorize` : "";
  const statusUrl = apiBaseUrl ? `${apiBaseUrl}/schwab/status` : "";

  async function connectSchwab() {
    if (!user || !apiBaseUrl) {
      setError("Sign in to use Schwab.");
      return;
    }

    try {
      const response = await fetch(`${apiBaseUrl}/schwab/authorize-url`, {
        headers: await getAuthHeaders(),
      });
      const payload = (await response.json()) as { authorizeUrl?: string; error?: string };
      if (!response.ok || !payload.authorizeUrl) {
        throw new Error(payload.error ?? "Unable to start Schwab OAuth.");
      }

      window.location.assign(payload.authorizeUrl);
    } catch (connectError) {
      setError(
        connectError instanceof Error ? connectError.message : "Unable to start Schwab OAuth.",
      );
    }
  }

  useEffect(() => {
    if (!user) {
      setSymbol("");
      setConnectionStatus("Sign in to use Schwab.");
      setIsConnecting(false);
      return;
    }

    void loadLastTicker("schwab-market-info").then((savedTicker) => {
      if (savedTicker) {
        setSymbol(savedTicker);
      }
    });
  }, [user]);

  useEffect(() => {
    async function checkConnectionStatus() {
      if (!user) {
        return;
      }

      if (!apiBaseUrl || !statusUrl) {
        setConnectionStatus("Schwab API URL is not configured.");
        setIsConnecting(false);
        return;
      }

      try {
        const response = await fetch(statusUrl, {
          headers: await getAuthHeaders(),
        });
        const payload = (await response.json()) as {
          connected?: boolean;
          reason?: string;
          detail?: string;
        };

        if (response.ok && payload.connected === true) {
          setConnectionStatus("Schwab connected.");
        } else {
          setConnectionStatus(
            payload.detail
              ? `Schwab connection problem: ${payload.detail}`
              : "Schwab authorization is required.",
          );
        }
      } catch {
        setConnectionStatus("Unable to verify Schwab connection.");
      } finally {
        setIsConnecting(false);
      }
    }

    void checkConnectionStatus();
  }, [apiBaseUrl, statusUrl, user]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedSymbol = symbol.trim().toUpperCase();
    if (!trimmedSymbol) {
      setError("Please enter a ticker symbol.");
      return;
    }

    if (!apiBaseUrl) {
      setError("Schwab API URL is not configured in outputs or VITE_SCHWAB_API_URL.");
      return;
    }

    if (!user) {
      setError("Sign in to use Schwab.");
      return;
    }

    setError(null);
    setResult(null);
    setIsLoading(true);
    await saveLastTicker("schwab-market-info", trimmedSymbol);

    try {
      const response = await fetch(
        `${apiBaseUrl}/schwab/market-info?symbol=${encodeURIComponent(trimmedSymbol)}`,
        {
          headers: await getAuthHeaders(),
        },
      );
      const payload = (await response.json()) as {
        error?: string;
        symbol?: string;
        data?: unknown;
      };

      if (!response.ok) {
        throw new Error(payload.error ?? "Unable to retrieve market data.");
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
      <h1>Schwab Market Info</h1>
      <p>Connect Schwab and request Level One Equities market data by ticker symbol.</p>
      <p>{connectionStatus}</p>
      {authorizeUrl ? (
        <p>
          <button onClick={connectSchwab} type="button">
            Connect Schwab OAuth
          </button>
        </p>
      ) : null}
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

export default SchwabMarketInfo;
