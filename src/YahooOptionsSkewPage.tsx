import { FormEvent, useEffect, useMemo, useState } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import outputs from "../amplify_outputs.json";
import { getAuthHeaders } from "./auth";
import { loadLastTicker, saveLastTicker } from "./userPreferences";

type OptionLegSummary = {
  contractSymbol: string;
  strike: number;
  impliedVolatility: number;
  bid?: number;
  ask?: number;
  lastPrice: number;
  volume?: number;
  openInterest?: number;
};

type PairedSkew = {
  value: number;
  put: OptionLegSummary;
  call: OptionLegSummary;
};

type AverageSkew = {
  value: number;
  putImpliedVolatility: number;
  callImpliedVolatility: number;
  putCount: number;
  callCount: number;
};

type YahooOptionsSkewResponse = {
  symbol: string;
  data: {
    underlyingPrice: number;
    expirationDate: string;
    expirationDates: string[];
    callCount: number;
    putCount: number;
    skew: {
      tenPercentOtm: PairedSkew | null;
      averageOtm: AverageSkew | null;
      atTheMoney: PairedSkew | null;
    };
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

function formatCurrency(value: number) {
  return value.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatIv(value: number) {
  return `${(value * 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

function formatSkew(value: number) {
  const percentagePoints = value * 100;
  const sign = percentagePoints > 0 ? "+" : "";
  return `${sign}${percentagePoints.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} pts`;
}

function getSkewTone(value: number) {
  if (value > 0.02) {
    return "Put IV premium";
  }

  if (value < -0.02) {
    return "Call IV premium";
  }

  return "Balanced";
}

function renderLeg(label: string, leg: OptionLegSummary) {
  return (
    <div className="skew-leg">
      <span>{label}</span>
      <strong>{formatCurrency(leg.strike)}</strong>
      <small>
        IV {formatIv(leg.impliedVolatility)} · bid/ask{" "}
        {leg.bid === undefined ? "--" : formatCurrency(leg.bid)} /{" "}
        {leg.ask === undefined ? "--" : formatCurrency(leg.ask)}
      </small>
    </div>
  );
}

function YahooOptionsSkewPage() {
  const { user } = useAuthenticator((context) => [context.user]);
  const [symbol, setSymbol] = useState("");
  const [expiration, setExpiration] = useState("");
  const [connectionStatus, setConnectionStatus] = useState("Checking Yahoo Finance access...");
  const [isCheckingStatus, setIsCheckingStatus] = useState(true);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<YahooOptionsSkewResponse | null>(null);

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
  }, [apiBaseUrl, statusUrl, user]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedSymbol = symbol.trim().toUpperCase();
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

    try {
      const searchParams = new URLSearchParams({ symbol: trimmedSymbol });
      if (expiration) {
        searchParams.set("expiration", expiration);
      }

      const response = await fetch(`${apiBaseUrl}/yahoo-options-skew/skew?${searchParams}`, {
        headers: await getAuthHeaders(),
      });
      const payload = (await response.json()) as YahooOptionsSkewResponse & {
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
      setExpiration(payload.data.expirationDate);
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

  const primarySkew = result?.data.skew.tenPercentOtm ?? null;

  return (
    <main className="skew-page">
      <a href="/">Back to landing page</a>
      <section className="skew-hero">
        <div>
          <p className="skew-kicker">Yahoo Finance Options</p>
          <h1>Stock Skew</h1>
          <p className="skew-intro">
            Calculate put IV minus call IV from the option chain for a ticker symbol.
          </p>
        </div>
        <form className="skew-form" onSubmit={handleSubmit}>
          <input
            aria-label="Ticker symbol"
            disabled={isCheckingStatus}
            onChange={(event) => setSymbol(event.target.value)}
            placeholder="Ticker (e.g., SPY)"
            type="text"
            value={symbol}
          />
          <select
            aria-label="Expiration date"
            disabled={isCheckingStatus || !result}
            onChange={(event) => setExpiration(event.target.value)}
            value={expiration}
          >
            <option value="">Nearest expiration</option>
            {result?.data.expirationDates.map((expirationDate) => (
              <option key={expirationDate} value={expirationDate}>
                {expirationDate}
              </option>
            ))}
          </select>
          <button disabled={isLoading || isCheckingStatus} type="submit">
            {isLoading ? "Calculating..." : "Calculate"}
          </button>
        </form>
      </section>
      <p className="skew-status">{connectionStatus}</p>
      {error ? <p className="skew-error">{error}</p> : null}
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
              <span>Expiration</span>
              <strong>{result.data.expirationDate}</strong>
            </article>
            <article>
              <span>Contracts</span>
              <strong>
                {result.data.putCount} puts / {result.data.callCount} calls
              </strong>
            </article>
          </section>
          <section className="skew-panel">
            <div className="skew-panel-header">
              <div>
                <h2>10% OTM Skew</h2>
                <p>Nearest 90% strike put IV minus nearest 110% strike call IV.</p>
              </div>
              {primarySkew ? (
                <div className="skew-value">
                  <strong>{formatSkew(primarySkew.value)}</strong>
                  <span>{getSkewTone(primarySkew.value)}</span>
                </div>
              ) : null}
            </div>
            {primarySkew ? (
              <div className="skew-leg-grid">
                {renderLeg("Put leg", primarySkew.put)}
                {renderLeg("Call leg", primarySkew.call)}
              </div>
            ) : (
              <p className="skew-empty">Not enough OTM option data for this expiration.</p>
            )}
          </section>
          <section className="skew-detail-grid">
            <article className="skew-panel">
              <h2>Average OTM Skew</h2>
              {result.data.skew.averageOtm ? (
                <>
                  <strong>{formatSkew(result.data.skew.averageOtm.value)}</strong>
                  <p>
                    Put IV {formatIv(result.data.skew.averageOtm.putImpliedVolatility)} from{" "}
                    {result.data.skew.averageOtm.putCount} contracts.
                  </p>
                  <p>
                    Call IV {formatIv(result.data.skew.averageOtm.callImpliedVolatility)} from{" "}
                    {result.data.skew.averageOtm.callCount} contracts.
                  </p>
                </>
              ) : (
                <p className="skew-empty">Not enough OTM contracts to average.</p>
              )}
            </article>
            <article className="skew-panel">
              <h2>ATM Put-Call Skew</h2>
              {result.data.skew.atTheMoney ? (
                <>
                  <strong>{formatSkew(result.data.skew.atTheMoney.value)}</strong>
                  <div className="skew-leg-grid skew-leg-grid-compact">
                    {renderLeg("Put leg", result.data.skew.atTheMoney.put)}
                    {renderLeg("Call leg", result.data.skew.atTheMoney.call)}
                  </div>
                </>
              ) : (
                <p className="skew-empty">Not enough ATM option data.</p>
              )}
            </article>
          </section>
        </>
      ) : null}
    </main>
  );
}

export default YahooOptionsSkewPage;
