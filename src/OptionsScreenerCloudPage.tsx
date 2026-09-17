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
  const [settings, setSettings] = useState<ScreenerSettings | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void loadOptionsScreenerSettings().then((saved) => {
      if (!cancelled) setSettings(saved);
    }).catch((error: unknown) => {
      if (!cancelled) {
        setError(`Could not load saved screener preferences: ${String(error)}. Using defaults.`);
        setSettings(DEFAULT_SCREENER_SETTINGS);
      }
    });
    return () => { cancelled = true; };
  }, []);
  if (settings === null) return <main className="skew-page"><p role="status">Loading your screener preferences…</p></main>;
  return <>{error && <p className="skew-error" role="alert">{error}</p>}
    <OptionsScreenerPage defaultTickers={[]} request={request} initialSettings={settings} loadExplorerTickers={listOptionsAprHistoryTickers}
      onSettingsChange={(next) => saveOptionsScreenerSettings(next, userId)} /></>;
}

export default function OptionsScreenerCloudPage() {
  const { user } = useAuthenticator((context) => [context.user]);
  if (!user || !apiUrl) return <main className="skew-page"><a href="/">Home</a><h1>Options APR Screener</h1><p>{!user ? "Sign in using the menu above to load your tickers and run the screener." : "Deploy the Yahoo options API and regenerate amplify_outputs.json to use the screener."}</p></main>;
  return <UserScreener key={user.userId} userId={user.userId} />;
}
