import { useEffect, useState } from "react";
import { useAuthenticator } from "@aws-amplify/ui-react";
import outputs from "../amplify_outputs.json";
import { getAuthHeaders } from "./auth";
import { listOptionsAprHistoryTickers } from "./optionsAprHistory";
import { createScreenerRequest } from "./optionsScreener";
import OptionsScreenerPage from "./OptionsScreenerPage";
import { DEFAULT_SCREENER_SETTINGS, type ScreenerSettings } from "./optionsScreenerSettings";
import { loadOptionsScreenerSettings, saveOptionsScreenerSettings } from "./userPreferences";

const custom = outputs.custom as { yahoo_options_skew?: { api_url?: string }; schwab?: { api_url?: string } };
const apiUrl = custom.yahoo_options_skew?.api_url ?? custom.schwab?.api_url ?? "";
const request = createScreenerRequest(apiUrl, getAuthHeaders);

function UserScreener({ userId }: { userId: string }) {
  const [tickers, setTickers] = useState<string[] | null>(null);
  const [settings, setSettings] = useState<ScreenerSettings>(DEFAULT_SCREENER_SETTINGS);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void Promise.allSettled([listOptionsAprHistoryTickers(), loadOptionsScreenerSettings()]).then(([tickerResult, settingsResult]) => {
      if (cancelled) return;
      const failures: string[] = [];
      if (tickerResult.status === "rejected") failures.push(`Could not load default tickers: ${String(tickerResult.reason)}. Add tickers manually.`);
      if (settingsResult.status === "rejected") failures.push(`Could not load saved Run settings: ${String(settingsResult.reason)}. Using defaults.`);
      setError(failures.join(" "));
      setSettings(settingsResult.status === "fulfilled" ? settingsResult.value : DEFAULT_SCREENER_SETTINGS);
      setTickers(tickerResult.status === "fulfilled" ? tickerResult.value : []);
    });
    return () => { cancelled = true; };
  }, []);
  if (tickers === null) return <main className="skew-page"><p role="status">Loading your APR Explorer tickers…</p></main>;
  return <>{error && <p className="skew-error" role="alert">{error}</p>}
    <OptionsScreenerPage defaultTickers={tickers} request={request} initialSettings={settings}
      onSettingsChange={(next) => saveOptionsScreenerSettings(next, userId)} /></>;
}

export default function OptionsScreenerCloudPage() {
  const { user } = useAuthenticator((context) => [context.user]);
  if (!user || !apiUrl) return <main className="skew-page"><a href="/">Home</a><h1>Options APR Screener</h1><p>{!user ? "Sign in using the menu above to load your tickers and run the screener." : "Deploy the Yahoo options API and regenerate amplify_outputs.json to use the screener."}</p></main>;
  return <UserScreener key={user.userId} userId={user.userId} />;
}
