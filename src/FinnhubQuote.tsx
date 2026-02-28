import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import outputs from "../amplify_outputs.json";
import { getAuthHeaders } from "./auth";
import { loadLastTicker, saveLastTicker } from "./userPreferences";

type FinnhubQuoteResponse = {
  symbol: string;
  data: {
    c: number;
    d: number;
    dp: number;
    h: number;
    l: number;
    o: number;
    pc: number;
    t?: number;
  };
  fetchedAt: string;
};

function formatPrice(value: number) {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPercent(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

function formatChange(value: number) {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function getChangeColor(value: number) {
  if (value === 0) {
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

function FinnhubQuote() {
  const { user } = useAuthenticator((context) => [context.user]);
  const [symbol, setSymbol] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  const [connectionStatus, setConnectionStatus] = useState("Checking Finnhub configuration...");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<FinnhubQuoteResponse | null>(null);

  const apiBaseUrl = useMemo(() => {
    const configUrl =
      (outputs as { custom?: { finnhub?: { api_url?: string } } }).custom?.finnhub?.api_url ??
      import.meta.env.VITE_FINNHUB_API_URL;

    return configUrl?.replace(/\/$/, "") ?? "";
  }, []);

  const statusUrl = apiBaseUrl ? `${apiBaseUrl}/finnhub/status` : "";

  useEffect(() => {
    if (!user) {
      setSymbol("");
      setConnectionStatus("Sign in to use Finnhub.");
      setIsCheckingStatus(false);
      return;
    }

    void loadLastTicker("finnhub-quote").then((savedTicker) => {
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
        setConnectionStatus("Finnhub API URL is not configured.");
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
          setConnectionStatus("Finnhub ready.");
        } else {
          setConnectionStatus(payload.detail ?? payload.error ?? "Finnhub is not configured.");
        }
      } catch {
        setConnectionStatus("Unable to verify Finnhub configuration.");
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
      setError("Finnhub API URL is not configured in outputs or VITE_FINNHUB_API_URL.");
      return;
    }

    if (!user) {
      setError("Sign in to use Finnhub.");
      return;
    }

    setError(null);
    setResult(null);
    setIsLoading(true);
    await saveLastTicker("finnhub-quote", trimmedSymbol);

    try {
      const response = await fetch(
        `${apiBaseUrl}/finnhub/quote?symbol=${encodeURIComponent(trimmedSymbol)}`,
        {
          headers: await getAuthHeaders(),
        },
      );
      const payload = (await response.json()) as {
        error?: string;
        details?: unknown;
        symbol?: string;
        data?: FinnhubQuoteResponse["data"];
      };

      if (!response.ok || !payload.data) {
        throw new Error(
          payload.details
            ? `${payload.error ?? "Unable to retrieve quote."} ${typeof payload.details === "string" ? payload.details : JSON.stringify(payload.details)}`
            : (payload.error ?? "Unable to retrieve quote."),
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
      <h1>Finnhub Quote</h1>
      <p>Request the Finnhub quote endpoint for a ticker symbol.</p>
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
            <strong>Current Price</strong>
            <span>{formatPrice(result.data.c)}</span>
            <strong>Change</strong>
            <span style={{ color: getChangeColor(result.data.d), fontWeight: 700 }}>
              {formatChange(result.data.d)}
            </span>
            <strong>Percent Change</strong>
            <span style={{ color: getChangeColor(result.data.dp), fontWeight: 700 }}>
              {formatPercent(result.data.dp)}
            </span>
            <strong>High Price of Day</strong>
            <span>{formatPrice(result.data.h)}</span>
            <strong>Low Price of Day</strong>
            <span>{formatPrice(result.data.l)}</span>
            <strong>Open Price of Day</strong>
            <span>{formatPrice(result.data.o)}</span>
            <strong>Previous Close Price</strong>
            <span>{formatPrice(result.data.pc)}</span>
            <strong>Retrieved</strong>
            <span>{formatTimestamp(result.fetchedAt)}</span>
          </div>
        </section>
      ) : null}
    </main>
  );
}

export default FinnhubQuote;
